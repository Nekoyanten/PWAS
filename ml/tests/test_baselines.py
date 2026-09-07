import os

import numpy as np
from sklearn.model_selection import train_test_split

from src.baselines import train_baselines
from src.dataset import load_export, build_feature_table, synthetic_labels, FEATURE_COLUMNS

REAL_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "behavior_events_real.json")


def _toy_dataset(seed=0, n=60, n_features=5):
    rng = np.random.RandomState(seed)
    X = rng.normal(size=(n, n_features))
    # Señal real y aprendible: y depende de la primera columna + ruido, para
    # que un clasificador razonable haga mejor que azar (roc_auc > 0.5) y la
    # prueba de sanidad tenga sentido.
    y = (X[:, 0] + rng.normal(scale=0.3, size=n) > 0).astype(int)
    return X, y


def test_train_baselines_returns_all_three_models_with_metrics():
    X, y = _toy_dataset()
    X_train, X_test = X[:40], X[40:]
    y_train, y_test = y[:40], y[40:]
    out = train_baselines(X_train, y_train, X_test, y_test, feature_names=[f"f{i}" for i in range(5)])

    assert set(out["results"].keys()) == {"svm", "random_forest", "xgboost"}
    for name, r in out["results"].items():
        m = r["metrics"]
        for key in ("accuracy", "precision", "recall", "f1", "roc_auc"):
            assert key in m


def test_baselines_beat_random_chance_on_learnable_toy_data():
    X, y = _toy_dataset(seed=1, n=200)
    X_train, X_test = X[:160], X[160:]
    y_train, y_test = y[:160], y[160:]
    out = train_baselines(X_train, y_train, X_test, y_test, feature_names=[f"f{i}" for i in range(5)])
    for name, r in out["results"].items():
        auc = r["metrics"]["roc_auc"]
        assert auc is not None and auc > 0.6, f"{name} no superó azar de forma clara (AUC={auc})"


def test_random_forest_and_xgboost_expose_feature_importance():
    X, y = _toy_dataset()
    out = train_baselines(X[:40], y[:40], X[40:], y[40:], feature_names=["a", "b", "c", "d", "e"])
    for name in ("random_forest", "xgboost"):
        fi = out["results"][name]["feature_importance"]
        assert set(fi.keys()) == {"a", "b", "c", "d", "e"}
        assert all(v >= 0 for v in fi.values())
        # La feature "a" (columna 0) es la que de verdad genera la etiqueta
        # -- debería ser, casi siempre, la más importante.
        assert max(fi, key=fi.get) == "a"


def test_deterministic_with_fixed_seed():
    X, y = _toy_dataset()
    out1 = train_baselines(X[:40], y[:40], X[40:], y[40:], feature_names=list("abcde"), seed=123)
    out2 = train_baselines(X[:40], y[:40], X[40:], y[40:], feature_names=list("abcde"), seed=123)
    assert out1["results"]["random_forest"]["scores"] == out2["results"]["random_forest"]["scores"]
    assert out1["results"]["xgboost"]["scores"] == out2["results"]["xgboost"]["scores"]


def test_random_forest_near_perfect_score_on_synthetic_labels_is_explained_by_label_construction():
    # Encontrado y confirmado durante la revisión /engineering:debug del
    # pipeline sobre datos reales: en la corrida de evaluate.py, Random
    # Forest da accuracy=1.0 y ROC-AUC=1.0 en el set de prueba (N=44
    # sesiones). Esto NO es evidencia de que el modelo "aprendió a detectar
    # phishing" -- es la consecuencia mecánica y esperable de que
    # `synthetic_labels()` construye la etiqueta como una combinación lineal
    # (con poco ruido) de `mouse_efficiency` y `mouse_mean_velocity`, dos
    # columnas que están literalmente en FEATURE_COLUMNS y alimentan
    # directamente a RF. Este test lo demuestra empíricamente: si se
    # remueven esas dos columnas (dejando el resto, muchas de ellas
    # correlacionadas con las removidas por derivarse de la misma
    # trayectoria de mouse), el accuracy debe bajar -- confirmando que el
    # resultado "perfecto" depende de la construcción de la etiqueta
    # sintética, no de una señal real de riesgo de phishing. Cuando existan
    # etiquetas reales (encuestas post-sesión), este resultado no se
    # replicará y NO debe usarse como referencia de desempeño esperado.
    rows = load_export(REAL_DATA)
    df = build_feature_table(rows)
    y = synthetic_labels(df, seed=42)
    X_full = df[FEATURE_COLUMNS].to_numpy()

    X_train, X_test, y_train, y_test = train_test_split(
        X_full, y, test_size=0.25, random_state=42, stratify=y,
    )
    out_full = train_baselines(X_train, y_train, X_test, y_test, FEATURE_COLUMNS, seed=42)
    acc_full = out_full["results"]["random_forest"]["metrics"]["accuracy"]
    assert acc_full >= 0.95, (
        "se esperaba reproducir el resultado casi perfecto documentado en "
        "reports/metrics.json con las features completas"
    )

    cols_wo_label_inputs = [c for c in FEATURE_COLUMNS if c not in ("mouse_efficiency", "mouse_mean_velocity")]
    X_reduced = df[cols_wo_label_inputs].to_numpy()
    Xr_train, Xr_test, yr_train, yr_test = train_test_split(
        X_reduced, y, test_size=0.25, random_state=42, stratify=y,
    )
    out_reduced = train_baselines(Xr_train, yr_train, Xr_test, yr_test, cols_wo_label_inputs, seed=42)
    acc_reduced = out_reduced["results"]["random_forest"]["metrics"]["accuracy"]
    assert acc_reduced < acc_full, (
        "quitar las dos columnas que generan la etiqueta sintética debe bajar el "
        "accuracy -- si no baja, la explicación de 'accuracy perfecto por "
        "construcción de la etiqueta, no por señal real' dejó de ser válida y "
        "hay que revisar de nuevo por qué RF da 1.0"
    )
