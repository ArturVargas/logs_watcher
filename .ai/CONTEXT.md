# Contexto del proyecto

- Producto: logs_watcher
- Propósito: vigilar la aplicación de Artur. La vía de Sentry abre un issue de GitHub por cada fallo aceptado, clasifica la severidad y, cuando la clase lo permite, abre un PR con el arreglo. La vía de PostHog documenta fricción, validaciones y abandonos para diseño y producto, sin arreglar código.
- Usuarios principales: Artur, quien revisa y aprueba; diseño y producto, que reciben los hallazgos de PostHog; la cuenta `el-chalan-dev`, que implementará el servicio más adelante desde un VPS.
- Repositorio y comandos relevantes: este repositorio es `ArturVargas/logs_watcher`. La aplicación vigilada es otro repositorio, modelada como un target (ADR-0017). `owner` y `name` siguen sin conocerse y no tienen valor por defecto. No hay comandos de aplicación en esta fase. La iniciativa vive en `.ai/runs/2026-10-19-logs-watcher/` (`03-specification.md`, `04-architecture.md`). Los ADR están en `.ai/adr/`.
- Entornos: fase 1 prevista en un solo VPS Linux, con el servicio en systemd y Postgres en localhost. Este cambio no despliega nada.
- Fuente de verdad de datos: Sentry para fallos, PostHog para comportamiento agregado, logs de Railway, Vercel y Cloudflare, GitHub Issues para el seguimiento, y `docs/` del repositorio vigilado para la documentación de esa aplicación. Postgres del servicio guarda cola, propuestas y punteros.
- Restricciones no negociables:
  - Fusionar solo bajo ADR-0022. `blocker`, `truncated`, `flow-blocked` y `unclassified` siguen exigiendo una persona. El modo en seco y los forks no se fusionan.
  - Tratar el contenido de Sentry, PostHog, logs de Railway, Vercel y Cloudflare, diffs, issues y PRs como datos no confiables (ADR-0005).
  - La vía PostHog no abre PRs de arreglo en esta fase.
  - Esta iniciativa es `architectural`. No incluye código de aplicación ni plan de implementación.
  - Las decisiones abiertas están solo en `03-specification.md`, sección Decisiones abiertas. El implementador no inventa un valor para ellas.

## Reglas de uso

Lee solo las referencias y artefactos declarados por la etapa actual. No supongas requisitos que no estén confirmados.
