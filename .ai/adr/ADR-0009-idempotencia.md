# ADR-0009: Idempotencia por entrega y por marcador

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Sentry y GitHub reintentan webhooks. El worker también reintenta jobs. Sin una clave estable el servicio abre issues y comentarios duplicados.

## Decisión

Cada entrega de webhook se inserta en `inbox` con una clave única. Sentry: cabecera `Request-ID`; si falta, SHA-256 del cuerpo crudo. GitHub: `X-GitHub-Delivery`. Un conflicto de clave responde 200 y no encola otro job.

Los jobs usan `dedupe_key` única. Repetir el mismo trabajo es un no-op.

Los issues llevan un marcador HTML oculto:

- Sentry: `<!-- logs-watcher-sentry-issue: {sentryIssueId} -->`
- PostHog: `<!-- logs-watcher-posthog: {dedupeKey} -->`
- Propuesta en un PR: `<!-- logs-watcher-proposal: {proposalId} -->`
- Comentario de actualización: `<!-- logs-watcher-update: {eventOrWindowId} -->`

`generation_key` es el SHA-256 hexadecimal de una cadena UTF-8 que el servicio compone. El modelo no la aporta. Las fórmulas están en la especificación.

Antes de crear un issue, el servicio busca el marcador en Postgres y, si no está, en GitHub.

## Alternativas consideradas

- Confiar solo en la búsqueda de GitHub. El índice va con retraso y el reintento puede crear dos issues.
- Usar el id de evento de Sentry como issue de GitHub. Un mismo grupo tiene muchos eventos y produciría un issue por evento.

## Consecuencias

- Hace falta la restricción única en base de datos, no solo una comprobación en memoria.
- Un comentario reintentado con el mismo marcador no se publica otra vez.
- Los marcadores son parte del contrato del cuerpo. Quien los borre obliga al camino de `progress_stale` o a la búsqueda por marcador.

## Reabrir si

El proveedor de tickets no permite un cuerpo estable con comentarios HTML.
