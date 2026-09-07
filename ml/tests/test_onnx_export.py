import os
import tempfile

import torch

from src.temporal_model import JoltingRiskModel
from src.export_onnx import export_and_verify


def _example_inputs(batch=2, max_key_len=16, with_keystrokes=True):
    torch.manual_seed(0)
    mouse_x = torch.randn(batch, 64, 3)
    mouse_mask = torch.ones(batch, 64, dtype=torch.bool)
    key_x = torch.randn(batch, max_key_len, 2) if with_keystrokes else torch.zeros(batch, max_key_len, 2)
    key_mask = torch.ones(batch, max_key_len, dtype=torch.bool) if with_keystrokes else torch.zeros(batch, max_key_len, dtype=torch.bool)
    return mouse_x, mouse_mask, key_x, key_mask


def test_export_and_pytorch_onnx_outputs_match_within_tolerance():
    model = JoltingRiskModel(max_key_len=16)
    model.eval()
    inputs = _example_inputs()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "model.onnx")
        result = export_and_verify(model, inputs, path, atol=1e-4)
        assert os.path.exists(path)
        assert result["ok"], f"salida de ONNX difiere de PyTorch más de la tolerancia: {result['max_abs_diff']}"


def test_export_matches_with_all_false_keystroke_mask_the_common_real_case():
    # Este es el caso más frecuente en los datos reales (37 de 44 sesiones
    # no tienen ninguna tecla) -- es el que más fácil rompe con NaN si el
    # fix de _ensure_valid_mask no se propagara también al grafo exportado.
    model = JoltingRiskModel(max_key_len=16)
    model.eval()
    inputs = _example_inputs(with_keystrokes=False)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "model.onnx")
        result = export_and_verify(model, inputs, path, atol=1e-4)
        assert result["ok"], result
        assert all(v == v for v in result["onnx_output"]), "no debe haber NaN en la salida ONNX"


def test_export_works_with_different_batch_size_than_the_one_used_to_trace():
    # El eje de batch se declaró dinámico -- confirma que de verdad lo es,
    # no algo que "funciona por casualidad" con el batch usado al exportar.
    model = JoltingRiskModel(max_key_len=16)
    model.eval()
    trace_inputs = _example_inputs(batch=2)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "model.onnx")
        from src.export_onnx import export_to_onnx, run_onnx
        export_to_onnx(model, trace_inputs, path)

        bigger_inputs = _example_inputs(batch=5)
        with torch.no_grad():
            torch_out = model(*bigger_inputs).numpy()
        onnx_out = run_onnx(path, bigger_inputs)
        import numpy as np
        assert np.max(np.abs(torch_out - onnx_out)) <= 1e-4
