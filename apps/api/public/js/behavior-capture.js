/**
 * Captura conductual real — mouse y teclado (Tabla 1 §8.2.1, fila 1).
 *
 * Qué hace: mientras esta página está abierta, registra en memoria una
 * muestra por cada mousemove (limitado a ~25 Hz), mousedown/mouseup/click
 * (sin límite, son poco frecuentes) y keydown/keyup (solo la tecla FÍSICA,
 * ver más abajo), y las envía al servidor en lotes pequeños.
 *
 * Qué NUNCA hace: no lee ni envía el valor de ningún campo de formulario, ni
 * `event.key` (el carácter), ni el contenido de la página. Solo posiciones
 * de mouse, códigos de tecla física (`event.code`, p. ej. "KeyA") y
 * marcas de tiempo. Esto no es una decisión de este script: es un invariante
 * del proyecto entero (ver cabecera de apps/api/src/lib/decoy.js) — "ninguna
 * pantalla captura contenido escrito por el participante" — que este script
 * respeta por diseño, no por cuidado adicional.
 *
 * Cómo se activa: se incluye con <script src="/js/behavior-capture.js"> y
 * atributos data-* en el tag que lo carga:
 *   data-token       (obligatorio) — el access_token del participante.
 *   data-phase       (obligatorio) — 'app' | 'message' | 'landing' | 'survey'.
 *   data-delivery-id (opcional)    — a qué mensaje/ataque pertenece esta
 *                                    página, si aplica (para poder aislar
 *                                    después "la dinámica de mouse justo al
 *                                    exponerse a ESTE ataque").
 * Si falta token o phase, el script no hace nada (falla silencioso: nunca
 * debe romper la experiencia del participante ni el piloto).
 *
 * Entrega: cada ~2.5 s (o al juntar 120 muestras) se manda un lote por
 * fetch(). Además, después de cada lote se arma una entrega de respaldo con
 * fetchLater() para el lote siguiente (o el de cierre), de forma que si el
 * participante cierra la pestaña entre dos flushes, las últimas muestras no
 * se pierden. fetchLater() no tiene soporte universal todavía, así que se
 * usa un polyfill mínimo (fetch keepalive / sendBeacon) — ver comentario
 * junto a su definición.
 */
(function () {
  "use strict";

  var scriptEl = document.currentScript;
  if (!scriptEl) return;
  var TOKEN = scriptEl.getAttribute("data-token");
  var PHASE = scriptEl.getAttribute("data-phase");
  if (!TOKEN || !PHASE) return;
  var DELIVERY_ID = scriptEl.getAttribute("data-delivery-id") || null;

  if (typeof crypto === "undefined" || !crypto.randomUUID) return; // navegador demasiado viejo: no capturamos, no rompemos nada más.

  var ENDPOINT = "/t/" + encodeURIComponent(TOKEN) + "/behavior";
  var SESSION_ID = crypto.randomUUID();
  var MOUSEMOVE_MIN_INTERVAL_MS = 40; // ~25 Hz — suficiente para dinámica de mouse, evita saturar con los 100+ eventos/s nativos.
  var FLUSH_INTERVAL_MS = 2500;
  var FLUSH_MAX_SAMPLES = 120;
  var MAX_SAMPLES_PER_REQUEST = 300; // debe calzar con el límite que valida el servidor (ver tracking.js).

  var t0 = performance.now();
  var buffer = [];
  var lastMouseMoveAt = 0;

  function now() {
    return Math.round(performance.now() - t0);
  }

  function push(type, extra) {
    var sample = { t: now(), type: type };
    if (extra) {
      if (extra.x !== undefined) sample.x = extra.x;
      if (extra.y !== undefined) sample.y = extra.y;
      if (extra.code !== undefined) sample.code = extra.code;
    }
    buffer.push(sample);
    if (buffer.length >= FLUSH_MAX_SAMPLES) flush();
  }

  document.addEventListener("mousemove", function (e) {
    var ts = performance.now();
    if (ts - lastMouseMoveAt < MOUSEMOVE_MIN_INTERVAL_MS) return;
    lastMouseMoveAt = ts;
    push("mousemove", { x: e.clientX, y: e.clientY });
  }, { passive: true });

  ["mousedown", "mouseup", "click"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      push(type, { x: e.clientX, y: e.clientY });
    }, { passive: true });
  });

  // event.code = tecla física ("KeyA", "Backspace", "Enter"...). NUNCA
  // event.key (el carácter) ni el valor del campo donde ocurrió.
  ["keydown", "keyup"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      push(type, { code: e.code });
    }, { passive: true });
  });

  document.addEventListener("visibilitychange", function () {
    push(document.hidden ? "visibility_hidden" : "visibility_visible");
  });

  // --- fetchLater(): entrega diferida y confiable del último lote pendiente,
  // por si el participante cierra la pestaña entre dos flushes periódicos.
  // Polyfill mínimo para navegadores sin soporte nativo (fetch keepalive, o
  // sendBeacon si el request no admite keepalive) — no dispara nada por sí
  // mismo, solo arma la entrega para cuando la página se oculte.
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
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      samples: samples,
    };
  }

  function flush() {
    if (buffer.length === 0) return;
    var samples = buffer.slice(0, MAX_SAMPLES_PER_REQUEST);
    buffer = buffer.slice(samples.length);
    var payload = buildPayload(samples);
    // keepalive:true en TODOS los flushes (no solo en el de cierre): el
    // payload es minúsculo (unos KB) y así un flush que coincide con la
    // navegación a otra página no se cancela a mitad de camino.
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(function () {
      // Un lote perdido no es crítico para el piloto (son miles de muestras);
      // no reintentamos para no complicar el orden temporal de t_ms.
    });
    // El resto de lo acumulado mientras tanto queda como respaldo por si se
    // cierra la pestaña antes del próximo flush periódico.
    if (buffer.length) armFallback(buffer.slice());
  }

  setInterval(flush, FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) flush();
  });
})();
