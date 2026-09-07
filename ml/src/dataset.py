"""Carga del export crudo de captura conductual y construcción de datasets.

Dos representaciones a partir de la MISMA data cruda, para dos consumidores
distintos del pipeline:

- `build_feature_table()` -> una fila por sesión, features agregadas
  (AUC/SE/MD, latencias, velocidad) -> consumida por los baselines
  (SVM/RF/XGBoost, tabulares por naturaleza).
- `build_sequences()` -> una secuencia (dt,dx,dy) de mouse y una secuencia
  (dwell,flight) de teclado por sesión, con padding/máscara -> consumida por
  el modelo temporal (TCN + Transformer).

`synthetic_labels()` genera una etiqueta binaria SINTÉTICA por sesión, SOLO
para poder correr y validar mecánicamente el entrenamiento y la exportación
ONNX mientras no exista ninguna encuesta post-sesión real (`fell_for_attack`)
— al 6 de septiembre de 2026, la base de producción tiene 44 sesiones con
datos conductuales REALES pero 0 encuestas registradas (el piloto real sigue
bloqueado por el comité de ética). Todo lo que dependa de esta función debe
quedar marcado como "prueba mecánica, no resultado científico" — ver
docs/2026-09-06_pipeline-ml-offline.md, sección de límites.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict

import numpy as np
import pandas as pd

from .features import (
    mouse_trajectory_features,
    keystroke_features,
    mouse_sequence,
    keystroke_sequence,
)


def load_export(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def group_by_session(rows: list[dict]) -> dict[str, list[dict]]:
    sessions: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        sessions[r["session_id"]].append(r)
    for sid in sessions:
        sessions[sid].sort(key=lambda r: r["t_ms"])
    return sessions


def _session_metadata(events: list[dict]) -> dict:
    first = events[0]
    return {
        "phase": first.get("phase"),
        "role": first.get("role"),
        "group_assignment": first.get("group_assignment"),
        "team_label": first.get("team_label"),
        "attack_vector": first.get("attack_vector"),
        "is_attack": bool(first.get("is_attack")),
    }


def build_feature_table(rows: list[dict]) -> pd.DataFrame:
    sessions = group_by_session(rows)
    records = []
    for sid, events in sessions.items():
        meta = _session_metadata(events)
        mouse_f = mouse_trajectory_features(events).to_dict()
        key_f = keystroke_features(events).to_dict()
        rec = {"session_id": sid, **meta}
        rec.update({f"mouse_{k}": v for k, v in mouse_f.items()})
        rec.update({f"key_{k}": v for k, v in key_f.items()})
        records.append(rec)
    return pd.DataFrame.from_records(records)


FEATURE_COLUMNS = [
    "mouse_auc", "mouse_se", "mouse_md", "mouse_path_length",
    "mouse_straight_line_distance", "mouse_efficiency",
    "mouse_mean_velocity", "mouse_std_velocity",
    "mouse_mean_acceleration", "mouse_std_acceleration",
    "key_n_keys", "key_mean_dwell_ms", "key_std_dwell_ms",
    "key_mean_flight_ms", "key_std_flight_ms",
]


def _pad(seq: list[tuple], max_len: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    arr = np.zeros((max_len, width), dtype=np.float32)
    mask = np.zeros((max_len,), dtype=bool)  # True = posición VÁLIDA (no relleno)
    n = min(len(seq), max_len)
    for i in range(n):
        arr[i] = seq[i]
    mask[:n] = True
    return arr, mask


def build_sequences(rows: list[dict], max_mouse_len: int = 64, max_key_len: int = 32):
    """Devuelve (session_ids, mouse_arr[N,max_mouse_len,3], mouse_mask[N,max_mouse_len],
    key_arr[N,max_key_len,2], key_mask[N,max_key_len], meta_list)."""
    sessions = group_by_session(rows)
    session_ids, mouse_arrs, mouse_masks, key_arrs, key_masks, metas = [], [], [], [], [], []
    for sid, events in sessions.items():
        m_seq = mouse_sequence(events)
        k_seq = keystroke_sequence(events)
        m_arr, m_mask = _pad(m_seq, max_mouse_len, 3)
        k_arr, k_mask = _pad(k_seq, max_key_len, 2)
        session_ids.append(sid)
        mouse_arrs.append(m_arr)
        mouse_masks.append(m_mask)
        key_arrs.append(k_arr)
        key_masks.append(k_mask)
        metas.append(_session_metadata(events))
    return (
        session_ids,
        np.stack(mouse_arrs) if mouse_arrs else np.zeros((0, max_mouse_len, 3), dtype=np.float32),
        np.stack(mouse_masks) if mouse_masks else np.zeros((0, max_mouse_len), dtype=bool),
        np.stack(key_arrs) if key_arrs else np.zeros((0, max_key_len, 2), dtype=np.float32),
        np.stack(key_masks) if key_masks else np.zeros((0, max_key_len), dtype=bool),
        metas,
    )


def synthetic_labels(df: pd.DataFrame, seed: int = 42) -> np.ndarray:
    """Etiqueta binaria SINTÉTICA (0/1), determinista dado `seed`, SOLO para
    validar mecánicamente el pipeline de entrenamiento/exportación mientras
    no hay encuestas reales. NO representa ninguna hipótesis real sobre qué
    predice caer en un ataque de phishing.

    Se construye como una combinación lineal de unas pocas features
    normalizadas (para que el "modelo" tenga algo real que aprender a
    predecir, en vez de ruido puro — así las pruebas de sanidad del
    pipeline, como "el AUC-ROC en entrenamiento debe ser mejor que azar",
    tienen sentido) más ruido gaussiano, umbralizada en la mediana para
    quedar balanceada. Determinista: mismo `df` + mismo `seed` -> mismas
    etiquetas siempre.
    """
    rng = np.random.RandomState(seed)
    eff = df["mouse_efficiency"].fillna(1.0).to_numpy()
    vel = df["mouse_mean_velocity"].fillna(0.0).to_numpy()
    vel_n = (vel - vel.mean()) / (vel.std() + 1e-9)
    noise = rng.normal(0, 0.5, size=len(df))
    score = 1.2 * eff + 0.6 * vel_n + noise
    threshold = np.median(score)
    return (score > threshold).astype(np.int64)
