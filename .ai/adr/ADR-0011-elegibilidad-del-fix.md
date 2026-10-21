# ADR-0011: El auto-fix solo cubre tres clases

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: La fase 1 abre un PR de arreglo para los fallos reales y no debe abrir PRs por ruido, por telemetría o por evidencia incompleta. PostHog no se arregla solo en esta fase.

## Decisión

Un fallo real, a efectos del PR automático, es un evento de Sentry que pasó los filtros y cuya clase es `blocker`, `truncated` o `flow-blocked`.

Esas tres clases encolan `propose_fix`. `non-blocking`, `no-user-impact` y `unclassified` abren o actualizan el issue con la etiqueta `auto-fix:no` y no encolan fix.

Los hallazgos de PostHog nunca encolan fix.

Si `testCommand` es null, el PR de fix se abre igual cuando la clase es elegible, con la etiqueta `tests:missing`, y el servicio no ejecuta pruebas. Si hay un layout de tests en el repositorio, el parche tiene que incluir un test nuevo; si no hay layout, `newTests` va vacío.

## Alternativas consideradas

- Abrir un PR para todas las clases, incluida `non-blocking`. Multiplica diffs de bajo valor y gasto de modelo.
- No abrir ningún PR hasta que `testCommand` esté definido. Bloquea el arreglo de un `blocker` por un dato que puede tardar.
- Arreglar también los cron sin usuario. La rúbrica los deja en `no-user-impact` porque no hay un flujo de usuario que observar; el issue sigue existiendo para una persona.

## Consecuencias

- Un error que no rompe el flujo queda documentado y no tocado por el bot.
- Un job en segundo plano sin request ni usuario no recibe PR automático.
- La vía de producto (PostHog) no tiene rama de arreglo en el código de la fase 1.

## Reabrir si

Hay que auto-arreglar `non-blocking`, jobs sin usuario, o hallazgos de PostHog, o hay que impedir todo PR mientras `testCommand` sea null.
