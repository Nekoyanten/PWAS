---
name: minimalist-dashboard-design
description: Diseña dashboards y herramientas digitales minimalistas, serenas y elegantes, con jerarquia visual clara, baja friccion cognitiva y controles accesibles. Usar al crear o mejorar interfaces operativas, paneles administrativos, tablas, formularios, metricas y herramientas internas.
---

# Diseno minimalista sereno

Crea interfaces que transmitan calma mediante orden, ritmo y claridad. La elegancia debe venir de la precision del sistema, no de adornos, gradientes llamativos o exceso de espacio vacio.

## Principios

- Prioriza la tarea principal y reduce decisiones visibles al minimo necesario.
- Usa una jerarquia de tres niveles: contexto, accion principal y detalle.
- Agrupa elementos por proximidad y alinea todo con una reticula consistente.
- Mantén una densidad comoda para lectura y trabajo repetitivo; no conviertas cada bloque en una tarjeta.
- Usa contraste, peso tipografico y espacio para separar contenido antes que bordes o sombras.
- Haz que cada estado sea comprensible: carga, vacio, exito, advertencia, error y sin permisos.
- Conserva patrones familiares y evita redisenar controles conocidos sin una razon funcional.

## Direccion visual

- Define variables de diseno para fondo, superficie, texto, texto secundario, borde, acento y estados.
- Prefiere fondos claros y ligeramente tintados, superficies limpias y un acento sobrio. Evita el morado como color dominante.
- Usa una paleta con un color de acento, un color de soporte y estados semanticos claramente distinguibles.
- Mantén sombras suaves y pequenas; evita brillos, glassmorphism, blobs decorativos y gradientes como protagonista.
- Usa bordes de 1px y radios discretos, normalmente de 4 a 8px.
- Elige una tipografia con personalidad legible, no la pila predeterminada. Usa una familia para texto y, solo si aporta valor, otra para titulos o datos.
- Mantén el espaciado en una escala consistente, por ejemplo 4, 8, 12, 16, 24 y 32px.
- No uses mayusculas extensas ni letter-spacing negativo. Ajusta el tamano al contexto y no escales la fuente con el viewport.

## Estructura de dashboards

- Presenta primero el nombre de la vista, su contexto temporal y la accion primaria.
- Ordena las metricas por importancia y acompanalas con periodo de comparacion y tendencia, no solo con un numero grande.
- Reserva las tarjetas para metricas resumidas o elementos repetidos. Las secciones principales deben sentirse como una pagina continua.
- Usa tablas para comparar; alinea numeros a la derecha, conserva encabezados visibles y permite estados de fila claros.
- Usa una navegacion estable, breve y facil de escanear. En movil, conviertela en un patron tactil evidente.
- Mantén filtros cerca del contenido que modifican y muestra los filtros activos de forma removible.
- Para acciones destructivas o irreversibles, pide confirmacion con lenguaje especifico y ofrece una salida segura.

## Componentes y controles

- Usa iconos reconocibles dentro de botones de herramientas y agrega tooltip para iconos no obvios.
- Usa botones con texto solo para comandos que necesiten claridad; para editar, buscar, cerrar, descargar o navegar, prefiere el icono familiar cuando el contexto sea suficiente.
- Usa tabs para vistas hermanas, controles segmentados para modos y menus para conjuntos de opciones.
- Usa switches o checkboxes para valores binarios, inputs para valores numericos y sliders solo cuando el ajuste continuo sea natural.
- Mantén dimensiones estables para botones, tablas, contadores, tiles y barras de herramientas, evitando saltos al cargar contenido.
- Muestra validacion junto al campo, conserva el valor introducido y explica como corregir el error.
- Los estados hover, focus, active y disabled deben ser visibles sin depender solo del color.

## Responsive y accesibilidad

- Diseña primero el flujo de trabajo, no solo la version de escritorio. En pantallas pequenas, prioriza contenido y acciones antes que decoracion.
- Usa reticulas, `minmax`, `clamp` solo para dimensiones apropiadas y restricciones que eviten desbordamientos.
- Nunca permitas que etiquetas, botones, numeros o mensajes se superpongan; prueba textos largos y traducciones.
- Respeta teclado, foco visible, orden logico, areas tactiles suficientes y contraste WCAG AA.
- No comuniques estados solo con rojo y verde; incluye texto, icono o patron adicional.
- Proporciona etiquetas accesibles, nombres para controles icon-only y alternativas para graficos.
- Considera `prefers-reduced-motion` y evita animaciones que distraigan de la tarea.

## Movimiento y atmosfera

- Usa una entrada breve y discreta para revelar la estructura principal.
- Anima cambios de estado y progreso con transiciones cortas; no animes cada elemento por separado sin proposito.
- Prefiere transiciones de opacidad y desplazamientos pequenos. Respeta la reduccion de movimiento.
- Construye atmosfera con ritmo, textura sutil o una variacion tonal controlada, nunca con decoracion que compita con los datos.

## Criterios de calidad

Antes de entregar, comprueba:

1. La accion primaria se identifica en pocos segundos.
2. La interfaz sigue siendo legible con datos largos, vacios y errores.
3. La jerarquia funciona sin depender de sombras, color o animacion.
4. Los controles son navegables con teclado y tienen foco visible.
5. La vista mantiene sus proporciones en escritorio y movil sin solapamientos.
6. Los graficos y metricas explican periodo, unidad y significado.
7. El resultado se siente sobrio y distintivo, no como una plantilla generica.

## Formato de entrega

Cuando implementes una interfaz, explica brevemente la direccion visual elegida, los componentes principales y cualquier supuesto. Entrega estados completos y prueba al menos un viewport movil y uno de escritorio cuando exista un entorno de ejecucion.
