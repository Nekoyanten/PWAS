// Pruebas unitarias del texto de debriefing (lib/survey.js), sin Postgres.
//
// El caso que motiva este archivo: debriefText() antes decía SIEMPRE "no se
// accedió a ninguna cámara, micrófono ni ubicación", sin importar si el
// participante había dado el consentimiento APARTE de cámara -- para quien sí
// lo dio, el debriefing le mentía sobre lo que en realidad pasó durante su
// propia sesión. Corregido pasando `camera_consent_given` como segundo
// argumento; estas pruebas fijan el contrato para que no se repita.
import { test } from "node:test";
import assert from "node:assert/strict";
import { debriefText } from "../../src/lib/survey.js";

test("debriefText sin consentimiento de cámara: dice que no hubo acceso real, aclara que el 'permiso' del ataque es decorativo", () => {
  const text = debriefText("autoridad", false);
  assert.match(text, /nunca concede acceso real a tu cámara, micrófono ni ubicación/);
  assert.doesNotMatch(text, /sí se usó tu\s*\ncámara/);
});

test("debriefText sin dar el segundo argumento (undefined) se comporta igual que false", () => {
  const text = debriefText("urgencia");
  assert.match(text, /nunca concede acceso real a tu cámara, micrófono ni ubicación/);
});

test("debriefText CON consentimiento de cámara: informa que sí se usó, y que el procesamiento fue local", () => {
  const text = debriefText("curiosidad", true);
  assert.match(text, /sí se usó tu\s*\ncámara durante la sesión/);
  assert.match(text, /dentro de tu propio navegador/);
  assert.match(text, /nunca se guardó ni se envió video/);
  assert.doesNotMatch(text, /nunca concede acceso real a tu cámara/);
});

test("debriefText sigue mencionando la técnica y la frase de simulación autorizada, con o sin cámara", () => {
  for (const cam of [true, false]) {
    const text = debriefText("escasez", cam);
    assert.match(text, /apelaba a la escasez/);
    assert.match(text, /simulaci[oó]n autorizada de ingenier[ií]a social/i);
  }
});
