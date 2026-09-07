"""Preprocesamiento de captura conductual (TG §8.2.1, Tabla 1, fila 2):
resampleo, suavizado y z-score, aplicados ANTES de calcular las features de
`features.py` (fila 3 de la misma tabla).

Por qué hace falta, con datos reales concretos (no en abstracto):

1. **Resampleo.** `behavior-capture.js` muestrea mousemove a ~25 Hz, pero es
   un objetivo, no una garantía: el intervalo real entre dos muestras
   consecutivas varía con el jitter del navegador/red (`t_ms` no cae en una
   rejilla perfecta). AUC/SE/MD (`features.py`) se calculan como si cada
   punto pesara lo mismo en la integral — con espaciado irregular, un tramo
   de la sesión con muestras muy juntas pesa más de lo que debería.
   `resample_uniform` interpola la trayectoria a una rejilla de tiempo
   pareja para que ese peso sea real y no un artefacto de timing.
2. **Suavizado.** Coordenadas de mouse tienen ruido de un pixel o dos por
   redondeo/precisión del dispositivo apuntador. Sin suavizar, ese ruido
   infla las velocidades/aceleraciones instantáneas calculadas en
   `features.py` sin aportar señal real de comportamiento.
3. **Z-score.** Los 2418 eventos reales de producción ya tienen sesiones
   con `viewport_w`/`viewport_h` distintos entre sí no está garantizado -- y
   AUC/MD/path_length de `features.py` están en PÍXELES, así que no son
   directamente comparables entre dos sesiones con distinto tamaño de
   pantalla. `normalize_by_viewport` lleva x,y a [0,1] relativo al viewport
   de ESA sesión antes de resamplear/suavizar, para que la forma de la
   trayectoria (lo que de verdad importa) no dependa de la resolución de
   pantalla del participante.

   Además, y esto es lo más alineado con por qué existe la calibración
   (`docs/2026-09-06_calibracion-linea-base.md`): un valor crudo de
   velocidad o de latencia de tecleo no dice nada sin un punto de
   comparación -- cada persona teclea/mueve el mouse a su propio ritmo. Por
   eso, además del z-score genérico, `compute_calibration_baselines` calcula
   la media/desviación de velocidad y de latencias de teclado de la fase
   `calibration` de CADA participante (capturada antes de mostrarle ningún
   mensaje) y `zscore_against_baseline` la usa como referencia: el z-score
   resultante mide "cuánto se desvió esta sesión del propio comportamiento
   normal de este participante", no solo "es rápido o lento en términos
   absolutos". Cuando un participante no tiene sesión de calibración (pasa
   con datos capturados antes del 6 de septiembre, cuando ese módulo no
   existía), se usa como referencia la media/desviación de TODAS las
   sesiones reales disponibles -- un z-score poblacional en vez de
   personal, documentado explícitamente en el resultado (`baseline_source`)
   para que quede claro cuál de los dos se usó.

Todas las funciones son puras y se prueban con arrays de valor conocido
(`tests/test_preprocess.py`), igual que `features.py`.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import numpy as np


# ---------------------------------------------------------------------------
# Resampleo + suavizado de la trayectoria de mouse
# ---------------------------------------------------------------------------

def resample_uniform(t: np.ndarray, x: np.ndarray, y: np.ndarray, hz: float = 25.0):
    """Interpola (t,x,y), con `t` en ms y posiblemente espaciado irregular,
    a una rejilla de tiempo pareja a `hz` muestras por segundo.

    Menos de 2 puntos, o `t` sin duración (todo el mismo instante): no hay
    nada que interpolar -- se devuelve la entrada tal cual, sin inventar
    puntos donde no hay información temporal real.
    """
    t = np.asarray(t, dtype=np.float64)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if len(t) < 2 or t[-1] <= t[0]:
        return t.copy(), x.copy(), y.copy()

    step_ms = 1000.0 / hz
    t_grid = np.arange(t[0], t[-1] + step_ms / 2, step_ms)
    if len(t_grid) < 2:
        t_grid = np.array([t[0], t[-1]])
    x_r = np.interp(t_grid, t, x)
    y_r = np.interp(t_grid, t, y)
    return t_grid, x_r, y_r


def moving_average(arr: np.ndarray, window: int = 5) -> np.ndarray:
    """Suavizado por promedio móvil centrado, con los bordes rellenados por
    reflexión (`np.pad(..., mode="edge")`) para no acortar la serie ni
    introducir un salto artificial en los primeros/últimos puntos.

    `window` par se ajusta a impar (+1) para que el promedio quede
    centrado exactamente en cada punto, no desplazado medio paso.
    """
    arr = np.asarray(arr, dtype=np.float64)
    if len(arr) == 0:
        return arr.copy()
    if window <= 1 or len(arr) < 2:
        return arr.copy()
    if window % 2 == 0:
        window += 1
    half = window // 2
    padded = np.pad(arr, (half, half), mode="edge")
    kernel = np.ones(window) / window
    return np.convolve(padded, kernel, mode="valid")


def normalize_by_viewport(x: np.ndarray, y: np.ndarray, viewport_w, viewport_h):
    """Lleva x,y a [0,1] relativo al tamaño de pantalla de ESA sesión, para
    que la FORMA de la trayectoria sea comparable entre sesiones con
    distinta resolución. Si el viewport no vino (None/0 -- no debería pasar
    con datos reales de `behavior-capture.js`, pero los tests de features.py
    ya cubren entradas degeneradas), se devuelve x,y sin cambios en vez de
    dividir por cero.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if not viewport_w or not viewport_h:
        return x.copy(), y.copy()
    return x / float(viewport_w), y / float(viewport_h)


def preprocess_mouse_samples(samples: list[dict], viewport_w=None, viewport_h=None,
                              hz: float = 25.0, window: int = 5) -> list[dict]:
    """Encadena normalización por viewport -> resampleo -> suavizado sobre
    las muestras crudas de mousemove de una sesión, y devuelve una lista de
    pseudo-eventos `{t_ms, x, y, event_type: "mousemove"}` -- MISMA forma
    que las filas crudas que ya consumen `mouse_trajectory_features` y
    `mouse_sequence` en `features.py`, para no tener que tocar ese módulo
    ya probado y entregado.

    Menos de 2 puntos válidos: no hay trayectoria que preprocesar, se
    devuelve tal cual (features.py ya maneja ese caso devolviendo features
    en cero, no es un error).
    """
    # Mismo filtro que `mouse_trajectory_features`/`mouse_sequence` en
    # features.py: cualquier evento con x,y (no solo mousemove -- clicks
    # también traen coordenada y son parte real de la trayectoria), para
    # que preprocesar no tire información que el resto del pipeline sí usa.
    pts = [(s["t_ms"], s["x"], s["y"]) for s in samples
           if s.get("x") is not None and s.get("y") is not None]
    if len(pts) < 2:
        return [{"t_ms": t, "x": x, "y": y, "event_type": "mousemove"} for (t, x, y) in pts]

    t = np.array([p[0] for p in pts], dtype=np.float64)
    x = np.array([p[1] for p in pts], dtype=np.float64)
    y = np.array([p[2] for p in pts], dtype=np.float64)

    x_n, y_n = normalize_by_viewport(x, y, viewport_w, viewport_h)
    t_r, x_r, y_r = resample_uniform(t, x_n, y_n, hz=hz)
    x_s = moving_average(x_r, window=window)
    y_s = moving_average(y_r, window=window)

    return [{"t_ms": float(tt), "x": float(xx), "y": float(yy), "event_type": "mousemove"}
            for tt, xx, yy in zip(t_r, x_s, y_s)]


# ---------------------------------------------------------------------------
# Z-score: contra la línea base de calibración del propio participante, o
# contra la población si no hay calibración disponible para esa sesión.
# ---------------------------------------------------------------------------

@dataclass
class Baseline:
    mouse_velocity_mean: float
    mouse_velocity_std: float
    dwell_mean: float
    dwell_std: float
    flight_mean: float
    flight_std: float
    source: str  # "personal" (calibración de ESTE participante) o "poblacional"


def _safe_mean_std(values: list[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 1.0
    arr = np.asarray(values, dtype=np.float64)
    std = float(arr.std())
    return float(arr.mean()), (std if std > 1e-9 else 1.0)


def compute_calibration_baselines(rows: list[dict]) -> dict[str, Baseline]:
    """Una `Baseline` por `participant_campaign_id` que tenga una sesión de
    fase `calibration` en `rows`, calculada a partir de ESA sesión (mouse
    preprocesado con hz/window por defecto + `keystroke_features` crudo de
    `features.py`). Además agrega la entrada especial `"__population__"`
    con la media/desviación de TODAS las sesiones reales, para las
    sesiones cuyo participante no tiene calibración registrada (datos de
    antes del 6 de septiembre, cuando ese módulo no existía).
    """
    from .features import mouse_trajectory_features, keystroke_features
    from .dataset import group_by_session

    sessions = group_by_session(rows)
    by_pc_calibration: dict[str, list[dict]] = {}
    for sid, events in sessions.items():
        if events and events[0].get("phase") == "calibration":
            pc = events[0].get("participant_campaign_id")
            if pc:
                by_pc_calibration[pc] = events

    baselines: dict[str, Baseline] = {}
    for pc, events in by_pc_calibration.items():
        vp_w = events[0].get("viewport_w")
        vp_h = events[0].get("viewport_h")
        pre_mouse = preprocess_mouse_samples(events, vp_w, vp_h)
        mf = mouse_trajectory_features(pre_mouse)
        kf = keystroke_features(events)
        baselines[pc] = Baseline(
            mouse_velocity_mean=mf.mean_velocity, mouse_velocity_std=(mf.std_velocity or 1.0),
            dwell_mean=kf.mean_dwell_ms, dwell_std=(kf.std_dwell_ms or 1.0),
            flight_mean=kf.mean_flight_ms, flight_std=(kf.std_flight_ms or 1.0),
            source="personal",
        )

    # Referencia poblacional: sobre TODAS las sesiones reales (no solo las
    # de calibración), preprocesando mouse igual que arriba, para que sea
    # comparable con lo que se le resta/divide.
    all_velocities, all_dwells, all_flights = [], [], []
    for sid, events in sessions.items():
        vp_w = events[0].get("viewport_w")
        vp_h = events[0].get("viewport_h")
        mf = mouse_trajectory_features(preprocess_mouse_samples(events, vp_w, vp_h))
        kf = keystroke_features(events)
        if mf.n_points >= 2:
            all_velocities.append(mf.mean_velocity)
        if kf.n_keys > 0:
            all_dwells.append(kf.mean_dwell_ms)
            all_flights.append(kf.mean_flight_ms)

    vmean, vstd = _safe_mean_std(all_velocities)
    dmean, dstd = _safe_mean_std(all_dwells)
    fmean, fstd = _safe_mean_std(all_flights)
    baselines["__population__"] = Baseline(
        mouse_velocity_mean=vmean, mouse_velocity_std=vstd,
        dwell_mean=dmean, dwell_std=dstd,
        flight_mean=fmean, flight_std=fstd,
        source="poblacional",
    )
    return baselines


def zscore(value: float, mean: float, std: float) -> float:
    """Z-score simple: (value - mean) / std, con std ya garantizado != 0
    por `_safe_mean_std`/`Baseline` (una std de 0 volvería el z-score
    infinito o NaN por una división que no tiene información real que
    aportar, así que se trata como 1.0 -- "sin variación de referencia
    conocida", no como señal)."""
    return (value - mean) / std if std else 0.0


def baseline_for(participant_campaign_id: str | None, baselines: dict[str, Baseline]) -> Baseline:
    """La baseline personal si existe para este participante, si no la
    poblacional -- siempre devuelve algo usable, nunca None, para que el
    llamador no tenga que manejar el caso "sin baseline" por separado."""
    if participant_campaign_id and participant_campaign_id in baselines:
        return baselines[participant_campaign_id]
    return baselines["__population__"]
