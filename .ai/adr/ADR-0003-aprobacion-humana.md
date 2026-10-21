# ADR-0003: Aprobación humana de lo que no se fusiona solo

- Estado: reemplazada
- Fecha: 2026-10-19
- Contexto: El servicio propone arreglos y cambios de documentación. La regla original era no llamar nunca a la API de merge. Artur la movió el 2026-10-21: hay fusión automática en un caso acotado. Esa regla vive solo en ADR-0022. Este ADR no la repite como prohibición absoluta.

## Decisión

La política de fusión vigente es ADR-0022. Este registro ya no prohíbe toda llamada a la API de merge.

Siguen vigentes los comandos humanos para los pull requests que una persona tiene que tomar. La aprobación es un comentario cuyo cuerpo, ya recortado, es exactamente `/logs-watcher approve`. El autor debe tener asociación `OWNER`, `MEMBER` o `COLLABORATOR`, y su `type` no puede ser `Bot`. Con esa aprobación la propuesta pasa a `approved` y el pull request lleva `logs-watcher:approved`. La fusión de ese pull request la hace una persona, salvo que ADR-0022 permita la fusión automática.

`/logs-watcher reject` y `/logs-watcher refresh` son los otros dos comandos. Cualquier otro texto se ignora, aunque contenga esas palabras. El servicio no aprueba sus propios pull requests.

## Alternativas consideradas

- Dejar este ADR como “el servicio nunca fusiona” y abrir otro que sí fusiona. Serían dos decisiones aceptadas en conflicto.
- El bot fusiona después de cualquier comentario de aprobación. Acorta el camino, y también fusiona si la regla de asociación está mal.
- Una lista cerrada de logins. La asociación de GitHub ya limita quién puede escribir en el repositorio.

## Consecuencias

- Quien lea solo este archivo tiene que seguir a ADR-0022 para saber cuándo hay merge.
- Un pull request que exige persona puede quedarse abierto después de `approved` hasta que alguien lo fusione.
- El cierre de un pull request sin merge pasa la propuesta a `rejected` y no cierra el issue.

## Reabrir si

Solo una lista nombrada de personas debe poder aprobar, o ADR-0022 deja de ser la política de fusión.
