"""Arquitectura temporal (TG §8.2.4, segunda mitad) — versión actualizada.

Reemplaza el plan original (TCN para la rama de mouse + BiLSTM/GRU para la
rama de teclado, fusionadas por concatenación) por:

  - Rama de mouse: TCN (igual que antes — sigue siendo una elección sólida
    y ya no es recurrente, así que no tenía el problema que motivó este
    cambio).
  - Rama de teclado: un Transformer compacto (2 capas, 4 cabezas) en vez de
    BiLSTM/GRU.
  - Fusión: un mecanismo de atención de 2 tokens (mouse, teclado) en vez de
    concatenar los embeddings tal cual.

Por qué (justificación completa y citada en
docs/2026-09-06_pipeline-ml-offline.md):
  1. La literatura de 2024-2025 sobre dinámica de teclado ya usa arquitecturas
     basadas en atención como enfoque más reciente (TypeFormer, BehaveFormer)
     — BiLSTM/GRU no aparecen ya como el estado del arte en esas revisiones.
  2. Motivo de despliegue, no solo de moda: este modelo se exporta a ONNX
     para correr en el navegador del participante (ONNX Runtime Web). La
     tabla de operadores soportados por el backend rápido (WebGPU) de ONNX
     Runtime Web NO incluye LSTM/GRU — solo el backend WASM (CPU, más
     lento) los soporta. Las operaciones de atención (MatMul, Softmax,
     LayerNorm) sí están en la tabla de WebGPU. Es decir: con BiLSTM/GRU,
     este modelo quedaría forzado al backend más lento en producción; con
     Transformer, no.
  3. Sin estado recurrente que gestionar entre pasos de tiempo, la
     exportación a ONNX es un forward pass sin bucles con estado oculto —
     más simple y menos propensa a bugs de exportación.

Todo el módulo usa solo tensores (nada de Python `if` sobre valores de
tensores) para que `torch.onnx.export` (basado en trazado) produzca un grafo
válido para cualquier entrada del mismo shape, no solo la usada al exportar.
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def _ensure_valid_mask(mask: torch.Tensor) -> torch.Tensor:
    """Garantiza al menos una posición válida (True) por fila.

    Sin esto, una sesión sin ningún evento de teclado (mask todo False —
    el caso más común en los datos reales: solo 7 de 44 sesiones capturadas
    tienen alguna tecla) produciría un softmax sobre puntajes todos
    enmascarados a -inf -> división 0/0 -> NaN. La fila de respaldo apunta
    a la posición 0 (que para una secuencia vacía es simplemente el
    relleno de ceros), dando una salida determinista y sin NaN: "no hay
    señal de teclado" en vez de un error.
    """
    # Nota de exportación: se evita a propósito `torch.where` sobre tensores
    # booleanos -- el ONNX exportado por Torch termina emitiendo un nodo
    # `Where` cuyo kernel booleano no está implementado en la versión de
    # ONNX Runtime usada para verificar la paridad (falla con
    # "Could not find an implementation for Where(16)"). Se logra el mismo
    # resultado con aritmética en punto flotante + comparación (`Mul`,
    # `Add`, `Greater` -- todos con soporte sólido y consistente entre
    # backends de ONNX Runtime, incluido WebGPU).
    T = mask.shape[1]
    mask_f = mask.float()
    has_valid_f = (mask_f.sum(dim=1, keepdim=True) > 0).float()  # [B,1]
    idx0 = torch.zeros(mask.shape[0], dtype=torch.long, device=mask.device)
    fallback_f = F.one_hot(idx0, num_classes=T).float()  # [B,T]
    fixed_f = has_valid_f * mask_f + (1.0 - has_valid_f) * fallback_f
    return fixed_f > 0.5


class AttentionPool(nn.Module):
    """Reduce una secuencia [B,T,D] a un solo vector [B,D] con un peso de
    atención aprendido por posición, respetando la máscara de padding."""

    def __init__(self, dim: int):
        super().__init__()
        self.score = nn.Linear(dim, 1)

    def forward(self, h: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        mask = _ensure_valid_mask(mask)
        scores = self.score(h).squeeze(-1)  # [B,T]
        scores = scores.masked_fill(~mask, -1e9)
        weights = torch.softmax(scores, dim=1).unsqueeze(-1)  # [B,T,1]
        return (h * weights).sum(dim=1)


class _CausalConv1d(nn.Module):
    """Convolución causal: el padding va solo a la izquierda, así la salida
    en el instante t nunca depende de muestras futuras (t' > t)."""

    def __init__(self, in_ch: int, out_ch: int, kernel_size: int, dilation: int):
        super().__init__()
        self.left_pad = (kernel_size - 1) * dilation
        self.conv = nn.Conv1d(in_ch, out_ch, kernel_size, dilation=dilation)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.pad(x, (self.left_pad, 0))
        return self.conv(x)


class _TCNBlock(nn.Module):
    """Bloque residual de la TCN (Bai et al. 2018): dos convoluciones
    causales dilatadas + conexión residual. Sin BatchNorm a propósito —
    con lotes tan chicos como los de este piloto (potencialmente batch=1),
    BatchNorm1d revienta o se vuelve inestable; dropout + residual bastan."""

    def __init__(self, in_ch: int, out_ch: int, kernel_size: int, dilation: int, dropout: float = 0.1):
        super().__init__()
        self.conv1 = _CausalConv1d(in_ch, out_ch, kernel_size, dilation)
        self.conv2 = _CausalConv1d(out_ch, out_ch, kernel_size, dilation)
        self.drop = nn.Dropout(dropout)
        self.act = nn.ReLU()
        self.downsample = nn.Conv1d(in_ch, out_ch, 1) if in_ch != out_ch else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.downsample(x)
        out = self.drop(self.act(self.conv1(x)))
        out = self.drop(self.act(self.conv2(out)))
        return self.act(out + residual)


class MouseTCNBranch(nn.Module):
    def __init__(self, in_channels: int = 3, channels=(16, 32, 32), kernel_size: int = 3):
        super().__init__()
        blocks = []
        c_in = in_channels
        for i, c_out in enumerate(channels):
            blocks.append(_TCNBlock(c_in, c_out, kernel_size, dilation=2 ** i))
            c_in = c_out
        self.tcn = nn.Sequential(*blocks)
        self.pool = AttentionPool(c_in)
        self.out_dim = c_in

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        # x: [B,T,3] (dt, dx, dy) -> Conv1d espera [B,C,T]
        h = self.tcn(x.transpose(1, 2)).transpose(1, 2)  # [B,T,C]
        return self.pool(h, mask)


class _PositionalEncoding(nn.Module):
    def __init__(self, d_model: int, max_len: int):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len).unsqueeze(1).float()
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term[: pe[:, 1::2].shape[1]])
        self.register_buffer("pe", pe.unsqueeze(0))  # [1, max_len, d_model]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.pe[:, : x.size(1)]


class KeyTransformerBranch(nn.Module):
    """Reemplaza a BiLSTM/GRU: un encoder Transformer compacto sobre la
    secuencia (dwell, flight) por tecla. Sin recurrencia -> nada de estado
    oculto que propagar paso a paso, lo que simplifica la exportación ONNX
    y evita depender de operadores LSTM/GRU sin soporte en el backend
    WebGPU de ONNX Runtime Web (ver docstring del módulo)."""

    def __init__(self, in_dim: int = 2, d_model: int = 32, nhead: int = 4,
                 num_layers: int = 2, dim_feedforward: int = 64, max_len: int = 32, dropout: float = 0.1):
        super().__init__()
        self.proj = nn.Linear(in_dim, d_model)
        self.pos = _PositionalEncoding(d_model, max_len)
        layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=nhead, dim_feedforward=dim_feedforward,
            dropout=dropout, batch_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=num_layers)
        self.pool = AttentionPool(d_model)
        self.out_dim = d_model

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        valid_mask = _ensure_valid_mask(mask)
        h = self.pos(self.proj(x))
        h = self.encoder(h, src_key_padding_mask=~valid_mask)
        return self.pool(h, valid_mask)


class AttentionFusion(nn.Module):
    """Fusión por atención entre los dos embeddings de rama (mouse, teclado)
    -- reemplaza la concatenación simple: en vez de darle a las dos ramas el
    mismo peso fijo aunque una traiga mucha menos señal (p.ej. una sesión
    sin ninguna tecla), el modelo aprende cuánto pesar cada una."""

    def __init__(self, dim: int):
        super().__init__()
        self.score = nn.Linear(dim, 1)

    def forward(self, mouse_emb: torch.Tensor, key_emb: torch.Tensor) -> torch.Tensor:
        stacked = torch.stack([mouse_emb, key_emb], dim=1)  # [B,2,D]
        scores = self.score(stacked).squeeze(-1)  # [B,2]
        weights = torch.softmax(scores, dim=1).unsqueeze(-1)
        return (stacked * weights).sum(dim=1)  # [B,D]


class JoltingRiskModel(nn.Module):
    """Modelo completo: rama mouse (TCN) + rama teclado (Transformer) ->
    proyección a dimensión común -> fusión por atención -> clasificador
    binario (logit, sin sigmoid -- se aplica BCEWithLogitsLoss al entrenar).
    """

    def __init__(self, mouse_in: int = 3, key_in: int = 2, fusion_dim: int = 32,
                 max_key_len: int = 32):
        super().__init__()
        self.mouse_branch = MouseTCNBranch(mouse_in, channels=(16, 32, 32))
        self.key_branch = KeyTransformerBranch(key_in, d_model=32, max_len=max_key_len)
        self.mouse_proj = nn.Linear(self.mouse_branch.out_dim, fusion_dim)
        self.key_proj = nn.Linear(self.key_branch.out_dim, fusion_dim)
        self.fusion = AttentionFusion(fusion_dim)
        self.classifier = nn.Sequential(nn.Linear(fusion_dim, 16), nn.ReLU(), nn.Linear(16, 1))

    def forward(self, mouse_x: torch.Tensor, mouse_mask: torch.Tensor,
                key_x: torch.Tensor, key_mask: torch.Tensor) -> torch.Tensor:
        m = self.mouse_proj(self.mouse_branch(mouse_x, mouse_mask))
        k = self.key_proj(self.key_branch(key_x, key_mask))
        fused = self.fusion(m, k)
        return self.classifier(fused).squeeze(-1)  # [B] logits
