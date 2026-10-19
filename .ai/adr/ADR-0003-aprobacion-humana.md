# ADR-0003: Ningún merge sin aprobación humana explícita

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: El servicio propone arreglos y cambios de documentación. Una persona tiene que aceptarlos antes de que entren en la rama base. No hay merge automático.

## Decisión

El servicio no llama a la API de merge, no activa auto-merge y no aprueba sus propios PRs. La aprobación es un comentario cuyo cuerpo, ya recortado, es exactamente `/logs-watcher approve`. El autor debe tener asociación `OWNER`, `MEMBER` o `COLLABORATOR`, y su `type` no puede ser `Bot`.

Con esa aprobación el servicio marca la propuesta como `approved`, añade la etiqueta `logs-watcher:approved` y actualiza el bloque de progreso del issue. La fusión la hace una persona en GitHub.

`/logs-watcher reject` y `/logs-watcher refresh` son los otros dos comandos. Cualquier otro texto se ignora, aunque contenga esas palabras.

## Alternativas consideradas

- El bot fusiona después del comentario. Acorta el camino, y también fusiona si la regla de asociación está mal.
- Exigir una review de GitHub con estado APPROVED. Depende de branch protection que este repositorio no controla en la aplicación vigilada.
- Una lista cerrada de logins. Hace falta mantenerla a mano; la asociación de GitHub ya limita quién puede escribir en el repositorio.

## Consecuencias

- Un PR puede quedarse abierto después de aprobado hasta que alguien lo fusione.
- Cualquier colaborador con escritura puede aprobar. No hace falta un segundo factor en la fase 1.
- El cierre de un PR sin merge pasa la propuesta a `rejected` y no cierra el issue.

## Reabrir si

Solo una lista nombrada de personas debe poder aprobar, o el equipo decide que el bot fusione después del comando.
