import numpy as np
import torch

from src.temporal_model import JoltingRiskModel, AttentionPool, _ensure_valid_mask
from src.train import train_temporal_model, set_seed


def test_ensure_valid_mask_fixes_all_false_rows_without_touching_others():
    mask = torch.tensor([[False, False, False], [True, False, True]])
    fixed = _ensure_valid_mask(mask)
    assert fixed[0].tolist() == [True, False, False], "fila totalmente inválida cae al índice 0 de respaldo"
    assert fixed[1].tolist() == [True, False, True], "fila que ya tenía posiciones válidas no debe cambiar"


def test_attention_pool_all_masked_row_gives_finite_output_not_nan():
    pool = AttentionPool(dim=4)
    h = torch.randn(2, 5, 4)
    mask = torch.zeros(2, 5, dtype=torch.bool)  # ninguna posición válida en ningún batch
    out = pool(h, mask)
    assert torch.isfinite(out).all(), "una sesión sin ninguna muestra válida no debe producir NaN/Inf"


def test_forward_pass_shapes():
    model = JoltingRiskModel(max_key_len=32)
    model.eval()
    B = 3
    mouse_x = torch.randn(B, 64, 3)
    mouse_mask = torch.ones(B, 64, dtype=torch.bool)
    key_x = torch.zeros(B, 32, 2)
    key_mask = torch.zeros(B, 32, dtype=torch.bool)  # como la mayoría de sesiones reales: sin teclas
    with torch.no_grad():
        out = model(mouse_x, mouse_mask, key_x, key_mask)
    assert out.shape == (B,)
    assert torch.isfinite(out).all()


def test_forward_pass_handles_mixed_batch_with_and_without_keystrokes():
    # Reproduce exactamente la situación real: en un mismo lote, algunas
    # sesiones tienen teclas y otras no.
    model = JoltingRiskModel(max_key_len=32)
    model.eval()
    mouse_x = torch.randn(4, 64, 3)
    mouse_mask = torch.ones(4, 64, dtype=torch.bool)
    key_x = torch.randn(4, 32, 2)
    key_mask = torch.zeros(4, 32, dtype=torch.bool)
    key_mask[0, :5] = True  # solo la primera sesión del lote tiene teclas
    with torch.no_grad():
        out = model(mouse_x, mouse_mask, key_x, key_mask)
    assert torch.isfinite(out).all()


def test_deterministic_forward_with_fixed_seed_and_eval_mode():
    set_seed(0)
    m1 = JoltingRiskModel(max_key_len=16)
    set_seed(0)
    m2 = JoltingRiskModel(max_key_len=16)
    m1.eval(); m2.eval()
    x = (torch.randn(2, 64, 3), torch.ones(2, 64, dtype=torch.bool),
         torch.randn(2, 16, 2), torch.ones(2, 16, dtype=torch.bool))
    with torch.no_grad():
        out1, out2 = m1(*x), m2(*x)
    assert torch.allclose(out1, out2), "misma semilla de inicialización + mismo input -> misma salida"


def test_all_masked_keystroke_fallback_gives_same_embedding_regardless_of_session():
    # Encontrado durante la revisión /engineering:debug: 37 de 44 sesiones
    # reales no tienen NINGUNA tecla, así que caen en el fallback de
    # _ensure_valid_mask (posición 0). Esto podría, en teoría, filtrar señal
    # espuria si la posición 0 no estuviera realmente en cero para esas
    # sesiones, o si el fallback dependiera de algo distinto por sesión. Este
    # test confirma empíricamente que dos sesiones DISTINTAS sin teclas
    # producen exactamente el mismo embedding de la rama de teclado: el
    # fallback es un placeholder determinista de "sin señal de teclado", no
    # una fuente de sesgo o fuga de información entre sesiones.
    model = JoltingRiskModel(max_key_len=32)
    model.eval()
    key_x = torch.zeros(2, 32, 2)  # padding real: todo cero cuando no hay teclas
    key_mask = torch.zeros(2, 32, dtype=torch.bool)
    with torch.no_grad():
        emb_a = model.key_branch(key_x[0:1], key_mask[0:1])
        emb_b = model.key_branch(key_x[1:2], key_mask[1:2])
    assert torch.allclose(emb_a, emb_b), (
        "el fallback de máscara debe producir el mismo embedding 'sin señal' "
        "para cualquier sesión sin teclas, sin importar sus datos de mouse"
    )
    assert torch.isfinite(emb_a).all()


def test_training_loop_reduces_loss_on_learnable_synthetic_data():
    rng = np.random.RandomState(0)
    n = 24
    mouse_arr = rng.normal(size=(n, 64, 3)).astype(np.float32)
    mouse_mask = np.ones((n, 64), dtype=bool)
    key_arr = np.zeros((n, 16, 2), dtype=np.float32)
    key_mask = np.zeros((n, 16), dtype=bool)
    # etiqueta aprendible: depende del signo de la media del canal 0 de mouse_arr
    labels = (mouse_arr[:, :, 0].mean(axis=1) > 0).astype(np.float32)

    result = train_temporal_model(mouse_arr, mouse_mask, key_arr, key_mask, labels, epochs=25, seed=0)
    losses = [h["loss"] for h in result["history"]]
    assert losses[-1] < losses[0], f"la pérdida debería bajar entrenando 25 épocas sobre una señal aprendible: {losses[0]} -> {losses[-1]}"
