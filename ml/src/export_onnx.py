"""Exportación del modelo temporal a ONNX + verificación de paridad numérica.

"Paridad" acá significa: correr el MISMO input por el modelo de PyTorch
(fuente de verdad) y por el grafo ONNX exportado (lo que de verdad correría
en el navegador vía ONNX Runtime Web) y confirmar que las salidas coinciden
dentro de una tolerancia numérica pequeña. Sin esto, "se exportó sin error"
no prueba nada — un grafo exportado puede ejecutar sin lanzar excepciones y
aun así calcular algo distinto al modelo original (p.ej. por cómo se traza
una máscara booleana, o por una capa que no se comporta igual en modo eval
trazado). Este chequeo es justamente lo que evita ese falso positivo.
"""
from __future__ import annotations

import io

import numpy as np
import onnxruntime as ort
import torch


OPSET_VERSION = 17  # soportado por ONNX Runtime Web >= 1.17; ver docs del pipeline.


def export_to_onnx(model: torch.nn.Module, example_inputs: tuple, path: str) -> None:
    model.eval()
    mouse_x, mouse_mask, key_x, key_mask = example_inputs
    torch.onnx.export(
        model,
        (mouse_x, mouse_mask, key_x, key_mask),
        path,
        input_names=["mouse_x", "mouse_mask", "key_x", "key_mask"],
        output_names=["risk_logit"],
        dynamic_axes={
            "mouse_x": {0: "batch"}, "mouse_mask": {0: "batch"},
            "key_x": {0: "batch"}, "key_mask": {0: "batch"},
            "risk_logit": {0: "batch"},
        },
        opset_version=OPSET_VERSION,
        do_constant_folding=True,
        # El exportador "dynamo" (default en Torch >= 2.6) apunta a opset 18
        # y, al intentar bajar la versión a 17 para pedirle a onnxscript la
        # conversión automática, revienta con un adaptador faltante para
        # Pad (usado por el padding causal de la TCN) — un bug/limitación
        # conocida de la conversión de versión de onnxscript, no de este
        # modelo. El exportador clásico basado en TorchScript (dynamo=False)
        # no tiene ese problema y produce un grafo ONNX estándar equivalente
        # para esta arquitectura (sin control de flujo dependiente del
        # valor de los tensores — solo torch.where/one_hot, que sí
        # soporta bien).
        dynamo=False,
    )


def run_onnx(path: str, example_inputs: tuple) -> np.ndarray:
    mouse_x, mouse_mask, key_x, key_mask = example_inputs
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    feed = {
        "mouse_x": mouse_x.numpy().astype(np.float32),
        "mouse_mask": mouse_mask.numpy().astype(bool),
        "key_x": key_x.numpy().astype(np.float32),
        "key_mask": key_mask.numpy().astype(bool),
    }
    (out,) = session.run(["risk_logit"], feed)
    return out


def export_and_verify(model: torch.nn.Module, example_inputs: tuple, path: str,
                       atol: float = 1e-4) -> dict:
    """Exporta y compara PyTorch vs ONNX Runtime sobre el MISMO input.
    Devuelve {"ok": bool, "max_abs_diff": float, "pytorch_output": [...],
    "onnx_output": [...]}."""
    model.eval()
    with torch.no_grad():
        torch_out = model(*example_inputs).numpy()

    export_to_onnx(model, example_inputs, path)
    onnx_out = run_onnx(path, example_inputs)

    max_abs_diff = float(np.max(np.abs(torch_out - onnx_out)))
    return {
        "ok": max_abs_diff <= atol,
        "max_abs_diff": max_abs_diff,
        "pytorch_output": torch_out.tolist(),
        "onnx_output": onnx_out.tolist(),
    }
