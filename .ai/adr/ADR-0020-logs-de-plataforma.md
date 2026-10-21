# ADR-0020: Los logs de plataforma también son fuente de verdad

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: Sentry y PostHog no son el único rastro del fallo. La aplicación también escribe logs en Railway, Vercel y Cloudflare. El mismo error puede aparecer en más de un sitio. Tratar cada copia como un issue nuevo parte el seguimiento.

## Decisión

Las fuentes de verdad de fallos y de comportamiento son Sentry, PostHog, y los logs de Railway, Vercel y Cloudflare, además de GitHub Issues para el seguimiento y `docs/` para la documentación de la aplicación. Postgres del servicio sigue siendo cola y punteros, no la fuente de verdad del producto.

Esos logs entran por un drenaje hacia `POST /webhooks/logs/{targetId}/{source}`, con `source` igual a `railway`, `vercel` o `cloudflare`. Cada adaptador verifica la firma con el secreto configurado y con el esquema que documenta ese proveedor para su drenaje. El evento normalizado solo guarda mensaje, timestamp, nivel si viene, y el id de entrega. Lo que el drenaje no envía queda vacío. No se inventa un esquema privado del cuerpo.

El texto del log es dato no confiable, igual que Sentry y PostHog (ADR-0005).

La deduplicación compara el log con los grupos de Sentry del mismo target. La firma es el tipo de excepción más el frame superior si se pueden leer en el mensaje; si no, el mensaje en minúsculas, con las tandas de dígitos cambiadas por `#`, espacios colapsados y recorte a 120 caracteres. Hay coincidencia si esa firma es la del grupo o si el mensaje normalizado es igual al título normalizado del grupo.

Si coincide, no se abre otro issue. Se añade la fuente al bloque de fuentes y se comenta una vez, con marcador `logs-watcher-source:{source}:{deliveryId}`. La severidad no baja. Si la evidencia nueva sube la clase, se recalcula y se actualiza el bloque de severidad cuando los marcadores aparecen una sola vez.

Si no coincide, se abre un issue de esa fuente, con la misma rúbrica. Si faltan booleanos, la clase es `unclassified` y no hay pull request de arreglo.

## Alternativas consideradas

- Un issue por fuente. El mismo fallo en Sentry y en Railway serían dos tickets.
- Sondear las APIs de lectura de cada proveedor con un esquema inventado. El drenaje ya es el camino de ingestión y el cuerpo que no conocemos no se adivina.
- Dejar los logs fuera de la fuente de verdad y usarlos solo como archivo. Artur los incluyó al lado de Sentry y PostHog.

## Consecuencias

- Un fallo visto en tres sitios ocupa un solo issue de GitHub. La lista de fuentes dice cuáles llegaron.
- Sin el secreto del drenaje, esa fuente no se ingiere.
- Un log que no se puede emparejar con Sentry igual abre issue, marcado con su fuente, para que no desaparezca.

## Reabrir si

Hay que sondear un proveedor que no ofrece drenaje, o el mismo fallo debe conservar un issue distinto por fuente.
