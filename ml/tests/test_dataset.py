import json
import os

import numpy as np

from src.dataset import (
    load_export, group_by_session, build_feature_table, build_sequences,
    synthetic_labels, FEATURE_COLUMNS,
)

REAL_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "behavior_events_real.json")


def test_load_real_export_has_expected_shape():
    rows = load_export(REAL_DATA)
    assert len(rows) == 2418
    required = {"session_id", "participant_campaign_id", "phase", "role",
                "group_assignment", "team_label", "attack_vector", "is_attack",
                "t_ms", "event_type", "x", "y", "key_code"}
    assert required.issubset(rows[0].keys())


def test_group_by_session_sorted_by_time():
    rows = load_export(REAL_DATA)
    sessions = group_by_session(rows)
    assert len(sessions) == 44
    for sid, evs in sessions.items():
        ts = [e["t_ms"] for e in evs]
        assert ts == sorted(ts), f"sesión {sid} no está ordenada por t_ms"


def test_feature_table_one_row_per_session_no_nan_on_real_data():
    rows = load_export(REAL_DATA)
    df = build_feature_table(rows)
    assert len(df) == 44
    for col in FEATURE_COLUMNS:
        assert col in df.columns, f"falta columna {col}"
        assert df[col].notna().all(), f"NaN inesperado en {col} (debería ser 0.0, no NaN, para sesiones sin esa señal)"


def test_build_sequences_shapes_and_masks():
    rows = load_export(REAL_DATA)
    session_ids, mouse_arr, mouse_mask, key_arr, key_mask, metas = build_sequences(rows, max_mouse_len=64, max_key_len=32)
    n = len(session_ids)
    assert n == 44
    assert mouse_arr.shape == (n, 64, 3)
    assert mouse_mask.shape == (n, 64)
    assert key_arr.shape == (n, 32, 2)
    assert key_mask.shape == (n, 32)
    # Toda sesión real tiene >=2 mousemove (verificado contra la base) -> al
    # menos una posición válida de mouse.
    assert (mouse_mask.sum(axis=1) > 0).all()
    # La mayoría de sesiones NO tienen teclas (solo 7 de 44 en los datos
    # reales) -> debe haber filas de key_mask completamente en False, y eso
    # no debe romper nada (se valida más a fondo en test_temporal_model.py).
    assert (key_mask.sum(axis=1) == 0).any()
    # Padding: donde mask es False, el valor debe quedar en cero.
    assert np.all(mouse_arr[~mouse_mask] == 0)
    assert np.all(key_arr[~key_mask] == 0)


def test_build_sequences_truncates_long_sequences_without_crashing():
    rows = load_export(REAL_DATA)
    _, mouse_arr, mouse_mask, _, _, _ = build_sequences(rows, max_mouse_len=5, max_key_len=32)
    assert mouse_arr.shape[1] == 5
    assert mouse_mask.sum(axis=1).max() <= 5


def test_feature_table_and_sequences_agree_on_session_order():
    # Encontrado durante la revisión /engineering:debug del pipeline: evaluate.py
    # re-alinea explícitamente las etiquetas con
    # `df.set_index("session_id").loc[session_ids].reset_index()` antes de
    # entrenar el modelo temporal, precisamente para no depender de que este
    # orden coincida. Este test confirma que, dado que ambas funciones agrupan
    # la MISMA lista `rows` con el mismo `group_by_session`, el orden YA
    # coincide de por sí (Python preserva el orden de inserción en dict) --
    # la re-alineación es una salvaguarda barata, no un fix de un bug real.
    # Si algún cambio futuro a `group_by_session`/`build_feature_table`/
    # `build_sequences` rompiera este supuesto, este test lo detectaría antes
    # de que se traduzca en una desalineación silenciosa etiqueta<->secuencia.
    rows = load_export(REAL_DATA)
    df = build_feature_table(rows)
    session_ids, *_ = build_sequences(rows)
    assert list(df["session_id"]) == list(session_ids), (
        "el orden de sesiones de build_feature_table() y build_sequences() debe "
        "coincidir para que la re-alineación por .loc en evaluate.py sea una "
        "identidad y no oculte un desalineamiento"
    )
    assert not df["session_id"].duplicated().any()
    assert set(session_ids) == set(df["session_id"])


def test_synthetic_labels_deterministic_and_documented_as_synthetic():
    rows = load_export(REAL_DATA)
    df = build_feature_table(rows)
    y1 = synthetic_labels(df, seed=7)
    y2 = synthetic_labels(df, seed=7)
    assert np.array_equal(y1, y2), "misma semilla debe dar exactamente las mismas etiquetas"
    y3 = synthetic_labels(df, seed=8)
    assert not np.array_equal(y1, y3), "semillas distintas no deberían coincidir siempre"
    assert set(np.unique(y1)).issubset({0, 1})
    # Aproximadamente balanceado (se umbraliza en la mediana a propósito).
    assert 0.3 <= y1.mean() <= 0.7
