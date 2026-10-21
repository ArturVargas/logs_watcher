# ADR-0023: Un worktree por job, sin ours ni theirs

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: El servicio tiene que mezclar ramas, ver si el merge está limpio y resolver un conflicto solo cuando el parche ya verificado sigue aplicando. Un clon compartido entre jobs se pisa. Elegir ours o theirs en un hunk solapado esconde el conflicto.

## Decisión

Hay un espejo bare por target en `/var/lib/logs-watcher/mirrors/{targetId}` y un worktree por job en `/var/lib/logs-watcher/worktrees/{jobId}`. El worktree se borra al terminar el job, bien o mal. Dos jobs no comparten directorio de trabajo.

El merge limpio se prueba en ese worktree: `git merge --no-commit --no-ff` de la rama por defecto sobre el HEAD del arreglo. Limpio significa salida 0 y ningún archivo sin fusionar. Después el worktree vuelve a ese HEAD con `git merge --abort` o `git reset --hard`. No se publica el merge de prueba.

Si hay conflicto, la única resolución permitida es volver a aplicar el parche `{ before, after }` ya verificado, y solo si `git apply --check` pasa sobre la base nueva. Si pasa, se aplica ese parche. Si no pasa, la propuesta se queda en `stale` y la toma una persona. No hay `ours`, ni `theirs`, ni otra mezcla silenciosa de hunks solapados.

## Alternativas consideradas

- Un solo clon con `git checkout` por job. El job siguiente pisa el primero.
- Resolver con la estrategia `ours` o `theirs`. El resultado no es el parche que se validó.
- Reescribir el archivo entero cuando el `before` ya no es único. Choca con ADR-0007 y ADR-0008.

## Consecuencias

- La fusión automática de ADR-0022 solo mira este ensayo de merge.
- Un parche que ya no encaja no se “arregla” solo: queda `stale`.
- Hace falta Git en el VPS. El espejo se actualiza con fetch antes de crear el worktree.

## Reabrir si

Hace falta resolver hunks solapados con una regla distinta del parche verificado, o más de un worktree por job.
