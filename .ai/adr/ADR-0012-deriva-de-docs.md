# ADR-0012: La deriva de docs usa un prefiltro barato

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Un PR puede dejar `docs/` desactualizado. Hace falta mirar el diff y los docs sin embeddings y sin mandar el repositorio entero al modelo. El resultado tiene que ser un cambio de archivos, no un comentario suelto como única salida.

## Decisión

En cada `pull_request` `opened`, `synchronize` y `reopened`, y también sobre el diff del propio PR de fix, el servicio construye candidatos así: reglas de `docs/map.yml` si el archivo es válido, luego coincidencia por nombre de archivo y directorio, luego búsqueda literal de símbolos exportados en el diff. Tope: 15 archivos, 20 000 caracteres por archivo, 80 000 caracteres de prompt.

No hay embeddings en la fase 1. Si `docs/` tiene más de 200 Markdown o MDX y el prefiltro no encuentra candidatos, el servicio registra `docs_prefilter_empty_large_corpus` y no llama al modelo.

Si el PR es un fix nuestro en una rama del mismo repositorio, los parches de docs se commitean en esa rama. En cualquier otro PR del mismo repositorio se abre un PR aparte `logs-watcher/docs-*` contra la rama base. En un PR desde un fork no se empuja: se guarda la propuesta y se comenta que no se escribe en el fork.

## Alternativas consideradas

- Embeddings desde el primer día. Coste y operación de más para un corpus que todavía no se ha medido.
- Commitear siempre en la rama de la persona. Pisa su rama y mezcla commits del bot con los suyos.
- Solo un comentario con el parche, sin PR. El cambio no queda listo para fusionarse.

## Consecuencias

- Un `docs/map.yml` inválido se ignora y el prefiltro heurístico sigue.
- Un PR que solo toca Markdown no dispara el mapeo código → docs.
- Por encima de 200 docs, el silencio del prefiltro es visible en una métrica, no es un fallo silencioso permanente: queda el hueco hasta una fase posterior.

## Reabrir si

El corpus supera 200 archivos y el prefiltro se queda vacío en PRs que sí deberían tocar docs, o los autores piden el parche en su propia rama.
