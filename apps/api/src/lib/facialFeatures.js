// Etiquetado fino de la captura biométrica facial (migración 015 -- ver
// docs/2026-09-12_captura-facial-biometrica.md para el porqué de todo el
// módulo). Estructura DELIBERADAMENTE calcada de behaviorFeatures.js: mismo
// patrón de dos capas (facial_events crudo -> facial_session_features
// agregado), misma noción de "línea base personal si existe, poblacional si
// no" (computeCalibrationBaselines/baselineFor), mismo criterio de
// recálculo por lote a pedido (no en cada POST /facial) -- no porque sea la
// única forma posible de hacerlo, sino porque introducir una segunda
// convención donde ya existe una que funciona sería una complejidad
// gratuita para quien mantenga esto después.
//
// A diferencia de behaviorFeatures.js, esto NO es un puerto de un cálculo ya
// validado en Python -- son fórmulas nuevas, simples y documentadas aquí
// mismo, sobre los 5 escalares que ya deriva facial-capture.js en el
// navegador (ver ese archivo para de dónde sale cada uno). No hay reclamo de
// que sean unidades de acción FACS calibradas al pie de la letra: son
// proxies razonables para lo que pide la investigación (duda/hesitación) a
// partir de blendshapes de MediaPipe, pensados para análisis exploratorio y
// para alimentar el entrenamiento de un modelo más adelante (ml/), no como
// un resultado clínico.
import { query, withTransaction } from "../db.js";

export const FEATURE_VERSION = "js-facial-v1";

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.0;
}

function stdSample(xs) {
  if (xs.length < 2) return 0.0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// Piso de 1.0 para no dividir por (casi) cero al z-scorear -- mismo criterio
// que preprocess._safe_mean_std en behaviorFeatures.js.
function safeMeanStd(values) {
  if (values.length === 0) return [0.0, 1.0];
  const m = mean(values);
  const variance = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  return [m, std > 1e-9 ? std : 1.0];
}

function zscore(value, mean_, std) {
  return std ? (value - mean_) / std : 0.0;
}

// Cuenta parpadeos DISCRETOS a partir de la serie de `blink` (booleano por
// muestra, ~15 Hz): un parpadeo es un tramo de muestras consecutivas con
// blink=true, contado UNA vez por tramo (no una vez por muestra, o un solo
// parpadeo de 300 ms a 15 Hz contaría como 4-5 "parpadeos").
function countBlinkEvents(samplesInOrder) {
  let count = 0;
  let wasClosed = false;
  for (const s of samplesInOrder) {
    if (!s.face_detected) { wasClosed = false; continue; } // un corte de detección no cuenta como fin de parpadeo real.
    if (s.blink && !wasClosed) count += 1;
    wasClosed = !!s.blink;
  }
  return count;
}

// Calcula las features de UNA sesión a partir de sus muestras (ya ordenadas
// por t_ms). `samples`: {t_ms, face_detected, eye_openness, blink, gaze_x,
// gaze_y, brow_tension, mouth_tension}[].
export function facialSessionFeatures(samples) {
  const n = samples.length;
  const detected = samples.filter((s) => s.face_detected);
  const faceDetectedRatio = n > 0 ? detected.length / n : 0.0;

  const eyeOpenness = detected.map((s) => s.eye_openness).filter((v) => v != null);
  const gazeX = detected.map((s) => s.gaze_x).filter((v) => v != null);
  const gazeY = detected.map((s) => s.gaze_y).filter((v) => v != null);
  const browTension = detected.map((s) => s.brow_tension).filter((v) => v != null);
  const mouthTension = detected.map((s) => s.mouth_tension).filter((v) => v != null);

  const blinkCount = countBlinkEvents(samples);
  const tMin = n ? samples[0].t_ms : 0;
  const tMax = n ? samples[n - 1].t_ms : 0;
  const durationMin = Math.max(tMax - tMin, 0) / 60000;
  const blinkRatePerMin = durationMin > 0 ? blinkCount / durationMin : 0.0;

  return {
    n_samples: n,
    face_detected_ratio: faceDetectedRatio,
    blink_count: blinkCount,
    blink_rate_per_min: blinkRatePerMin,
    eye_openness_mean: mean(eyeOpenness),
    eye_openness_std: stdSample(eyeOpenness),
    gaze_dispersion_x: stdSample(gazeX),
    gaze_dispersion_y: stdSample(gazeY),
    gaze_mean_abs_x: mean(gazeX.map(Math.abs)),
    gaze_mean_abs_y: mean(gazeY.map(Math.abs)),
    brow_tension_mean: mean(browTension),
    brow_tension_std: stdSample(browTension),
    mouth_tension_mean: mean(mouthTension),
    mouth_tension_std: stdSample(mouthTension),
  };
}

// Línea base de calibración -- mismo patrón que computeCalibrationBaselines
// en behaviorFeatures.js: una entrada "personal" por participant_campaign_id
// con sesión phase='calibration' (y cámara activa) en el lote, más
// "__population__" sobre TODAS las sesiones del lote.
export function computeCalibrationBaselines(sessions) {
  const byPcCalibration = new Map();
  for (const [, { meta, samples }] of sessions) {
    if (meta.phase === "calibration" && meta.participant_campaign_id) {
      byPcCalibration.set(meta.participant_campaign_id, facialSessionFeatures(samples));
    }
  }

  const baselines = new Map();
  for (const [pc, f] of byPcCalibration) {
    baselines.set(pc, {
      blink_rate_mean: f.blink_rate_per_min, blink_rate_std: f.blink_rate_per_min > 0 ? f.blink_rate_per_min : 1.0,
      brow_tension_mean: f.brow_tension_mean, brow_tension_std: f.brow_tension_std || 1.0,
      mouth_tension_mean: f.mouth_tension_mean, mouth_tension_std: f.mouth_tension_std || 1.0,
      gaze_dispersion_x_mean: f.gaze_dispersion_x, gaze_dispersion_x_std: f.gaze_dispersion_x || 1.0,
      source: "personal",
    });
  }

  const allBlinkRates = [], allBrow = [], allMouth = [], allGazeDispX = [];
  for (const [, { samples }] of sessions) {
    const f = facialSessionFeatures(samples);
    if (f.n_samples === 0) continue;
    allBlinkRates.push(f.blink_rate_per_min);
    allBrow.push(f.brow_tension_mean);
    allMouth.push(f.mouth_tension_mean);
    allGazeDispX.push(f.gaze_dispersion_x);
  }
  const [brMean, brStd] = safeMeanStd(allBlinkRates);
  const [btMean, btStd] = safeMeanStd(allBrow);
  const [mtMean, mtStd] = safeMeanStd(allMouth);
  const [gdMean, gdStd] = safeMeanStd(allGazeDispX);
  baselines.set("__population__", {
    blink_rate_mean: brMean, blink_rate_std: brStd,
    brow_tension_mean: btMean, brow_tension_std: btStd,
    mouth_tension_mean: mtMean, mouth_tension_std: mtStd,
    gaze_dispersion_x_mean: gdMean, gaze_dispersion_x_std: gdStd,
    source: "poblacional",
  });
  return baselines;
}

export function baselineFor(participantCampaignId, baselines) {
  if (participantCampaignId && baselines.has(participantCampaignId)) {
    return baselines.get(participantCampaignId);
  }
  return baselines.get("__population__");
}

export function computeFacialSessionFeatureRecord(sessionId, meta, samples, baselines) {
  const f = facialSessionFeatures(samples);
  const b = baselineFor(meta.participant_campaign_id, baselines);
  return {
    session_id: sessionId,
    participant_campaign_id: meta.participant_campaign_id,
    phase: meta.phase,
    features: f,
    blink_rate_per_min_z: zscore(f.blink_rate_per_min, b.blink_rate_mean, b.blink_rate_std),
    brow_tension_mean_z: zscore(f.brow_tension_mean, b.brow_tension_mean, b.brow_tension_std),
    mouth_tension_mean_z: zscore(f.mouth_tension_mean, b.mouth_tension_mean, b.mouth_tension_std),
    gaze_dispersion_x_z: zscore(f.gaze_dispersion_x, b.gaze_dispersion_x_mean, b.gaze_dispersion_x_std),
    baseline_z_source: b.source,
  };
}

// ---------------------------------------------------------------------------
// Integración con Postgres: recalcula y persiste las features de TODAS las
// sesiones faciales (o las de una campaña, con `campaignId`) en una sola
// pasada. Igual que recomputeSessionFeatures en behaviorFeatures.js: dentro
// de una transacción, o quedan todas las filas de esta pasada o ninguna.
// ---------------------------------------------------------------------------
export async function recomputeFacialSessionFeatures({ campaignId } = {}) {
  const params = [];
  let where = "";
  if (campaignId) {
    params.push(campaignId);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `SELECT fs.id AS session_id, pc.id AS participant_campaign_id, fs.phase,
            fe.t_ms, fe.face_detected, fe.eye_openness, fe.blink, fe.gaze_x, fe.gaze_y,
            fe.brow_tension, fe.mouth_tension
     FROM facial_events fe
     JOIN facial_sessions fs      ON fs.id = fe.facial_session_id
     JOIN participant_campaign pc ON pc.id = fs.participant_campaign_id
     ${where}
     ORDER BY fs.id, fe.t_ms`,
    params
  );

  const sessions = new Map();
  for (const row of result.rows) {
    if (!sessions.has(row.session_id)) {
      sessions.set(row.session_id, {
        meta: { participant_campaign_id: row.participant_campaign_id, phase: row.phase },
        samples: [],
      });
    }
    sessions.get(row.session_id).samples.push({
      t_ms: row.t_ms, face_detected: row.face_detected,
      eye_openness: row.eye_openness, blink: row.blink,
      gaze_x: row.gaze_x, gaze_y: row.gaze_y,
      brow_tension: row.brow_tension, mouth_tension: row.mouth_tension,
    });
  }
  if (sessions.size === 0) return { computed: 0, campaign_id: campaignId || null };

  const baselines = computeCalibrationBaselines(sessions);
  const records = [];
  for (const [sessionId, { meta, samples }] of sessions) {
    records.push(computeFacialSessionFeatureRecord(sessionId, meta, samples, baselines));
  }

  await withTransaction(async (client) => {
    for (const rec of records) {
      const f = rec.features;
      await client.query(
        `INSERT INTO facial_session_features (
           session_id, participant_campaign_id, phase,
           n_samples, face_detected_ratio, blink_count, blink_rate_per_min,
           eye_openness_mean, eye_openness_std,
           gaze_dispersion_x, gaze_dispersion_y, gaze_mean_abs_x, gaze_mean_abs_y,
           brow_tension_mean, brow_tension_std, mouth_tension_mean, mouth_tension_std,
           blink_rate_per_min_z, brow_tension_mean_z, mouth_tension_mean_z, gaze_dispersion_x_z,
           baseline_z_source, feature_version, computed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
         ON CONFLICT (session_id) DO UPDATE SET
           participant_campaign_id = EXCLUDED.participant_campaign_id,
           phase = EXCLUDED.phase,
           n_samples = EXCLUDED.n_samples,
           face_detected_ratio = EXCLUDED.face_detected_ratio,
           blink_count = EXCLUDED.blink_count,
           blink_rate_per_min = EXCLUDED.blink_rate_per_min,
           eye_openness_mean = EXCLUDED.eye_openness_mean,
           eye_openness_std = EXCLUDED.eye_openness_std,
           gaze_dispersion_x = EXCLUDED.gaze_dispersion_x,
           gaze_dispersion_y = EXCLUDED.gaze_dispersion_y,
           gaze_mean_abs_x = EXCLUDED.gaze_mean_abs_x,
           gaze_mean_abs_y = EXCLUDED.gaze_mean_abs_y,
           brow_tension_mean = EXCLUDED.brow_tension_mean,
           brow_tension_std = EXCLUDED.brow_tension_std,
           mouth_tension_mean = EXCLUDED.mouth_tension_mean,
           mouth_tension_std = EXCLUDED.mouth_tension_std,
           blink_rate_per_min_z = EXCLUDED.blink_rate_per_min_z,
           brow_tension_mean_z = EXCLUDED.brow_tension_mean_z,
           mouth_tension_mean_z = EXCLUDED.mouth_tension_mean_z,
           gaze_dispersion_x_z = EXCLUDED.gaze_dispersion_x_z,
           baseline_z_source = EXCLUDED.baseline_z_source,
           feature_version = EXCLUDED.feature_version,
           computed_at = now()`,
        [
          rec.session_id, rec.participant_campaign_id, rec.phase,
          f.n_samples, f.face_detected_ratio, f.blink_count, f.blink_rate_per_min,
          f.eye_openness_mean, f.eye_openness_std,
          f.gaze_dispersion_x, f.gaze_dispersion_y, f.gaze_mean_abs_x, f.gaze_mean_abs_y,
          f.brow_tension_mean, f.brow_tension_std, f.mouth_tension_mean, f.mouth_tension_std,
          rec.blink_rate_per_min_z, rec.brow_tension_mean_z, rec.mouth_tension_mean_z, rec.gaze_dispersion_x_z,
          rec.baseline_z_source, FEATURE_VERSION,
        ]
      );
    }
  });

  return { computed: records.length, campaign_id: campaignId || null };
}
