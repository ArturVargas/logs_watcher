# ADR-0019: PostHog se elige al desplegar el target

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: OQ-3 preguntaba el host de PostHog, el id de proyecto y los nombres de eventos de validaciones y embudos. Artur cerró la pregunta de producto: el host es el de Estados Unidos, y el resto se escribe en la configuración cuando se conozca.

## Decisión

El host de PostHog es `https://us.posthog.com`. Si `host` viene vacío u omitido, el servicio usa esa URL. No llama a otro host.

`projectId` todavía no se conoce. Lo escribe el operador, más adelante, en el archivo de configuración del target. La especificación no inventa un id. Si `projectId` falta o está vacío, no hay barrido de PostHog.

`validationEvents` y `funnels` no tienen valores activos por defecto. El archivo puede incluir ejemplos comentados, un embudo `payment` y un embudo `form`, que solo muestran la forma: un `id` estable y pasos `event` en orden. El servicio quita los comentarios `//` y `/* */` antes de leer el JSON. Ejecuta esas consultas solo cuando las listas están en el JSON, fuera de comentarios, con nombres reales de evento. Las listas vacías omiten esas consultas. No inventa eventos de pago ni de formulario y no abre issues a partir de los valores de ejemplo.

`projectId`, `validationEvents` y `funnels` siguen siendo configuración de despliegue del target. OQ-3 ya no es una pregunta de producto.

OQ-4 sigue abierta.

## Alternativas consideradas

- Dejar el host a elegir entre `us` y `eu`. Artur ya fijó `https://us.posthog.com`.
- Inventar un `projectId` o unos eventos de pago y de formulario para que el barrido tenga datos. Esos nombres no se conocen.
- Poner el ejemplo de embudo como JSON activo. Abriría issues con eventos que no existen.

## Consecuencias

- El ejemplo de configuración deja `projectId` vacío, `host` en `https://us.posthog.com`, y las dos listas en `[]`.
- `$exception`, `$rageclick` y `$dead_click` sí pueden correr cuando el target está activo y `projectId` está puesto. No dependen de `funnels`.
- ADR-0013 sigue decidiendo qué datos de persona no se publican. No elige el host ni el `projectId`.
- Cada target lleva los suyos (ADR-0017).

## Reabrir si

El proyecto de PostHog no está en `https://us.posthog.com`, o los ejemplos comentados deben ejecutarse sin que el operador los active.
