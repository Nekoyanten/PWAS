"""Bucle de entrenamiento mínimo para JoltingRiskModel (temporal_model.py).

Deliberadamente simple (Adam + BCEWithLogitsLoss, sin early stopping
sofisticado ni búsqueda de hiperparámetros): el propósito de este workstream,
mientras no hay etiquetas reales, es validar que el pipeline completo
(datos -> features/secuencias -> entrenamiento -> exportación ONNX) funciona
de punta a punta — no producir un modelo listo para producción. Ver
docs/2026-09-06_pipeline-ml-offline.md.
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn

from .temporal_model import JoltingRiskModel


def set_seed(seed: int) -> None:
    torch.manual_seed(seed)
    np.random.seed(seed)


def train_temporal_model(
    mouse_arr: np.ndarray, mouse_mask: np.ndarray,
    key_arr: np.ndarray, key_mask: np.ndarray,
    labels: np.ndarray,
    epochs: int = 30, lr: float = 1e-3, seed: int = 42,
) -> dict:
    set_seed(seed)
    model = JoltingRiskModel(max_key_len=key_arr.shape[1])
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.BCEWithLogitsLoss()

    mouse_x = torch.from_numpy(mouse_arr).float()
    mouse_m = torch.from_numpy(mouse_mask).bool()
    key_x = torch.from_numpy(key_arr).float()
    key_m = torch.from_numpy(key_mask).bool()
    y = torch.from_numpy(labels).float()

    history = []
    model.train()
    for epoch in range(epochs):
        opt.zero_grad()
        logits = model(mouse_x, mouse_m, key_x, key_m)
        loss = loss_fn(logits, y)
        loss.backward()
        opt.step()
        with torch.no_grad():
            pred = (torch.sigmoid(logits) > 0.5).float()
            acc = (pred == y).float().mean().item()
        history.append({"epoch": epoch, "loss": loss.item(), "train_accuracy": acc})

    model.eval()
    return {
        "model": model,
        "history": history,
        "example_inputs": (mouse_x, mouse_m, key_x, key_m),
    }
