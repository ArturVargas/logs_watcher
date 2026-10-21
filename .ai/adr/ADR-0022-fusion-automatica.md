# ADR-0022: Fusión automática solo con urgencia baja

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: ADR-0003 prohibía toda fusión hecha por el servicio. Artur fijó una regla de trabajo: se puede fusionar solo cuando la urgencia es baja, la CI está en verde y el merge del worktree está limpio. Las clases que ya exigían una persona lo siguen exigiendo. El umbral lo puede mover él.

## Decisión

El servicio fusiona un pull request solo cuando la urgencia es `low`, la CI de ese SHA está en verde y el merge en el worktree del job queda limpio. Las clases `blocker`, `truncated` y `flow-blocked` siguen exigiendo una persona, y `unclassified` también. Artur puede mover este umbral en `autoMerge.urgencyAtMost` y `autoMerge.severityBlocks`. El modo en seco no fusiona. Un pull request desde un fork no se fusiona. Cada fusión, automática o de una persona, queda escrita en el issue con el SHA, la urgencia y si fue automática.

La CI está en verde solo cuando el estado combinado de ese SHA es `success` y cada check de ese SHA terminó en `success`. Pendiente no es verde. Si no hay ningún check ni ningún estado, la CI no está en verde.

Urgencia vacía no es `low`. El orden para `urgencyAtMost` es `low`, luego `medium`, luego `high`. El valor de trabajo de `urgencyAtMost` es `low`. El valor de trabajo de `severityBlocks` es `blocker`, `truncated`, `flow-blocked` y `unclassified`. Una clase en esa lista no se fusiona sola aunque la urgencia sea `low`.

La llamada de merge usa el método `merge`. No se activa el auto-merge de GitHub. El modo en seco, si la regla se cumpliría, registra `would_auto_merge` y no llama a la API.

## Alternativas consideradas

- No fusionar nunca. Es ADR-0003 antes de esta decisión, y Artur ya la movió.
- Fusionar todo lo que tenga CI verde. Metería en la rama base un `blocker` sin una persona.
- Tratar “sin CI” como verde. Un repositorio sin checks se fusionaría solo. La fase de CI es posterior (ADR-0024).

## Consecuencias

- ADR-0003 queda reemplazada en la prohibición absoluta. Los comandos humanos siguen para lo que este ADR no fusiona.
- Mientras no haya CI en verde, la fusión automática no ocurre. Una persona puede fusionar igual.
- El issue distingue fusión automática y fusión de una persona. En los dos casos el progreso pasa a `resuelta` y el issue se cierra.

## Reabrir si

Artur quiere otro predicado que no quepa en `urgencyAtMost` y `severityBlocks`, o la fusión automática debe incluir forks o el modo en seco.
