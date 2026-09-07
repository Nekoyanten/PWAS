"""Baselines tabulares: SVM, Random Forest, XGBoost (TG §8.2.4 primera mitad).

Se mantienen sin cambios respecto al plan original: siguen siendo la opción
apropiada para datos tabulares de este tamaño — rápidos, interpretables
(importancia de features) y, según la literatura revisada (ver
docs/2026-09-06_pipeline-ml-offline.md), siguen siendo competitivos frente a
arquitecturas más nuevas para este tipo de dato. Lo que sí cambió es la
arquitectura temporal (ver `temporal_model.py`).
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from xgboost import XGBClassifier


def _metrics(y_true, y_pred, y_score) -> dict:
    out = {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
    }
    # roc_auc_score exige las dos clases presentes en y_true; con datasets
    # de prueba muy chicos (o desbalanceados por el split) puede faltar una
    # -- se reporta None en vez de reventar el pipeline completo.
    try:
        out["roc_auc"] = float(roc_auc_score(y_true, y_score))
    except ValueError:
        out["roc_auc"] = None
    return out


def train_baselines(X_train: np.ndarray, y_train: np.ndarray, X_test: np.ndarray, y_test: np.ndarray,
                     feature_names: list[str], seed: int = 42) -> dict:
    scaler = StandardScaler().fit(X_train)
    X_train_s = scaler.transform(X_train)
    X_test_s = scaler.transform(X_test)

    results: dict[str, dict] = {}

    svm = SVC(kernel="rbf", probability=True, random_state=seed)
    svm.fit(X_train_s, y_train)
    svm_score = svm.predict_proba(X_test_s)[:, 1]
    results["svm"] = {
        "metrics": _metrics(y_test, svm.predict(X_test_s), svm_score),
        "scores": svm_score.tolist(),
    }

    rf = RandomForestClassifier(n_estimators=200, random_state=seed, max_depth=6)
    rf.fit(X_train, y_train)
    rf_score = rf.predict_proba(X_test)[:, 1]
    results["random_forest"] = {
        "metrics": _metrics(y_test, rf.predict(X_test), rf_score),
        "scores": rf_score.tolist(),
        "feature_importance": dict(zip(feature_names, rf.feature_importances_.tolist())),
    }

    xgb = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.1, random_state=seed,
        eval_metric="logloss", verbosity=0,
    )
    xgb.fit(X_train, y_train)
    xgb_score = xgb.predict_proba(X_test)[:, 1]
    results["xgboost"] = {
        "metrics": _metrics(y_test, xgb.predict(X_test), xgb_score),
        "scores": xgb_score.tolist(),
        "feature_importance": dict(zip(feature_names, xgb.feature_importances_.tolist())),
    }

    return {
        "results": results,
        "models": {"svm": svm, "random_forest": rf, "xgboost": xgb, "scaler": scaler},
        "y_test": y_test.tolist(),
    }
