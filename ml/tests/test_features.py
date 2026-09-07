import math

from src.features import (
    mouse_trajectory_features,
    keystroke_features,
    mouse_sequence,
    keystroke_sequence,
)


def mm(t, x, y):
    return {"t_ms": t, "event_type": "mousemove", "x": x, "y": y}


def test_straight_line_gives_zero_auc_se_md():
    # Línea perfectamente recta, cualquier número de puntos intermedios:
    # AUC = SE = MD = 0 porque ningún punto se desvía de la recta que él
    # mismo define (inicio->fin).
    samples = [mm(0, 0, 0), mm(10, 10, 10), mm(20, 20, 20), mm(30, 30, 30)]
    f = mouse_trajectory_features(samples)
    assert math.isclose(f.auc, 0.0, abs_tol=1e-9)
    assert math.isclose(f.se, 0.0, abs_tol=1e-9)
    assert math.isclose(f.md, 0.0, abs_tol=1e-9)
    assert math.isclose(f.efficiency, 1.0, abs_tol=1e-9)


def test_known_right_angle_deviation():
    # Recta ideal de (0,0) a (10,0). El punto intermedio (5,5) está a
    # distancia perpendicular EXACTA de 5 (la recta es el eje X).
    samples = [mm(0, 0, 0), mm(5, 5, 5), mm(10, 10, 0)]
    f = mouse_trajectory_features(samples)
    assert f.md > 0
    assert f.auc > 0
    # MD debe ser el promedio de [0, 5, 0] = 5/3
    assert math.isclose(f.md, 5 / 3, rel_tol=1e-6)


def test_fewer_than_two_points_is_zero_not_error():
    f = mouse_trajectory_features([mm(0, 1, 1)])
    assert f.n_points == 1
    assert f.auc == 0.0 and f.se == 0.0 and f.md == 0.0
    f0 = mouse_trajectory_features([])
    assert f0.n_points == 0


def test_velocity_and_acceleration_known_values():
    # 3 puntos, separados 10ms, moviéndose 10px en X cada vez -> velocidad
    # constante 1 px/ms, aceleración 0.
    samples = [mm(0, 0, 0), mm(10, 10, 0), mm(20, 20, 0)]
    f = mouse_trajectory_features(samples)
    assert math.isclose(f.mean_velocity, 1.0, rel_tol=1e-6)
    assert math.isclose(f.mean_acceleration, 0.0, abs_tol=1e-9)


def test_ignores_samples_without_xy():
    # Un evento sin x/y (p.ej. visibility_hidden) no debe romper el cálculo
    # ni contarse como punto de la trayectoria.
    samples = [mm(0, 0, 0), {"t_ms": 5, "event_type": "visibility_hidden", "x": None, "y": None}, mm(10, 10, 10)]
    f = mouse_trajectory_features(samples)
    assert f.n_points == 2


def kd(t, code):
    return {"t_ms": t, "event_type": "keydown", "key_code": code}


def ku(t, code):
    return {"t_ms": t, "event_type": "keyup", "key_code": code}


def test_dwell_and_flight_known_values():
    # Tecla A: down@0, up@100 -> dwell 100. Luego tecla B: down@150 (flight
    # desde el up de A = 50), up@220 -> dwell 70.
    samples = [kd(0, "KeyA"), ku(100, "KeyA"), kd(150, "KeyB"), ku(220, "KeyB")]
    f = keystroke_features(samples)
    assert f.n_keys == 2
    assert math.isclose(f.mean_dwell_ms, (100 + 70) / 2, rel_tol=1e-6)
    assert math.isclose(f.mean_flight_ms, 50.0, rel_tol=1e-6)


def test_no_keystrokes_is_zero_not_error():
    f = keystroke_features([])
    assert f.n_keys == 0
    assert f.mean_dwell_ms == 0.0 and f.mean_flight_ms == 0.0


def test_never_reads_which_character_was_typed():
    # Invariante de privacidad: las features de teclado no deben referenciar
    # ningún campo de contenido (no existe tal campo en el esquema, pero se
    # confirma acá que la función no lo necesita ni lo produce).
    samples = [kd(0, "KeyQ"), ku(50, "KeyQ")]
    f = keystroke_features(samples)
    assert "value" not in f.to_dict()
    assert "char" not in f.to_dict()
    assert set(f.to_dict().keys()) == {"n_keys", "mean_dwell_ms", "std_dwell_ms", "mean_flight_ms", "std_flight_ms"}


def test_mouse_sequence_deltas():
    samples = [mm(0, 0, 0), mm(10, 5, -5), mm(25, 5, -5)]
    seq = mouse_sequence(samples)
    assert seq == [(10.0, 5.0, -5.0), (15.0, 0.0, 0.0)]


def test_keystroke_sequence_pairs():
    samples = [kd(0, "KeyA"), ku(80, "KeyA")]
    seq = keystroke_sequence(samples)
    assert seq == [(80.0, 0.0)]


def test_overlapping_keys_matched_by_stack_not_crossed():
    # A baja, B baja (mientras A sigue presionada), A sube, B sube — el
    # emparejamiento debe seguir siendo correcto por key_code, no por orden
    # de aparición cruzado.
    samples = [kd(0, "KeyA"), kd(5, "KeyB"), ku(50, "KeyA"), ku(60, "KeyB")]
    f = keystroke_features(samples)
    assert f.n_keys == 2
    # dwell de A = 50, dwell de B = 55
    assert math.isclose(f.mean_dwell_ms, (50 + 55) / 2, rel_tol=1e-6)
