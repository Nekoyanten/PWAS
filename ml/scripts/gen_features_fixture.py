"""Genera el fixture de paridad cruzada Python<->JavaScript para el módulo
7 de la Tabla 1 (§8.2.1, "etiquetado fino" -- almacenamiento de features
calculadas por sesión, no solo eventos crudos).

A diferencia de gen_risk_fixture.py (que verifica la inferencia ONNX), este
fixture verifica el PUERTO a JavaScript de `ml/src/features.py`
(mouse_trajectory_features, keystroke_features) y `ml/src/preprocess.py`
(compute_calibration_baselines, zscore, baseline_for) que hace
apps/api/src/lib/behaviorFeatures.js -- las funciones que calculan AUC/SE/MD,
latencias de tecleo, y sus z-scores contra la línea base de calibración,
para persistirlas en `behavior_session_features` (migración 008).

Tres sesiones sintéticas, deliberadamente elegidas para ejercitar AMBOS
caminos de `baseline_for` (personal y poblacional):
  - "sess-calib-pcA": fase 'calibration' del participante pcA -- se vuelve
    su línea base PERSONAL.
  - "sess-msg-pcA":   fase 'message' del MISMO participante pcA -- debe
    usar la línea base personal de arriba.
  - "sess-msg-pcB":   fase 'message' de un participante pcB SIN sesión de
    calibración -- debe caer al respaldo POBLACIONAL (calculado sobre las
    3 sesiones, igual que en producción).

Ejecutar desde ml/ con el venv activo:
    python3 scripts/gen_features_fixture.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.features import mouse_trajectory_features, keystroke_features
from src.preprocess import preprocess_mouse_samples, compute_calibration_baselines, baseline_for, zscore

VIEWPORT_W, VIEWPORT_H = 1920, 945


def mouse_events(offset_x, offset_y, n=9, jitter=(0, 3, -2, 4, 0, -3, 2, 0, 1)):
    """Trayectoria de mouse con jitter temporal, distinta por sesión (offset)."""
    out = []
    t = 0
    for i in range(n):
        t += 38 + jitter[i % len(jitter)]
        out.append({"t_ms": t, "event_type": "mousemove", "x": offset_x + i * 14, "y": offset_y + (i % 4) * 9})
    return out


def key_events(pairs):
    """`pairs`: lista de (code, down_t, up_t) -> eventos keydown/keyup intercalados."""
    out = []
    for code, down_t, up_t in pairs:
        out.append({"t_ms": down_t, "event_type": "keydown", "key_code": code})
        out.append({"t_ms": up_t, "event_type": "keyup", "key_code": code})
    out.sort(key=lambda e: e["t_ms"])
    return out


SESSIONS = {
    "sess-calib-pcA": {
        "phase": "calibration",
        "participant_campaign_id": "pcA",
        "events": mouse_events(80, 120) + key_events([("KeyA", 400, 460), ("KeyB", 520, 570)]),
    },
    "sess-msg-pcA": {
        "phase": "message",
        "participant_campaign_id": "pcA",
        "events": mouse_events(200, 300, jitter=(2, 0, 5, -1, 3, 0, -2, 4, 1)) + key_events([("KeyC", 350, 410)]),
    },
    "sess-msg-pcB": {
        "phase": "message",
        "participant_campaign_id": "pcB",
        "events": mouse_events(500, 60, jitter=(-1, 2, 0, 3, -2, 1, 0, 4, -3)),
        # sin eventos de teclado -- pcB no tecleó nada en esta sesión.
    },
}


def rows_for_baselines():
    """Aplana SESSIONS al formato que espera compute_calibration_baselines
    (lista de filas con session_id/phase/participant_campaign_id/viewport_*/
    t_ms/event_type/x/y/key_code, una por evento)."""
    rows = []
    for sid, s in SESSIONS.items():
        for e in s["events"]:
            rows.append({
                "session_id": sid,
                "phase": s["phase"],
                "participant_campaign_id": s["participant_campaign_id"],
                "viewport_w": VIEWPORT_W,
                "viewport_h": VIEWPORT_H,
                **e,
            })
    return rows


def main():
    rows = rows_for_baselines()
    baselines = compute_calibration_baselines(rows)

    fixture = {"viewport_w": VIEWPORT_W, "viewport_h": VIEWPORT_H, "sessions": {}}

    for sid, s in SESSIONS.items():
        events = s["events"]
        pre_mouse = preprocess_mouse_samples(events, VIEWPORT_W, VIEWPORT_H)
        mf = mouse_trajectory_features(pre_mouse).to_dict()
        kf = keystroke_features(events).to_dict()
        b = baseline_for(s["participant_campaign_id"], baselines)
        fixture["sessions"][sid] = {
            "phase": s["phase"],
            "participant_campaign_id": s["participant_campaign_id"],
            "raw_events": events,
            "expected_mouse_features": mf,
            "expected_key_features": kf,
            "expected_baseline_source": b.source,
            "expected_mouse_mean_velocity_z": zscore(mf["mean_velocity"], b.mouse_velocity_mean, b.mouse_velocity_std),
            "expected_key_mean_dwell_ms_z": zscore(kf["mean_dwell_ms"], b.dwell_mean, b.dwell_std),
            "expected_key_mean_flight_ms_z": zscore(kf["mean_flight_ms"], b.flight_mean, b.flight_std),
        }

    fixture["expected_population_baseline"] = {
        "mouse_velocity_mean": baselines["__population__"].mouse_velocity_mean,
        "mouse_velocity_std": baselines["__population__"].mouse_velocity_std,
        "dwell_mean": baselines["__population__"].dwell_mean,
        "dwell_std": baselines["__population__"].dwell_std,
        "flight_mean": baselines["__population__"].flight_mean,
        "flight_std": baselines["__population__"].flight_std,
    }
    fixture["expected_personal_baseline_pcA"] = {
        "mouse_velocity_mean": baselines["pcA"].mouse_velocity_mean,
        "mouse_velocity_std": baselines["pcA"].mouse_velocity_std,
        "dwell_mean": baselines["pcA"].dwell_mean,
        "dwell_std": baselines["pcA"].dwell_std,
        "flight_mean": baselines["pcA"].flight_mean,
        "flight_std": baselines["pcA"].flight_std,
    }

    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "..", "apps", "api", "tests", "fixtures", "behavior_features_fixture.json",
    )
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
    print(f"Fixture escrito en {out_path}")
    print(json.dumps({k: v for k, v in fixture.items() if k != "sessions"}, indent=2))
    for sid, s in fixture["sessions"].items():
        print(sid, "->", s["expected_baseline_source"],
              "mouse_mean_velocity_z=", s["expected_mouse_mean_velocity_z"])


if __name__ == "__main__":
    main()
