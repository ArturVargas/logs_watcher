# ADR-0013: PostHog solo publica agregados

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Las sesiones y las propiedades de persona pueden llevar correo, texto libre y identificadores. Esos datos no deben acabar en un issue de GitHub ni en un prompt.

## Decisión

La vía PostHog no descarga grabaciones, no selecciona `distinct_id`, correo, IP ni propiedades de persona, y no envía resultados al modelo. El texto del issue sale de una plantilla con conteos, nombre de evento, tipo de excepción y pathname sin query string.

Las consultas piden `count()` y `count(DISTINCT person_id)`. `person_id` solo existe dentro de PostHog para agregar. No se guarda ni se publica.

No se pone el enlace de la grabación en el issue. La fase 1 no almacena blobs de replay.

El texto visible de un elemento (inner text) no entra en la clave de deduplicación. Para clics se usa el tag del elemento.

## Alternativas consideradas

- Enlazar la replay en el issue para que diseño vea la sesión. Quien tenga acceso de lectura al repositorio vería la sesión.
- Resumir la sesión con el modelo. Saca PII del VPS y trata la sesión como prompt.
- Guardar el `distinct_id` para no duplicar hallazgos. El marcador por ruta y tipo ya deduplica, sin identificar a la persona.

## Consecuencias

- Diseño ve magnitud y lugar, no la sesión. Si más adelante hace falta la replay, será otro ADR y no un enlace pegado en el issue.
- Con `funnels` o `validationEvents` vacíos esas consultas no se inventan: se omiten.
- Un error de PostHog no crea un issue con el cuerpo crudo de la respuesta.

## Reabrir si

Diseño no puede actuar solo con agregados, y hay una forma acordada de compartir sesiones sin dejarlas en GitHub.
