# ADR-0001: Los tickets viven en GitHub Issues, detrás de un puerto

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Hay que abrir y actualizar tickets de fallos y de hallazgos de producto. Linear puede hacer falta más adelante, pero no en la fase 1.

## Decisión

La fase 1 usa GitHub Issues del repositorio vigilado. El núcleo del servicio depende solo del puerto `IssueTracker`, con estas operaciones: `ensureLabels`, `findByMarker`, `createIssue`, `updateOwnedBlock`, `comment`, `addLabels`, `removeLabels`, `closeIssue`, `reopenIssue`. `GitHubIssuesAdapter` es el único adaptador que se implementa ahora. El payload de un job guarda `tracker = "github"` y el id externo como texto. No aparecen campos de Linear en el núcleo.

## Alternativas consideradas

- Linear desde la fase 1. Exige otra cuenta y otro modelo de estados antes de tener el flujo cerrado.
- Llamar a la API de GitHub desde cada job, sin puerto. El cambio a Linear tocaría todos los jobs.

## Consecuencias

- Los issues de Sentry y de PostHog salen por el mismo puerto, con plantillas y etiquetas distintas.
- Cerrar un issue en Sentry no cierra el issue de GitHub. El issue de GitHub se cierra cuando el pull request de arreglo queda fusionado, sea por una persona o por la regla de ADR-0022. El cuerpo del issue dice cuál de las dos fue y el SHA.
- Un adaptador de Linear posterior tiene que cubrir las mismas operaciones, sin cambiar la rúbrica ni los marcadores.

## Reabrir si

El seguimiento deja de vivir en GitHub antes de que exista código del adaptador, o el puerto no puede expresar un estado que la fase 1 ya necesite.
