# ADR-0017: El blanco es una colección de targets

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: OQ-1 preguntaba el `owner` y el `name` de la aplicación vigilada. Artur cerró la pregunta de producto: el nombre sigue sin conocerse, el MVP vigila un solo proyecto, y más adelante puede haber varios repositorios y varias aplicaciones. El alcance de la fase 1 decía que un segundo repositorio estaba fuera de alcance. Eso chocaría con modelar varios targets.

## Decisión

No hay repositorio por defecto y la especificación no inventa `owner` ni `name`.

El MVP vigila un solo proyecto. El servicio modela el blanco como una lista `targets` desde el principio. Hoy la lista puede tener una entrada. Más adelante puede tener varias. Añadir un repositorio o una aplicación es añadir una entrada, no un cambio de diseño.

Un target ata una aplicación: su repositorio de GitHub (`owner`, `name`), su proyecto de Sentry y su proyecto de PostHog. El `id` de la entrada no es el nombre del repositorio.

`owner` y `name` son configuración obligatoria de despliegue para que ese target actúe. Hasta que ambos estén puestos, la GitHub App no tiene dónde instalarse y no se abre ningún issue. `targets` vacío, o un target con `owner` o `name` vacíos, es configuración válida. El resto de la especificación no espera a conocer el repositorio.

OQ-4 sigue abierta y se contesta para el primer target. OQ-2 está cerrada: la organización, el slug y los entornos de producción de Sentry son configuración de despliegue de cada target, no un nombre fijado aquí (ADR-0018). OQ-3 está cerrada: el host de PostHog, el `projectId` y las listas de validaciones y embudos son configuración de cada target (ADR-0019).

## Alternativas consideradas

- Un solo objeto `appRepo` en la configuración. El segundo repositorio obligaría a rehacer el esquema, las claves y los webhooks.
- Dejar OQ-1 abierta hasta conocer el nombre. Bloquea el resto de la especificación por un dato de despliegue.
- Inventar un owner o un name de ejemplo y tratarlo como el repositorio real.

## Consecuencias

- El alcance ya no excluye un segundo repositorio. Sigue excluyendo un segundo nodo y un segundo worker.
- Las claves de grupo, de hallazgo y de idempotencia incluyen `targetId`.
- El webhook de Sentry es `POST /webhooks/sentry/{targetId}`. El de GitHub es uno y se enruta por owner y name.
- ADR-0004 instala la misma GitHub App en cada target activo. No fija cuántos repositorios hay.
- El tope de coste de ADR-0016 sigue siendo del proceso y lo comparten todos los targets.

## Reabrir si

Cada aplicación debe tener su propio proceso, o el segundo repositorio no puede compartir la GitHub App, el tope de coste o el esquema de `targets`.
