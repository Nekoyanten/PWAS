/**
 * Captura biométrica facial — señales derivadas para medir duda/hesitación
 * (extensión fuera del alcance original de TG §8.2 Fase 1; ver
 * docs/2026-09-12_captura-facial-biometrica.md para el porqué y el
 * consentimiento separado que la habilita).
 *
 * Qué hace: si el participante dio el consentimiento de cámara (checkbox
 * SEPARADO del consentimiento general, ver renderWelcome en decoy.js), pide
 * acceso a la cámara y usa MediaPipe FaceLandmarker (procesamiento 100% LOCAL
 * en el navegador, vía WebAssembly — ningún frame de video sale nunca de este
 * dispositivo) para derivar, ~15 veces por segundo, 5 señales escalares:
 * apertura ocular, parpadeo, mirada horizontal/vertical, tensión de ceja y
 * tensión de boca. Solo esas 5 señales (más una marca de tiempo) se envían al
 * servidor, en lotes, igual que behavior-capture.js.
 *
 * Qué NUNCA hace: no envía ni guarda video, imágenes, capturas de pantalla,
 * ni los 478 landmarks 3D o los 52 blendshapes crudos que produce MediaPipe.
 * Solo los 5 escalares derivados descritos arriba. Es el mismo invariante de
 * privacidad de este proyecto ("ninguna pantalla captura contenido escrito
 * por el participante", ver cabecera de apps/api/src/lib/decoy.js) llevado al
 * dominio facial: se guarda la señal mínima necesaria para el análisis, nunca
 * la fuente de la que se deriva.
 *
 * Transparencia activa: mientras la cámara está en uso se muestra un aviso
 * fijo y visible en pantalla ("🎥 Captura facial activa"), en el que el
 * propio participante puede hacer clic para pausar/reanudar la captura en
 * cualquier momento — el consentimiento inicial no agota su derecho a
 * interrumpirla.
 *
 * Cómo se activa: <script src="/js/facial-capture.js"> con los mismos
 * atributos data-* que behavior-capture.js (data-token, data-phase,
 * data-delivery-id opcional) MÁS data-camera-consent="1", que el servidor
 * solo emite cuando participants.camera_consent_given = TRUE (ver
 * facialCaptureTag en decoy.js). Si falta cualquiera de estos, o el
 * navegador no soporta getUserMedia/crypto.randomUUID, o el participante
 * niega el permiso de cámara, o MediaPipe no carga (red, WebAssembly no
 * soportado, etc.): el script no hace NADA más, en absoluto silencio — nunca
 * debe romper la experiencia del participante ni el piloto, exactamente el
 * mismo criterio que ya rige behavior-capture.js.
 */
(function () {
  "use strict";

  var scriptEl = document.currentScript;
  if (!scriptEl) return;
  var TOKEN = scriptEl.getAttribute("data-token");
  var PHASE = scriptEl.getAttribute("data-phase");
  if (!TOKEN || !PHASE) return;
  if (scriptEl.getAttribute("data-camera-consent") !== "1") return; // sin consentimiento de cámara: no se pide permiso, no se carga nada.
  var DELIVERY_ID = scriptEl.getAttribute("data-delivery-id") || null;

  if (typeof crypto === "undefined" || !crypto.randomUUID) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  var VISION_VERSION = "1.0.1"; // @mediapipe/tasks-vision, confirmado vía npm registry.
  var VISION_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + VISION_VERSION + "/vision_bundle.mjs";
  var VISION_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + VISION_VERSION + "/wasm";
  // Modelo oficial de Google (float16, la variante liviana recomendada para
  // web) -- URL confirmada contra el código fuente de la muestra oficial
  // google-ai-edge/mediapipe-samples-web (src/tasks/face-landmarker.ts).
  var MODEL_ASSET_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  var ENDPOINT = "/t/" + encodeURIComponent(TOKEN) + "/facial";
  var SESSION_ID = crypto.randomUUID();
  var TICK_MIN_INTERVAL_MS = 66; // ~15 Hz -- suficiente para no perder parpadeos (150-400 ms de duración típica) sin saturar CPU/red.
  var FLUSH_INTERVAL_MS = 2500;
  var FLUSH_MAX_SAMPLES = 90;
  var MAX_SAMPLES_PER_REQUEST = 200; // debe calzar con el límite que valida el servidor (ver tracking.js).
  var BLINK_EYE_OPENNESS_THRESHOLD = 0.4; // bajo esto se considera "ojo cerrado" en esa muestra.

  var t0 = performance.now();
  var buffer = [];
  var lastTickAt = 0;
  var paused = false;
  var stream = null;
  var video = null;
  var faceLandmarker = null;
  var rafId = null;
  var badge = null;

  function now() {
    return Math.round(performance.now() - t0);
  }

  // Busca una categoría de blendshape por nombre (ARKit-compatible); 0 si no
  // está presente en este frame (p.ej. mientras el rostro no se detecta bien).
  function bs(categories, name) {
    for (var i = 0; i < categories.length; i++) {
      if (categories[i].categoryName === name) return categories[i].score;
    }
    return 0;
  }

  function push(sample) {
    buffer.push(sample);
    if (buffer.length >= FLUSH_MAX_SAMPLES) flush();
  }

  // --- fetchLater(): mismo polyfill que behavior-capture.js (entrega
  // diferida y confiable del último lote pendiente al ocultar la pestaña).
  if (!globalThis.fetchLater) {
    globalThis.fetchLater = function (url, init) {
      init = init || {};
      var activated = false;
      function sendNow() {
        if (init.signal && init.signal.aborted) { destroy(); return; }
        if ("keepalive" in Request.prototype) {
          var initCopy = {};
          for (var k in init) if (k !== "activateAfter") initCopy[k] = init[k];
          initCopy.keepalive = true;
          fetch(url, initCopy);
          activated = true;
        } else {
          activated = navigator.sendBeacon(url, init.body);
        }
        destroy();
      }
      function destroy() {
        document.removeEventListener("visibilitychange", onHidden);
      }
      function onHidden() {
        if (document.hidden) sendNow();
      }
      document.addEventListener("visibilitychange", onHidden);
      if (init.signal) init.signal.addEventListener("abort", destroy);
      return { get activated() { return activated; } };
    };
  }

  var pendingAbort = null;

  function armFallback(samples) {
    if (pendingAbort) pendingAbort.abort();
    pendingAbort = new AbortController();
    try {
      globalThis.fetchLater(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(samples)),
        signal: pendingAbort.signal,
      });
    } catch (e) {
      // Cupo de fetchLater excedido u otro error: no hay respaldo para este
      // lote, pero el flush periódico normal sigue funcionando igual.
    }
  }

  function buildPayload(samples) {
    return {
      session_id: SESSION_ID,
      phase: PHASE,
      delivery_id: DELIVERY_ID,
      camera_w: video ? video.videoWidth : null,
      camera_h: video ? video.videoHeight : null,
      samples: samples,
    };
  }

  function flush() {
    if (buffer.length === 0) return;
    var samples = buffer.slice(0, MAX_SAMPLES_PER_REQUEST);
    buffer = buffer.slice(samples.length);
    var payload = buildPayload(samples);
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(function () {
      // Un lote perdido no es crítico (son miles de muestras); no reintentamos
      // para no complicar el orden temporal de t_ms.
    });
    if (buffer.length) armFallback(buffer.slice());
  }

  // --- Aviso visible + control de pausa/reanudación por el participante ---
  function makeBadge() {
    var el = document.createElement("div");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:99999;" +
      "background:#1a1a1a;color:#fff;font:600 12px/1.3 system-ui,sans-serif;" +
      "padding:.5rem .75rem;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);" +
      "cursor:pointer;user-select:none;display:flex;align-items:center;gap:.4rem;opacity:.92";
    function paint() {
      el.textContent = (paused ? "⏸️ " : "🎥 ") + "Captura facial " + (paused ? "pausada" : "activa") + " — clic para " + (paused ? "reanudar" : "pausar");
    }
    paint();
    function toggle() {
      paused = !paused;
      if (video) {
        stream.getVideoTracks().forEach(function (t) { t.enabled = !paused; });
      }
      paint();
    }
    el.addEventListener("click", toggle);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    document.body.appendChild(el);
    return el;
  }

  function tick(tsMs) {
    rafId = requestAnimationFrame(tick);
    if (paused || document.hidden || !faceLandmarker) return;
    if (tsMs - lastTickAt < TICK_MIN_INTERVAL_MS) return;
    lastTickAt = tsMs;
    if (video.readyState < 2) return; // aún sin el primer frame decodificado.

    var result;
    try {
      result = faceLandmarker.detectForVideo(video, tsMs);
    } catch (e) {
      return; // frame ocasional inválido: se descarta, no se rompe el loop.
    }
    var shapes = result && result.faceBlendshapes && result.faceBlendshapes[0]
      ? result.faceBlendshapes[0].categories
      : null;

    if (!shapes) {
      push({ t: now(), fd: false });
      return;
    }

    var eyeOpenness = 1 - (bs(shapes, "eyeBlinkLeft") + bs(shapes, "eyeBlinkRight")) / 2;
    var gazeX = ((bs(shapes, "eyeLookOutLeft") + bs(shapes, "eyeLookInRight")) -
                 (bs(shapes, "eyeLookInLeft") + bs(shapes, "eyeLookOutRight"))) / 2;
    var gazeY = ((bs(shapes, "eyeLookDownLeft") + bs(shapes, "eyeLookDownRight")) -
                 (bs(shapes, "eyeLookUpLeft") + bs(shapes, "eyeLookUpRight"))) / 2;
    var browTension = (bs(shapes, "browDownLeft") + bs(shapes, "browDownRight") + bs(shapes, "browInnerUp")) / 3;
    var mouthTension = (bs(shapes, "mouthPressLeft") + bs(shapes, "mouthPressRight") +
                         bs(shapes, "mouthStretchLeft") + bs(shapes, "mouthStretchRight")) / 4;

    push({
      t: now(),
      fd: true,
      eo: Math.round(eyeOpenness * 1000) / 1000,
      bl: eyeOpenness < BLINK_EYE_OPENNESS_THRESHOLD,
      gx: Math.round(gazeX * 1000) / 1000,
      gy: Math.round(gazeY * 1000) / 1000,
      bt: Math.round(browTension * 1000) / 1000,
      mt: Math.round(mouthTension * 1000) / 1000,
    });
  }

  function stopEverything() {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (faceLandmarker && faceLandmarker.close) {
      try { faceLandmarker.close(); } catch (e) { /* no-op */ }
    }
  }

  async function init() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      return; // permiso denegado, sin cámara disponible, cámara en uso por otra app, etc. -- silencio total.
    }

    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px";
    video.srcObject = stream;
    document.body.appendChild(video);
    try {
      await video.play();
    } catch (e) {
      stopEverything();
      return;
    }

    var vision;
    try {
      var mod = await import(/* webpackIgnore: true */ VISION_BUNDLE_URL);
      vision = await mod.FilesetResolver.forVisionTasks(VISION_WASM_URL);
      faceLandmarker = await mod.FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_ASSET_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
    } catch (e) {
      // Red lenta/CDN bloqueado/WebAssembly o WebGL no soportado: no hay
      // captura facial en este dispositivo, pero el piloto sigue su curso
      // normalmente con el resto de las señales (mouse/teclado).
      stopEverything();
      return;
    }

    badge = makeBadge();
    rafId = requestAnimationFrame(tick);
    setInterval(flush, FLUSH_INTERVAL_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) flush();
    });
    window.addEventListener("pagehide", function () {
      flush();
      stopEverything();
    });
  }

  init();
})();
