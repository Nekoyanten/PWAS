"""Extracción de features de captura conductual (TG §8.2.3).

Consume las filas CRUDAS que entrega `GET /api/export/behavior-events.:format`
(ver `apps/api/src/routes/export.js`) — una fila por muestra de
mousemove/mousedown/mouseup/click/keydown/keyup, agrupadas por `session_id`
(una sesión = una pantalla/"fase" con captura activa, ver migración
004_behavior_capture.sql) — y calcula, por sesión, exactamente las features
que los documentos de la investigación nombran (docs/2026-09-05_captura-
conductual-real.md, línea 17): "AUC, error estándar, distancia media de la
trayectoria del mouse; latencias entre teclas".

Definiciones (no hay ambigüedad que inventar: son features estándar de la
literatura de dinámica de mouse, ver docs/2026-09-06_pipeline-ml-offline.md
para las citas):

- Se traza la recta imaginaria entre el primer y el último punto de la
  trayectoria de mouse de la sesión. Para cada punto intermedio se calcula
  su distancia perpendicular a esa recta (`_perpendicular_distances`).
- MD  (distancia media)  = promedio de esas distancias.
- SE  (error estándar)   = desviación estándar de esas distancias / sqrt(n).
- AUC (área bajo la curva) = integral (regla del trapecio) de esas
  distancias a lo largo de la trayectoria normalizada [0,1] — mide cuánto
  se "desvía" el trayecto real de la línea recta ideal, acumulado.

Todas las funciones son puras (sin I/O, sin acceso a base de datos) para que
sean triviales de probar con casos de valor conocido (ver
`tests/test_features.py`): una trayectoria en línea recta perfecta debe dar
AUC = SE = MD = 0, sin importar cuántos puntos tenga.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Sequence


# ---------------------------------------------------------------------------
# Trayectoria de mouse
# ---------------------------------------------------------------------------

def _perpendicular_distances(points: Sequence[tuple[float, float]]) -> list[float]:
    """Distancia perpendicular de cada punto a la recta punto[0]->punto[-1].

    Si la recta tiene longitud 0 (inicio y fin coinciden), la distancia de
    cada punto es simplemente su distancia euclidiana al punto de inicio —
    no hay una "línea" respecto a la cual desviarse, pero el movimiento
    (si lo hay) sigue siendo una desviación real que no queremos perder.
    """
    if len(points) < 2:
        return [0.0] * len(points)
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    line_len = math.hypot(dx, dy)
    out = []
    for (px, py) in points:
        if line_len == 0:
            out.append(math.hypot(px - ax, py - ay))
        else:
            # |cross product| / |AB| = distancia punto-recta
            cross = abs(dx * (ay - py) - (ax - px) * dy)
            out.append(cross / line_len)
    return out


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _std(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    var = sum((x - m) ** 2 for x in xs) / (len(xs) - 1)
    return math.sqrt(var)


@dataclass
class MouseTrajectoryFeatures:
    n_points: int
    auc: float
    se: float
    md: float
    path_length: float
    straight_line_distance: float
    efficiency: float  # straight_line_distance / path_length; 1.0 = línea perfecta
    mean_velocity: float  # px/ms
    std_velocity: float
    mean_acceleration: float  # px/ms^2
    std_acceleration: float

    def to_dict(self) -> dict:
        return asdict(self)


def mouse_trajectory_features(samples: Sequence[dict]) -> MouseTrajectoryFeatures:
    """`samples`: lista de dicts con al menos t_ms, x, y (mousemove), ya
    ordenados por t_ms. Menos de 2 puntos válidos -> features en cero
    (no hay trayectoria que describir, no es un error)."""
    pts = [(s["t_ms"], s["x"], s["y"]) for s in samples if s.get("x") is not None and s.get("y") is not None]
    if len(pts) < 2:
        n = len(pts)
        return MouseTrajectoryFeatures(n, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)

    xy = [(x, y) for (_, x, y) in pts]
    dists = _perpendicular_distances(xy)

    # AUC: regla del trapecio sobre el parámetro de trayectoria normalizado
    # [0,1] (un punto de datos por muestra, espaciado uniforme en el índice
    # -- no en el tiempo, porque el muestreo de mousemove no es a intervalo
    # fijo). Ver docstring del módulo.
    n = len(dists)
    step = 1.0 / (n - 1)
    auc = 0.0
    for i in range(n - 1):
        auc += step * (dists[i] + dists[i + 1]) / 2.0

    se = _std(dists) / math.sqrt(n)
    md = _mean(dists)

    path_length = sum(math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) for i in range(n - 1))
    straight = math.hypot(xy[-1][0] - xy[0][0], xy[-1][1] - xy[0][1])
    efficiency = (straight / path_length) if path_length > 0 else 1.0

    velocities = []
    for i in range(n - 1):
        dt = pts[i + 1][0] - pts[i][0]
        if dt <= 0:
            continue
        d = math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1])
        velocities.append(d / dt)
    accelerations = []
    for i in range(len(velocities) - 1):
        accelerations.append(velocities[i + 1] - velocities[i])

    return MouseTrajectoryFeatures(
        n_points=n,
        auc=auc,
        se=se,
        md=md,
        path_length=path_length,
        straight_line_distance=straight,
        efficiency=min(efficiency, 1.0),
        mean_velocity=_mean(velocities),
        std_velocity=_std(velocities),
        mean_acceleration=_mean(accelerations),
        std_acceleration=_std(accelerations),
    )


# ---------------------------------------------------------------------------
# Latencias de teclado
# ---------------------------------------------------------------------------

@dataclass
class KeystrokeFeatures:
    n_keys: int
    mean_dwell_ms: float
    std_dwell_ms: float
    mean_flight_ms: float
    std_flight_ms: float

    def to_dict(self) -> dict:
        return asdict(self)


def keystroke_features(samples: Sequence[dict]) -> KeystrokeFeatures:
    """`samples`: dicts con t_ms, event_type ('keydown'/'keyup'), key_code,
    ya ordenados por t_ms. Nunca se lee el carácter escrito (ver
    db/schema.sql: behavior_events.key_code es solo el código físico de la
    tecla, p.ej. "KeyA") — estas features solo usan tiempos.

    - dwell time: keyup.t - keydown.t de LA MISMA tecla (se emparejan con
      una pila por key_code, para tolerar que dos teclas distintas estén
      presionadas a la vez sin cruzarse).
    - flight time: keydown.t del siguiente evento - keyup.t del anterior
      (independiente de qué tecla sea) — el tiempo "en el aire" entre
      soltar una tecla y presionar la que sigue.
    """
    events = [s for s in samples if s.get("event_type") in ("keydown", "keyup")]
    open_by_key: dict[str, list[float]] = {}
    dwell_times: list[float] = []
    last_keyup_t: float | None = None
    flight_times: list[float] = []

    for e in events:
        code = e.get("key_code") or "?"
        if e["event_type"] == "keydown":
            if last_keyup_t is not None:
                flight = e["t_ms"] - last_keyup_t
                if flight >= 0:
                    flight_times.append(flight)
            open_by_key.setdefault(code, []).append(e["t_ms"])
        else:  # keyup
            stack = open_by_key.get(code)
            if stack:
                down_t = stack.pop()
                dwell = e["t_ms"] - down_t
                if dwell >= 0:
                    dwell_times.append(dwell)
            last_keyup_t = e["t_ms"]

    n_keys = len(dwell_times)
    return KeystrokeFeatures(
        n_keys=n_keys,
        mean_dwell_ms=_mean(dwell_times),
        std_dwell_ms=_std(dwell_times),
        mean_flight_ms=_mean(flight_times),
        std_flight_ms=_std(flight_times),
    )


# ---------------------------------------------------------------------------
# Secuencias crudas (para el modelo temporal, no para los baselines)
# ---------------------------------------------------------------------------

def mouse_sequence(samples: Sequence[dict]) -> list[tuple[float, float, float]]:
    """(dt_ms, dx, dy) entre muestras consecutivas de mousemove — la
    representación que consume la rama TCN del modelo temporal (deltas, no
    posiciones absolutas, para que sea invariante a dónde esté la ventana
    del navegador)."""
    pts = [(s["t_ms"], s["x"], s["y"]) for s in samples if s.get("x") is not None and s.get("y") is not None]
    out = []
    for i in range(1, len(pts)):
        t0, x0, y0 = pts[i - 1]
        t1, x1, y1 = pts[i]
        out.append((t1 - t0, x1 - x0, y1 - y0))
    return out


def keystroke_sequence(samples: Sequence[dict]) -> list[tuple[float, float]]:
    """(dwell_ms, flight_ms) por tecla soltada, en orden — la representación
    que consume la rama Transformer del modelo temporal."""
    events = [s for s in samples if s.get("event_type") in ("keydown", "keyup")]
    open_by_key: dict[str, list[float]] = {}
    last_keyup_t: float | None = None
    out: list[tuple[float, float]] = []
    pending_flight = 0.0
    for e in events:
        code = e.get("key_code") or "?"
        if e["event_type"] == "keydown":
            if last_keyup_t is not None:
                pending_flight = max(0.0, e["t_ms"] - last_keyup_t)
            open_by_key.setdefault(code, []).append(e["t_ms"])
        else:
            stack = open_by_key.get(code)
            if stack:
                down_t = stack.pop()
                dwell = max(0.0, e["t_ms"] - down_t)
                out.append((dwell, pending_flight))
            last_keyup_t = e["t_ms"]
    return out
