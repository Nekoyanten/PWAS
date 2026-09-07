"""Genera un fixture de paridad Python<->JS para el motor de decisión
(TG §8.2.5, Módulo 5). NO se ejecuta en producción -- es una herramienta de
desarrollo para regenerar `apps/api/tests/fixtures/risk_score_fixture.json`
cada vez que cambie el preprocesamiento (`ml/src/preprocess.py`) o se
reentrene/reexporte el modelo (`ml/reports/jolting_risk_model.onnx` ->
`apps/api/models/jolting_risk_model.onnx`).

Por qué hace falta un fixture y no basta con "el código se ve parecido":
`apps/api/src/lib/riskScore.js` reimplementa en JavaScript (Node no puede
importar código Python) el mismo resampleo/suavizado/normalización de
`preprocess.py` y las mismas secuencias (dt,dx,dy)/(dwell,flight) de
`features.py`, porque el riesgo se calcula en el servidor Node al momento
del clic (`GET /:token/d/:deliveryId/go`), no en el pipeline de Python. Sin
un caso de valor conocido calculado con el código Python real (fuente de
verdad) y comparado byte a byte contra la salida de la reimplementación JS,
un desvío de redondeo o un off-by-one en el puerto pasaría desapercibido
hasta producir un puntaje de riesgo silenciosamente incorrecto.

Uso:
    cd ml && source .venv/bin/activate
    python3 scripts/gen_risk_fixture.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import onnxruntime as ort

from src.preprocess import preprocess_mouse_samples
from src.features import mouse_sequence, keystroke_sequence
from src.dataset import _pad

HERE = os.path.dirname(__file__)
MODEL_PATH = os.path.join(HERE, "..", "reports", "jolting_risk_model.onnx")
OUT_PATH = os.path.join(HERE, "..", "..", "apps", "api", "tests", "fixtures", "risk_score_fixture.json")

VIEWPORT_W, VIEWPORT_H = 1920, 945
MAX_MOUSE_LEN, MAX_KEY_LEN = 64, 32

# Trayectoria de mouse deliberadamente IRREGULAR en el tiempo (jitter real de
# navegador, no una rejilla perfecta de 40ms) y con un salto grande al final,
# para ejercitar resampleo + suavizado + normalización por viewport a la vez.
RAW_MOUSE = [
    {"t_ms": 0, "x": 100, "y": 200, "event_type": "mousemove"},
    {"t_ms": 38, "x": 108, "y": 204, "event_type": "mousemove"},
    {"t_ms": 71, "x": 119, "y": 207, "event_type": "mousemove"},
    {"t_ms": 133, "x": 135, "y": 219, "event_type": "mousemove"},
    {"t_ms": 156, "x": 150, "y": 225, "event_type": "mousemove"},
    {"t_ms": 205, "x": 210, "y": 260, "event_type": "mousemove"},
    {"t_ms": 240, "x": 400, "y": 300, "event_type": "mousemove"},
    {"t_ms": 300, "x": 402, "y": 301, "event_type": "mousemove"},
    {"t_ms": 340, "x": 500, "y": 340, "event_type": "click"},
]

# Dos teclas con dwell/flight distintos (simula escribir algo corto en un
# formulario de la landing, p.ej. un campo de usuario).
RAW_KEYS = [
    {"t_ms": 400, "event_type": "keydown", "key_code": "KeyA"},
    {"t_ms": 470, "event_type": "keyup", "key_code": "KeyA"},
    {"t_ms": 560, "event_type": "keydown", "key_code": "KeyB"},
    {"t_ms": 615, "event_type": "keyup", "key_code": "KeyB"},
]

RAW_EVENTS = RAW_MOUSE + RAW_KEYS


def main():
    pre_mouse = preprocess_mouse_samples(RAW_MOUSE, VIEWPORT_W, VIEWPORT_H)
    m_seq = mouse_sequence(pre_mouse)
    k_seq = keystroke_sequence(RAW_EVENTS)
    m_arr, m_mask = _pad(m_seq, MAX_MOUSE_LEN, 3)
    k_arr, k_mask = _pad(k_seq, MAX_KEY_LEN, 2)

    session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    feed = {
        "mouse_x": m_arr[None, :, :].astype(np.float32),
        "mouse_mask": m_mask[None, :].astype(bool),
        "key_x": k_arr[None, :, :].astype(np.float32),
        "key_mask": k_mask[None, :].astype(bool),
    }
    (logit,) = session.run(["risk_logit"], feed)
    logit = float(logit[0])
    risk_score = float(1.0 / (1.0 + np.exp(-logit)))

    fixture = {
        "_generated_by": "ml/scripts/gen_risk_fixture.py -- no editar a mano",
        "viewport_w": VIEWPORT_W,
        "viewport_h": VIEWPORT_H,
        "raw_mouse_events": RAW_MOUSE,
        "raw_events_for_keystrokes": RAW_EVENTS,
        "expected_preprocessed_mouse": [{"t_ms": e["t_ms"], "x": e["x"], "y": e["y"]} for e in pre_mouse],
        "expected_mouse_sequence": [list(t) for t in m_seq],
        "expected_keystroke_sequence": [list(t) for t in k_seq],
        "expected_mouse_arr": m_arr.tolist(),
        "expected_mouse_mask": m_mask.tolist(),
        "expected_key_arr": k_arr.tolist(),
        "expected_key_mask": k_mask.tolist(),
        "expected_risk_logit": logit,
        "expected_risk_score": risk_score,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
    print(f"Fixture escrito en {OUT_PATH}")
    print(f"risk_logit={logit!r} risk_score={risk_score!r}")


if __name__ == "__main__":
    main()
