// Definición de la encuesta post-sesión / debriefing (TG §9.5 Paso 6).
// La encuesta SE ADAPTA al vector de ataque que le tocó al participante:
// además de un bloque común, cada vector tiene una pregunta específica y una
// sugerencia de `fall_reason` acorde.
//
// Nada de lo que aquí se recoge es un dato personal: son autorreportes sobre
// la percepción del participante durante el ejercicio.

export const VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];

// fall_reason por defecto sugerido según el vector (el participante puede cambiarlo).
export const DEFAULT_REASON_BY_VECTOR = {
  autoridad: "confianza_remitente",
  urgencia: "urgencia_temporal",
  escasez: "promesa_beneficio",
  prueba_social: "prueba_social",
  curiosidad: "curiosidad",
};

// Pregunta específica por vector. `options` alimenta un <select>; el valor
// elegido se guarda en post_session_survey.vector_specific_answer.
export const VECTOR_QUESTION = {
  autoridad: {
    text: "El mensaje parecía provenir de una figura de autoridad (coordinación, dirección, sistemas). ¿Qué tanto influyó eso en que actuaras?",
    options: ["Fue determinante", "Influyó algo", "No influyó", "No lo noté"],
  },
  urgencia: {
    text: "El mensaje decía que debías actuar de inmediato o perderías el acceso/una oportunidad. ¿Qué tanto influyó esa urgencia?",
    options: ["Fue determinante", "Influyó algo", "No influyó", "No lo noté"],
  },
  escasez: {
    text: "El mensaje ofrecía algo limitado (cupos, tiempo, un beneficio). ¿Qué tanto influyó en que actuaras?",
    options: ["Fue determinante", "Influyó algo", "No influyó", "No lo noté"],
  },
  prueba_social: {
    text: "El mensaje decía que otros compañeros ya lo habían hecho. ¿Qué tanto influyó eso en tu decisión?",
    options: ["Fue determinante", "Influyó algo", "No influyó", "No lo noté"],
  },
  curiosidad: {
    text: "El mensaje mencionaba un documento o contenido interesante compartido contigo. ¿Qué tanto influyó la curiosidad?",
    options: ["Fue determinante", "Influyó algo", "No influyó", "No lo noté"],
  },
};

// Bloque común a todos los vectores.
export const COMMON_QUESTIONS = {
  perceived_suspicion_before_action: {
    text: "Antes de hacer clic o completar la acción, ¿algo te pareció sospechoso o fuera de lo normal?",
    options: [
      { value: "true", label: "Sí, sospeché algo" },
      { value: "false", label: "No, no sospeché nada" },
    ],
  },
  recognized_as_simulated: {
    text: "¿En algún momento pensaste que esta acción podía ser parte de una prueba o simulación?",
    options: [
      { value: "true", label: "Sí" },
      { value: "false", label: "No" },
    ],
  },
  fall_reason: {
    text: "Si actuaste (hiciste clic, llenaste el formulario o concediste un permiso), ¿cuál dirías que fue el motivo principal?",
    options: [
      { value: "no_aplica", label: "No actué / no apliqué" },
      { value: "miedo_sancion", label: "Miedo a una sanción o consecuencia" },
      { value: "promesa_beneficio", label: "Promesa de un beneficio" },
      { value: "confianza_remitente", label: "Confié en quién parecía enviarlo" },
      { value: "urgencia_temporal", label: "La urgencia / el poco tiempo" },
      { value: "prueba_social", label: "Otros ya lo habían hecho" },
      { value: "curiosidad", label: "Curiosidad" },
    ],
  },
};

// Texto de debriefing que se muestra DESPUÉS de enviar la encuesta.
export function debriefText(vector) {
  const vectorNombre = {
    autoridad: "apelaba a la autoridad",
    urgencia: "generaba urgencia",
    escasez: "apelaba a la escasez",
    prueba_social: "usaba prueba social",
    curiosidad: "despertaba curiosidad",
  }[vector] || "usaba una técnica de influencia";

  return `Durante este piloto participaste, además de en una prueba de usabilidad real,
en una <strong>simulación autorizada de ingeniería social</strong> de carácter académico.
Uno de los mensajes que recibiste dentro de la aplicación no era real: era un estímulo
diseñado para este estudio que <strong>${vectorNombre}</strong>.

No se recogió ninguna credencial, ningún dato personal, ni se accedió a ninguna
cámara, micrófono ni ubicación. Solo se registró tu <em>comportamiento</em> frente al
mensaje (si lo abriste, si hiciste clic, cuánto tardaste) de forma seudonimizada.

Que hayas interactuado con el mensaje simulado <strong>no significa nada negativo sobre ti</strong>:
estos estímulos están diseñados por profesionales para ser convincentes y todos somos
susceptibles según el contexto. El objetivo del estudio es entender qué técnicas
funcionan y por qué, para diseñar mejores formaciones y defensas.

Si tienes cualquier duda o quieres que tus datos se excluyan del análisis, contacta
con el equipo de investigación.`;
}

// Construye el esquema de la encuesta para un vector dado (lo consume el
// frontend de la página /t/:token/survey).
export function buildSurveySchema(vector) {
  return {
    vector,
    vector_question: VECTOR_QUESTION[vector] || VECTOR_QUESTION.autoridad,
    common: COMMON_QUESTIONS,
    default_reason: DEFAULT_REASON_BY_VECTOR[vector] || "no_aplica",
  };
}
