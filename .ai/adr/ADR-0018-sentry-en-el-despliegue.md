# ADR-0018: Sentry se elige al desplegar el target

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: OQ-2 preguntaba la organización de Sentry, el slug del proyecto, la `baseUrl` y los nombres de `environment` que cuentan como producción. Artur cerró la pregunta de producto: nadie fija esos nombres en la especificación, salvo el valor por defecto del host.

## Decisión

La organización de Sentry la elige el operador al configurar cada target. La especificación no fija ninguna organización y no inventa una.

La misma regla vale para el slug del proyecto y para los nombres exactos de `productionEnvironments`. Son configuración del operador. No hay valores inventados.

`baseUrl` vale `https://sentry.io` si el operador no la escribe o la deja vacía. El operador puede sustituirla.

Si `productionEnvironments` está vacío, la vía Sentry de ese target descarta todos los eventos a propósito, para no tratar staging como producción. El servicio no elige esos nombres.

`org`, slug y `productionEnvironments` siguen siendo configuración obligatoria de despliegue del target. Si cualquiera de los tres está vacío, no se abre ningún issue de Sentry y no se llama a la API de issues. Una lista vacía es configuración válida. OQ-2 ya no es una pregunta de producto.

OQ-3 y OQ-4 siguen abiertas.

## Alternativas consideradas

- Fijar una organización, un slug o una lista de entornos en la especificación. Esos datos no se conocen y quedarían inventados.
- Tratar `productionEnvironments` vacío como “aceptar todos los entornos”. Staging pasaría por el flujo de producción.
- Dejar OQ-2 abierta hasta que el operador escriba los nombres. El resto de la especificación no depende de esos nombres.

## Consecuencias

- El ejemplo de configuración deja `org`, `project` y `productionEnvironments` vacíos, y `baseUrl` en `https://sentry.io`.
- Cada target lleva los suyos. Añadir otra aplicación no cambia esta regla (ADR-0017).
- Un evento cuyo `environment` no está en la lista tampoco abre issue. Esa lista solo se consulta cuando no está vacía.

## Reabrir si

El host por defecto deja de ser `https://sentry.io`, o un target debe aceptar eventos cuando `productionEnvironments` está vacío.
