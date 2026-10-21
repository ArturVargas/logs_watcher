# ADR-0008: Estados de propuesta y concurrencia optimista

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Entre el análisis y la aprobación de una persona el código o el issue pueden cambiar. Aplicar un parche viejo, o reescribir un issue editado a mano, pisa trabajo ajeno.

## Decisión

Cada propuesta de fix o de docs tiene uno de estos estados: `pending`, `approved`, `rejected`, `stale`.

Pasa a `stale` cuando el `base_sha` o el blob de un archivo parcheado ya no coincide con lo guardado y el parche no aplica. El servicio comenta, pone la etiqueta `logs-watcher:stale` y no hace force-push. Solo `/logs-watcher refresh` crea una propuesta nueva.

La actualización del issue reemplaza un bloque delimitado por marcadores. El texto `before` de ese bloque tiene que aparecer una sola vez. Si no está, o está repetido, el servicio no reescribe el issue: comenta y registra `progress_stale`. Eso es el conflicto optimista; la respuesta interna equivalente es 409.

No existe un quinto estado `merged`. Si una persona fusiona el PR, la propuesta se queda en `approved` y el progreso del issue pasa a `resuelta`.

## Alternativas consideradas

- Reescribir el issue entero en cada evento. Borra ediciones humanas.
- Rebasar y force-push cuando la rama base se mueve. Esconde el conflicto y puede descartar commits de una persona.
- Añadir el estado `merged` a la propuesta. Duplica el hecho que ya cuenta el PR de GitHub.

## Consecuencias

- Una propuesta `stale` no se repara sola.
- El bloque de progreso y el bloque de conteos son la única región que el servicio pretende reemplazar.
- `refresh` genera otra `generation_key` y otra rama. El PR viejo, si sigue abierto, se cierra con un comentario.

## Reabrir si

Las personas necesitan que el servicio rebase sin un comando, o el estado de GitHub deja de ser suficiente para saber si el PR se fusionó.
