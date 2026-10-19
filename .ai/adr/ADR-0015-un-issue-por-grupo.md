# ADR-0015: Un issue de GitHub por grupo externo

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Sentry ya agrupa eventos por su propio issue. PostHog puede repetir el mismo hallazgo cada seis horas. Un issue nuevo por evento o por barrido es ruido.

## Decisión

Sentry: un issue de GitHub por `sentry_issue_id`, durante toda la vida de ese id. Un evento nuevo actualiza conteos y, si hace falta, la evidencia. No abre otro issue. Si el issue de GitHub está cerrado y llega otro evento aceptado, el servicio lo reabre y comenta.

PostHog: un issue de GitHub por `dedupe_key` (tipo, pathname y firma definidos en la especificación), también de por vida. El barrido siguiente actualiza el bloque de conteos o comenta. Si está cerrado, lo reabre.

El servicio no calcula otro fingerprint encima del de Sentry.

## Alternativas consideradas

- Un issue por evento. Se llena el repositorio.
- Cerrar el ciclo a los 14 días y abrir un issue nuevo. Parte el hilo que diseño y el fix necesitan.
- Reagrupar por mensaje normalizado además del id de Sentry. Puede juntar causas distintas o separar el mismo bug.

## Consecuencias

- Un grupo ruidoso ocupa un solo issue, que puede crecer en comentarios si el bloque propio ya no coincide.
- Reabrir un issue cerrado es el comportamiento esperado ante una regresión, no un accidente.
- La deduplicación de PostHog no usa texto libre del usuario.

## Reabrir si

Sentry parte un mismo fallo en varios issues y hace falta una clave propia, o un hallazgo de producto debe conservar el issue cerrado y abrir uno nuevo.
