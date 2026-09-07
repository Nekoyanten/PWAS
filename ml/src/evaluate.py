"""Corrida de punta a punta del pipeline sobre los datos REALES ya
capturados (44 sesiones, 2418 eventos, producción/Supabase al 6 de
septiembre de 2026) con etiquetas SINTÉTICAS (ver dataset.synthetic_labels).

Esto NO es una evaluación científica del modelo -- es la prueba mecánica de
que el pipeline completo (datos reales -> features -> baselines -> modelo
temporal -> ONNX) corre de punta a punta sin errores y produce resultados
coherentes. Ejecutar:

    cd ml && source .venv/bin/activate && python3 -m src.evaluate

Genera `reports/metrics.json` y varias imágenes PNG en `reports/`.
"""
from __future__ import annotations

import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import confusion_matrix, roc_curve
from sklearn.model_selection import train_test_split

from .baselines import train_baselines
from .dataset import build_feature_table, build_sequences, load_export, synthetic_labels, FEATURE_COLUMNS
from .export_onnx import export_and_verify
from .train import train_temporal_model

HERE = os.path.dirname(__file__)
DATA_PATH = os.path.join(HERE, "..", "data", "behavior_events_real.json")
REPORTS_DIR = os.path.join(HERE, "..", "reports")
SEED = 42


def run() -> dict:
    os.makedirs(REPORTS_DIR, exist_ok=True)
    rows = load_export(DATA_PATH)
    df = build_feature_table(rows)
    y = synthetic_labels(df, seed=SEED)
    X = df[FEATURE_COLUMNS].to_numpy()

    n_sessions = len(df)
    label_balance = {"n_sessions": n_sessions, "n_positive": int(y.sum()), "n_negative": int(n_sessions - y.sum())}

    # --- Baselines --------------------------------------------------------
    X_train, X_test, y_train, y_test, idx_train, idx_test = train_test_split(
        X, y, np.arange(n_sessions), test_size=0.25, random_state=SEED, stratify=y,
    )
    baseline_out = train_baselines(X_train, y_train, X_test, y_test, FEATURE_COLUMNS, seed=SEED)

    # ROC curves
    plt.figure(figsize=(5, 5))
    for name, r in baseline_out["results"].items():
        fpr, tpr, _ = roc_curve(y_test, r["scores"])
        auc = r["metrics"]["roc_auc"]
        label = f"{name} (AUC={auc:.2f})" if auc is not None else name
        plt.plot(fpr, tpr, label=label)
    plt.plot([0, 1], [0, 1], "k--", linewidth=0.8)
    plt.xlabel("Tasa de falsos positivos")
    plt.ylabel("Tasa de verdaderos positivos")
    plt.title("Baselines — curvas ROC (etiquetas sintéticas, N=%d)" % n_sessions)
    plt.legend()
    plt.tight_layout()
    plt.savefig(os.path.join(REPORTS_DIR, "roc_curves.png"), dpi=140)
    plt.close()

    # Confusion matrices
    fig, axes = plt.subplots(1, 3, figsize=(12, 4))
    for ax, (name, r) in zip(axes, baseline_out["results"].items()):
        preds = [1 if s >= 0.5 else 0 for s in r["scores"]]
        cm = confusion_matrix(y_test, preds)
        ax.imshow(cm, cmap="Blues")
        ax.set_title(name)
        for i in range(cm.shape[0]):
            for j in range(cm.shape[1]):
                ax.text(j, i, str(cm[i, j]), ha="center", va="center")
        ax.set_xlabel("Predicho"); ax.set_ylabel("Real")
        ax.set_xticks([0, 1]); ax.set_yticks([0, 1])
    plt.tight_layout()
    plt.savefig(os.path.join(REPORTS_DIR, "confusion_matrices.png"), dpi=140)
    plt.close()

    # Feature importance (RF y XGB)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, name in zip(axes, ("random_forest", "xgboost")):
        fi = baseline_out["results"][name]["feature_importance"]
        items = sorted(fi.items(), key=lambda kv: kv[1])
        ax.barh([k for k, _ in items], [v for _, v in items])
        ax.set_title(name)
    plt.tight_layout()
    plt.savefig(os.path.join(REPORTS_DIR, "feature_importance.png"), dpi=140)
    plt.close()

    # --- Modelo temporal ----------------------------------------------------
    session_ids, mouse_arr, mouse_mask, key_arr, key_mask, metas = build_sequences(rows)
    seq_labels = synthetic_labels(df.set_index("session_id").loc[session_ids].reset_index(), seed=SEED)

    temporal_out = train_temporal_model(mouse_arr, mouse_mask, key_arr, key_mask, seq_labels, epochs=40, seed=SEED)
    history = temporal_out["history"]

    plt.figure(figsize=(6, 4))
    plt.plot([h["epoch"] for h in history], [h["loss"] for h in history], label="loss (entrenamiento)")
    plt.plot([h["epoch"] for h in history], [h["train_accuracy"] for h in history], label="accuracy (entrenamiento)")
    plt.xlabel("Época"); plt.legend()
    plt.title("Modelo temporal (TCN + Transformer + fusión por atención)")
    plt.tight_layout()
    plt.savefig(os.path.join(REPORTS_DIR, "training_curve.png"), dpi=140)
    plt.close()

    # --- Exportación ONNX + paridad -----------------------------------------
    onnx_path = os.path.join(REPORTS_DIR, "jolting_risk_model.onnx")
    parity = export_and_verify(temporal_out["model"], temporal_out["example_inputs"], onnx_path, atol=1e-4)

    metrics = {
        "generated_at": "2026-09-06",
        "data_source": "Supabase (proyecto PWAS, producción) vía export_behavior_events — REAL, no sintético",
        "n_real_events": len(rows),
        "n_real_sessions": n_sessions,
        "labels": "SINTÉTICAS — ver dataset.synthetic_labels; no representan ninguna encuesta real (0 encuestas registradas al momento de esta corrida)",
        "label_balance": label_balance,
        "baselines": {k: v["metrics"] for k, v in baseline_out["results"].items()},
        "temporal_model": {
            "loss_first_epoch": history[0]["loss"],
            "loss_last_epoch": history[-1]["loss"],
            "train_accuracy_last_epoch": history[-1]["train_accuracy"],
            "architecture": "TCN (mouse) + Transformer compacto (teclado) + fusión por atención",
        },
        "onnx_export": {
            "ok": parity["ok"],
            "max_abs_diff_vs_pytorch": parity["max_abs_diff"],
            "opset": 17,
        },
    }
    with open(os.path.join(REPORTS_DIR, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)

    return metrics


if __name__ == "__main__":
    m = run()
    print(json.dumps(m, indent=2, ensure_ascii=False))
