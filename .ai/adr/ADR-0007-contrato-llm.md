# ADR-0007: Una llamada LLM con JSON y parches literales

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Hace falta rellenar booleanos que Sentry no trae, proponer arreglos y proponer parches de documentación. El modelo no debe reescribir archivos enteros ni decidir la severidad.

## Decisión

El proveedor y la salida del código depurado ya no están abiertos: los fija ADR-0025. Qwen Cloud escribe el parche. JEv no lo escribe.

Cada job que usa este modelo hace una sola llamada `POST {base}/chat/completions`, `temperature` 0, `response_format.type = json_object`. `base` es la de ADR-0025. Si el servidor rechaza `response_format`, hay un reintento sin ese campo. El validador del servicio es el que acepta o rechaza el JSON.

El modelo no devuelve la clase de severidad ni la clave de idempotencia. Esas las calcula el servicio.

Un arreglo o un cambio de docs es una lista de parches `{ path, before, after }` más, en el caso del arreglo, archivos de test nuevos. `before` tiene que aparecer una sola vez en el archivo de destino. No hay reescritura completa del archivo. Cada cita de evidencia tiene al menos 8 caracteres y es subcadena literal de la fuente ya depurada que declara.

Si la validación falla, el job de fix puede repetir la llamada una vez, adjuntando solo los códigos de error del validador. Máximo dos llamadas por job de fix, una por job de clasificación y una por job de docs.

## Alternativas consideradas

- Dejar que el modelo elija la severidad. Hace la rúbrica inestable.
- Diff unificado generado por el modelo. Es más difícil de anclar a una sola ocurrencia de `before`.
- Varias llamadas encadenadas (plan, parche, crítica). Multiplica coste y superficie de inyección.

## Consecuencias

- Sin la clave del operador o sin id de modelo no hay llamada de parche. La base por defecto es la de ADR-0025. La clasificación determinista sigue funcionando. Este modelo no clasifica importancia ni urgencia.
- Un parche que no pasa `git apply --check` no se publica.
- El cuerpo de los issues de fallo y de hallazgo lo rellena una plantilla, no el modelo.

## Reabrir si

Un proveedor sin API compatible con `/chat/completions` es obligatorio, o un solo parche literal no puede expresar los arreglos que sí queremos aceptar.
