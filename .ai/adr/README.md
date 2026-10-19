# Architecture Decision Records

Cada ADR conserva una decisión difícil de revertir, las alternativas y la condición que justificaría reabrirla.

| ADR | Decisión |
| --- | --- |
| [ADR-0001](ADR-0001-github-issues.md) | Los tickets viven en GitHub Issues, detrás de un puerto. |
| [ADR-0002](ADR-0002-docs-en-el-repositorio.md) | La documentación vive en `docs/`, detrás de un puerto. |
| [ADR-0003](ADR-0003-aprobacion-humana.md) | Ningún merge sin aprobación humana explícita. |
| [ADR-0004](ADR-0004-github-app-y-autor.md) | El servicio actúa como GitHub App. |
| [ADR-0005](ADR-0005-datos-no-confiables.md) | Sentry, PostHog y GitHub son datos no confiables. |
| [ADR-0006](ADR-0006-servicio-node-postgres.md) | Un servicio Node.js y Postgres en un VPS. |
| [ADR-0007](ADR-0007-contrato-llm.md) | Una llamada LLM con JSON y parches literales. |
| [ADR-0008](ADR-0008-estados-de-propuesta.md) | Estados de propuesta y concurrencia optimista. |
| [ADR-0009](ADR-0009-idempotencia.md) | Idempotencia por entrega y por marcador. |
| [ADR-0010](ADR-0010-rubrica-de-severidad.md) | La severidad la calcula el servicio. |
| [ADR-0011](ADR-0011-elegibilidad-del-fix.md) | El auto-fix solo cubre tres clases. |
| [ADR-0012](ADR-0012-deriva-de-docs.md) | La deriva de docs usa un prefiltro barato. |
| [ADR-0013](ADR-0013-posthog-sin-pii.md) | PostHog solo publica agregados. |
| [ADR-0014](ADR-0014-idioma-de-los-issues.md) | Los issues se escriben en español. |
| [ADR-0015](ADR-0015-un-issue-por-grupo.md) | Un issue de GitHub por grupo externo. |
| [ADR-0016](ADR-0016-coste-y-reintentos.md) | Tope de coste y reintentos. |
| [ADR-0017](ADR-0017-targets-como-coleccion.md) | El blanco es una colección de targets. |
| [ADR-0018](ADR-0018-sentry-en-el-despliegue.md) | Sentry se elige al desplegar el target. |
