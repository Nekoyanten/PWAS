import numpy as np

from src.preprocess import (
    resample_uniform, moving_average, normalize_by_viewport,
    preprocess_mouse_samples, compute_calibration_baselines, baseline_for,
    zscore, Baseline,
)
from src.dataset import load_export
import os

REAL_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "behavior_events_real.json")


def test_resample_uniform_preserves_endpoints_and_produces_even_spacing():
    t = np.array([0, 30, 55, 120, 200], dtype=float)
    x = np.array([0, 10, 20, 40, 100], dtype=float)
    y = np.array([0, 0, 0, 0, 0], dtype=float)
    t_r, x_r, y_r = resample_uniform(t, x, y, hz=25.0)  # step = 40ms
    assert t_r[0] == t[0]
    assert abs(t_r[-1] - t[-1]) < 1e-6
    diffs = np.diff(t_r)
    assert np.allclose(diffs, diffs[0]), "la rejilla resampleada debe tener espaciado parejo"
    # el valor interpolado en cualquier punto de la rejilla debe caer dentro
    # del rango real de x (nunca extrapola fuera de [x.min(), x.max()])
    assert x_r.min() >= x.min() - 1e-6 and x_r.max() <= x.max() + 1e-6


def test_resample_uniform_passes_through_fewer_than_two_points():
    t = np.array([10.0])
    x = np.array([5.0])
    y = np.array([5.0])
    t_r, x_r, y_r = resample_uniform(t, x, y)
    assert list(t_r) == [10.0]
    assert list(x_r) == [5.0]


def test_resample_uniform_passes_through_zero_duration():
    # dos muestras con el mismo t_ms (posible con timestamps de baja
    # resolución) -- no hay "duración" que resamplear, no debe crashear
    # ni dividir por cero.
    t = np.array([10.0, 10.0])
    x = np.array([1.0, 2.0])
    y = np.array([1.0, 2.0])
    t_r, x_r, y_r = resample_uniform(t, x, y)
    assert list(t_r) == [10.0, 10.0]


def test_moving_average_smooths_a_noisy_constant_signal_toward_the_constant():
    rng = np.random.RandomState(0)
    constant = 50.0
    noisy = constant + rng.normal(0, 1.0, size=200)
    smoothed = moving_average(noisy, window=9)
    assert len(smoothed) == len(noisy)
    # el promedio móvil debe reducir la dispersión punto a punto de forma
    # sustancial (la varianza teórica de un promedio de 9 muestras i.i.d.
    # es ~9x menor) sin desplazar el nivel general de la señal.
    assert smoothed.std() < noisy.std() / 2
    assert abs(smoothed.mean() - noisy.mean()) < 0.5


def test_moving_average_does_not_shrink_or_shift_the_series():
    arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    smoothed = moving_average(arr, window=3)
    assert len(smoothed) == len(arr)
    # el punto de en medio de una rampa lineal no debe moverse al suavizar
    assert abs(smoothed[2] - arr[2]) < 1e-9


def test_moving_average_window_le_1_or_short_array_is_a_noop():
    arr = np.array([1.0, 2.0, 3.0])
    assert list(moving_average(arr, window=1)) == list(arr)
    assert list(moving_average(np.array([1.0]), window=5)) == [1.0]


def test_normalize_by_viewport_maps_into_zero_one_range():
    x = np.array([0.0, 960.0, 1920.0])
    y = np.array([0.0, 472.5, 945.0])
    x_n, y_n = normalize_by_viewport(x, y, 1920, 945)
    assert np.allclose(x_n, [0.0, 0.5, 1.0])
    assert np.allclose(y_n, [0.0, 0.5, 1.0])


def test_normalize_by_viewport_passes_through_when_viewport_missing():
    x = np.array([10.0, 20.0])
    y = np.array([5.0, 6.0])
    x_n, y_n = normalize_by_viewport(x, y, None, None)
    assert list(x_n) == list(x)
    assert list(y_n) == list(y)


def test_preprocess_mouse_samples_shape_and_no_extrapolation():
    samples = [
        {"t_ms": 0, "x": 0, "y": 0, "event_type": "mousemove"},
        {"t_ms": 40, "x": 100, "y": 50, "event_type": "mousemove"},
        {"t_ms": 90, "x": 300, "y": 100, "event_type": "click"},
        {"t_ms": 150, "x": 500, "y": 200, "event_type": "mousemove"},
    ]
    out = preprocess_mouse_samples(samples, viewport_w=1000, viewport_h=1000, hz=25.0, window=3)
    assert len(out) >= 2
    for e in out:
        assert 0.0 <= e["x"] <= 1.0
        assert 0.0 <= e["y"] <= 1.0
        assert e["event_type"] == "mousemove"


def test_preprocess_mouse_samples_passes_through_degenerate_session():
    assert preprocess_mouse_samples([], 1920, 945) == []
    one = [{"t_ms": 5, "x": 1, "y": 1, "event_type": "mousemove"}]
    assert len(preprocess_mouse_samples(one, 1920, 945)) == 1


def test_zscore_basic():
    assert zscore(10.0, 10.0, 5.0) == 0.0
    assert zscore(15.0, 10.0, 5.0) == 1.0
    assert zscore(5.0, 10.0, 5.0) == -1.0
    assert zscore(3.0, 1.0, 0.0) == 0.0  # std 0 -> sin señal, no división por cero


def test_baseline_for_falls_back_to_population_for_unknown_participant():
    baselines = {
        "__population__": Baseline(0, 1, 0, 1, 0, 1, "poblacional"),
        "p1": Baseline(5, 2, 5, 2, 5, 2, "personal"),
    }
    assert baseline_for("p1", baselines).source == "personal"
    assert baseline_for("unknown-participant", baselines).source == "poblacional"
    assert baseline_for(None, baselines).source == "poblacional"


def test_compute_calibration_baselines_on_real_data_finds_personal_baselines():
    # Datos reales: 5 sesiones de fase "calibration" (agregadas el 6 de
    # sept.), 4 de ellas con el mismo participant_campaign_id que otras
    # fases de sesión -- exactamente el caso que motiva el z-score personal.
    rows = load_export(REAL_DATA)
    baselines = compute_calibration_baselines(rows)
    assert "__population__" in baselines
    personal = {pc: b for pc, b in baselines.items() if pc != "__population__" and b.source == "personal"}
    assert len(personal) == 5, "se esperaban 5 sesiones de calibración reales con línea base personal"
    for b in baselines.values():
        assert b.mouse_velocity_std > 0
        assert b.dwell_std > 0
        assert b.flight_std > 0
