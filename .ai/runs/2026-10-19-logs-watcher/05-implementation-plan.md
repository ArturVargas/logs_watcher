# Plan de implementación

> Implementar solo después de aprobar la especificación y, cuando aplique, la arquitectura.

## Objetivo

La iniciativa sigue siendo `architectural`. Este archivo es el plan que pide `standards/execution.md` antes de codificar. El código lo escribe `el-chalan-dev` desde un VPS. Este plan no es ese código.

Dejar el MVP en seco corriendo en el VPS, y nada más:

1. Webhooks firmados, cola, clasificación y propuestas guardadas, con `LOGS_WATCHER_DRY_RUN=true`. En este corte no hay escritura a GitHub.
2. Antes de salir del modo en seco hacen falta la GitHub App, la clave de Qwen Cloud del operador y el primer target (`owner`, `name`, Sentry, `projectId` de PostHog, `productionEnvironments`). `targets` vacío es válido y no vigila nada.
3. Una persona revisa al menos diez filas guardadas. Poner `LOGS_WATCHER_DRY_RUN=false` es otro cambio, fuera de estas tareas.
4. `phases.cicd` sigue en `false`. No hay bucle de fix, así que la fase de CI no se enciende (ADR-0024).
5. Cada paso que genere o revise código nombra ponytail (ADR-0026).

## Referencias

- Especificación: `.ai/runs/2026-10-19-logs-watcher/03-specification.md`
- ADRs: `.ai/adr/` del ADR-0001 al ADR-0026. ADR-0003 está reemplazada en la prohibición absoluta por ADR-0022. Ninguno se reabre.
- Arquitectura: `.ai/runs/2026-10-19-logs-watcher/04-architecture.md`
- Plantilla de este archivo: `templates/implementation-plan.md`
- Skill: https://github.com/DietrichGebert/ponytail — `skills/ponytail/SKILL.md` y `skills/ponytail-review/SKILL.md`

## Restricciones globales

- Dependencias permitidas: Node.js 22, Postgres 16 y el paquete `pg`. HTTP, HMAC y las pruebas salen de `node:http`, `node:crypto` y `node:test`. No se añade Express, un ORM, un SDK de Qwen, Octokit, un framework de migraciones ni Docker.
- Compatibilidad: un proceso, un job a la vez, Postgres en `127.0.0.1`. Lo ejecuta `el-chalan-dev` en un VPS Linux. Sin `owner` y `name` el target no actúa.
- Reglas de seguridad o datos: firma antes de parsear; comparación en tiempo constante; cuerpo mayor de 1 000 000 bytes responde 413 y no inserta; el depurador corre antes de una llamada al modelo o de guardar `last_error`; los secretos no entran en git. `LOGS_WATCHER_DRY_RUN` distinto de `false` es seco. `phases.cicd` distinto de `true` es `false`.
- Ponytail: nivel `full`. El clon vive en `$HOME/ponytail`, fuera de este repo (ADR-0026).
- La retención de datos de Qwen Cloud sigue siendo un riesgo a revisar (ADR-0025), no una pregunta de producto. Las pruebas hablan con un stub en localhost. Una llamada real espera una nota de `el-chalan-dev` sobre las cuatro páginas citadas en ese ADR.

## Conflictos con ponytail

El skill pide no escribir lo que este corte no ejecuta. Estas piezas siguen decididas. No se construyen ahora:

1. `IssueTracker`, `GitHubIssuesAdapter`, `DocsPublisher` y `FilesInRepoAdapter` (ADR-0001, ADR-0002). En seco no hay escritura a GitHub. Un puerto con un adaptador sin llamador no entra.
2. Tablas `source_events`, `findings`, `alerts` y `worker_heartbeat`. La arquitectura las fija. Este corte no las escribe. Entran con el primer job que las use. Aquí se crean `inbox`, `jobs`, `groups`, `proposals` y `cost_ledger`.
3. El espejo en `/var/lib/logs-watcher/mirrors/` y el worktree de larga vida (ADR-0023). Sin `owner` y `name` no hay clon. El parche se prueba con `git apply --check` en un directorio temporal que se borra al terminar el job.
4. Drenajes de logs (ADR-0020), barrido de PostHog (ADR-0019), llamada a JEv (ADR-0021), fusión (ADR-0022) y `cicd_improve` (ADR-0024). No hay ruta de logs: no hay que apuntar un drenaje a este proceso. Importancia y urgencia quedan vacías. Vacío no es `low`.
5. Los comandos `logs-watcher jobs list`, `jobs retry` y `budget show`. Para las diez filas basta `psql`.
6. El informe de `ponytail-review` sale en inglés. Este plan y los ADR siguen en español. ADR-0014 no se toca.

Poner `LOGS_WATCHER_DRY_RUN=false` sin un escritor de GitHub no abre issues. Este corte no trae ese escritor. El flag se cambia en otro cambio, cuando existan las cuentas, las diez filas revisadas y el código de escritura que aquí no está.

## Tareas

### Tarea: Cargar ponytail

**Resultado verificable:** el skill se lee desde `$HOME/ponytail` y logs_watcher no contiene una copia.

**Archivos:**

- Crear: ninguno en este repo.
- Modificar: ninguno.
- Probar: ninguno.

**Interfaces:**

- Consume: https://github.com/DietrichGebert/ponytail (`INSTALL.md`, `skills/ponytail/SKILL.md`, `skills/ponytail-review/SKILL.md`).
- Produce: un clon fuera del repo. En Cursor, `~/.cursor/hooks.json` del usuario.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `test -f "$HOME/ponytail/skills/ponytail/SKILL.md"` falla si el clon no está.
2. Implementación mínima: `git clone https://github.com/DietrichGebert/ponytail.git "$HOME/ponytail"`. En Cursor, `node "$HOME/ponytail/scripts/cursor-hooks.js" install` sin `--project`. Otro agente: la sección correspondiente de `$HOME/ponytail/INSTALL.md`. Cada tarea de abajo empieza leyendo `skills/ponytail/SKILL.md` (nivel `full`) y termina leyendo `skills/ponytail-review/SKILL.md` sobre el diff de esa tarea.
3. Comando de verificación y resultado esperado: `test -f "$HOME/ponytail/skills/ponytail/SKILL.md" && test -f "$HOME/ponytail/skills/ponytail-review/SKILL.md"` sale 0. `git -C <repo logs_watcher> status --short` no muestra archivos de ponytail.

**Impacto operativo:**

- Migración/compatibilidad: ninguna.
- Rollback: en Cursor, `node "$HOME/ponytail/scripts/cursor-hooks.js" uninstall`. Después, borrar `$HOME/ponytail`.
- Observabilidad: no aplica.

**Evidencia de finalización:** las dos rutas existen y el `status` del repo sigue limpio de copias del skill.

### Tarea: Arranque con configuración vacía

**Skill:** generación con `skills/ponytail/SKILL.md` (nivel `full`). Revisión con `skills/ponytail-review/SKILL.md`.

**Resultado verificable:** el proceso arranca con `targets` vacío, no vigila nada, y `GET /healthz` responde 200 solo si Postgres responde.

**Archivos:**

- Crear: `package.json`, `package-lock.json`, `sql/schema.sql`, `src/config.js`, `src/main.js`, `test/config.test.js`.
- Modificar: ninguno.
- Probar: `test/config.test.js`.

**Interfaces:**

- Consume: `LOGS_WATCHER_CONFIG`, `LOGS_WATCHER_DRY_RUN`, `DATABASE_URL`, el JSON de la especificación (sección Configuración que el servicio no inventa).
- Produce: `loadConfig()` y `dryRun()`. `dryRun()` es verdadero si la variable no es exactamente `false`. `phases.cicd` es verdadero solo si el JSON trae `true`.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `node --test test/config.test.js` falla porque `src/config.js` no existe. La prueba cubre un archivo sin `targets`, un target con `owner` vacío, un comentario de línea al lado de un valor que contiene `//`, `LOGS_WATCHER_DRY_RUN` ausente, `phases.cicd` ausente, `GET /healthz` con `SELECT 1` en 200 y `{"ok":true,"db":"up"}`, y Postgres caído sin ese 200.
2. Implementación mínima: `package.json` con `"type": "module"`, `engines.node` `>=22` y la dependencia `pg`. `sql/schema.sql` crea solo `inbox`, `jobs`, `groups`, `proposals` y `cost_ledger`, con las columnas de `04-architecture.md` y `CREATE TABLE IF NOT EXISTS`. `src/config.js` quita comentarios sin tocar strings y aplica los defaults ya escritos en la especificación (`baseUrl` de Sentry, host de PostHog, base de Qwen). `src/main.js` abre `GET /healthz` con `{"ok":true,"db":"up"}` y no escucha otra ruta todavía. No hay unit de systemd en esta tarea.
3. Comando de verificación y resultado esperado: `createdb logs_watcher_test` si no existe, y `DATABASE_URL=postgres://127.0.0.1/logs_watcher_test node --test test/config.test.js` sale 0. `phases.cicd` parseado es `false`. `dryRun()` es `true`.

**Impacto operativo:**

- Migración/compatibilidad: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/schema.sql`. Se puede repetir.
- Rollback: parar el proceso. Borrar las cinco tablas si el VPS todavía no tiene filas que conservar.
- Observabilidad: `healthz` no incluye secretos ni conteos.

**Evidencia de finalización:** la prueba sale 0 y un `targets` vacío no abre sockets hacia GitHub, Sentry ni PostHog.

### Tarea: Webhooks firmados e inbox

**Skill:** generación con `skills/ponytail/SKILL.md` (nivel `full`). Revisión con `skills/ponytail-review/SKILL.md`.

**Resultado verificable:** una firma mala no inserta. Una entrega repetida no crea un segundo job. El request no llama al modelo.

**Archivos:**

- Crear: `src/http.js`, `src/queue.js`, `test/http.test.js`.
- Modificar: `src/main.js`.
- Probar: `test/http.test.js`.

**Interfaces:**

- Consume: `POST /webhooks/sentry/{targetId}` y `POST /webhooks/github`. Cabeceras `Sentry-Hook-Signature`, `Sentry-Hook-Timestamp`, `Request-ID`, `X-Hub-Signature-256`, `X-GitHub-Delivery`. Secreto del target (`webhookSecretEnv`) y `GITHUB_WEBHOOK_SECRET`.
- Produce: una fila de `inbox`. Un job `classify_and_file` solo para Sentry aceptado de un target activo. GitHub solo llena `inbox`.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `node --test test/http.test.js` falla porque `src/http.js` no existe. Casos: firma distinta, 401 y cero filas; timestamp de Sentry a más de 300 segundos, 401 y cero filas; cuerpo de más de 1 000 000 bytes, 413 y cero filas; la misma `Request-ID` dos veces, una fila y un job; `X-GitHub-Delivery` repetido, una fila y cero jobs; `targetId` desconocido, 404; target con `owner` vacío, 200, fila `target_inactive` y cero jobs; recurso de Sentry no aceptado, 204 y cero jobs.
2. Implementación mínima: HMAC-SHA256 hexadecimal con `crypto.timingSafeEqual`. El JSON se parsea después de la firma. La clave de Sentry es `{targetId}:{Request-ID}` o `{targetId}:{sha256 del cuerpo}`. La de GitHub es `X-GitHub-Delivery`. En el manejador de GitHub, un comentario de una línea: `shortcut: la entrega queda en inbox y este corte no encola; reabrir cuando exista el consumidor.` No se registra `POST /webhooks/logs/...`.
3. Comando de verificación y resultado esperado: `node --test test/http.test.js` sale 0. Un spy de `fetch` no se llama durante el request.

**Impacto operativo:**

- Migración/compatibilidad: ninguna tabla nueva.
- Rollback: quitar las dos rutas y parar el proceso. Las filas de `inbox` se quedan.
- Observabilidad: log JSON con `msg` `webhook_rejected` o `event_dropped`. Sin cuerpo y sin cabecera de firma en el log.

**Evidencia de finalización:** la prueba sale 0. `git grep -n webhooks/logs -- src` no devuelve una ruta.

### Tarea: Cola y clasificación

**Skill:** generación con `skills/ponytail/SKILL.md` (nivel `full`). Revisión con `skills/ponytail-review/SKILL.md`.

**Resultado verificable:** un job de Sentry aceptado guarda `groups.class` y `groups.priority` según la rúbrica. No abre un issue de GitHub.

**Archivos:**

- Crear: `src/classify.js`, `src/scrub.js`, `src/worker.js`, `test/classify.test.js`.
- Modificar: `src/queue.js`.
- Probar: `test/classify.test.js`.

**Interfaces:**

- Consume: la rúbrica y el filtro del worker en `03-specification.md` (Filtro de un evento de Sentry, Rúbrica de severidad). `GET {baseUrl}/api/0/issues/{id}/` y `GET {baseUrl}/api/0/issues/{id}/events/latest/` contra un stub. `SENTRY_AUTH_TOKEN` si hace falta leer.
- Produce: `groups` (`class`, `priority`, `github_issue_number` null, `importance` y `urgency` null). Job `done`, `dead` o `deferred_budget`. Fila de `cost_ledger` solo si hubo llamada.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `node --test test/classify.test.js` falla porque `src/classify.js` no existe. Una tabla, una aserción por fila de la rúbrica: no capturada en `/login` es `blocker` / `P0`; no capturada en `/api/orders` es `truncated`; 500 capturado en `/checkout` es `flow-blocked`; capturada con estado menor que 500 es `non-blocking`; cron sin `user`, `request` ni tag `url` es `no-user-impact`; cita que no está en el evento es `unclassified` y no hay propuesta. Además: 4xx con el proceso no terminado no clasifica; `org` vacío termina en `config_missing` sin llamada; `productionEnvironments` vacío termina en `production_environments_empty`; un segundo evento del mismo grupo con el job en `running` pone `dirty` y no inserta otra clave; `locked_at` de más de 5 minutos vuelve a `queued`; libro del día UTC por encima de 5.00 USD deja `deferred_budget` y no llama; un token `ghp_` o un correo no salen del proceso.
2. Implementación mínima: `classify` es una función pura. El worker toma un job con `FOR UPDATE SKIP LOCKED`. Si faltan booleanos y no hay `LLM_API_KEY` o `LLM_MODEL`, la clase es `unclassified`. Si están, una sola llamada `POST {base}/chat/completions`, temperatura 0, al stub o a la base de ADR-0025, con el texto dentro de `<untrusted>`. El sistema de clasificación es el de la arquitectura. Una cita que no sea literal se tira. `src/scrub.js` aplica el orden de patrones de la arquitectura. No hay llamada a `https://api.typesafe.ai`. `github_issue_number` se queda null.
3. Comando de verificación y resultado esperado: `node --test test/classify.test.js` sale 0. Ningún URL pedido empieza por `https://api.github.com`.

**Impacto operativo:**

- Migración/compatibilidad: ninguna tabla nueva. `cost_ledger.kind` de esta llamada es `classify`.
- Rollback: parar el proceso. Los jobs `running` vuelven a la cola a los 5 minutos.
- Observabilidad: `msg` `config_missing`, `event_dropped`, `budget_deferred` o `job_dead`. `last_error` pasa por el depurador.

**Evidencia de finalización:** la prueba sale 0 y `groups` tiene clase sin número de issue.

### Tarea: Propuestas guardadas, sin escritura a GitHub

**Skill:** generación con `skills/ponytail/SKILL.md` (nivel `full`). Revisión con `skills/ponytail-review/SKILL.md`.

**Resultado verificable:** una clase `blocker`, `truncated` o `flow-blocked` con modelo configurado guarda una fila en `proposals` y no llama a GitHub. Las otras clases no guardan propuesta.

**Archivos:**

- Crear: `src/propose.js`, `test/propose.test.js`.
- Modificar: `src/worker.js`.
- Probar: `test/propose.test.js`.

**Interfaces:**

- Consume: la misma llamada de ADR-0007 y ADR-0025, sistema de fix de la arquitectura. Un repo git temporal. `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`.
- Produce: `proposals` con `state` `pending`, `github_pr_number` null, `generation_key` única (`fix:` más la `generationKey` de la especificación) y `payload.dryRun` `true` cuando `dryRun()` es verdadero. `cost_ledger.kind` `propose`.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `node --test test/propose.test.js` falla porque `src/propose.js` no existe. Casos: sin clave o sin modelo, cero propuestas; `before` repetido, path `package.json` o `catch` vacío, cero filas `pending`; `git apply --check` fallido, cero filas `pending`; clase `non-blocking`, cero propuestas; clase `truncated` con stub que devuelve un parche válido, una fila y cero requests a `api.github.com` tanto con el flag ausente como con `LOGS_WATCHER_DRY_RUN=false`.
2. Implementación mínima: no existe una función que haga `POST` a GitHub. El parche se valida en un directorio temporal y el directorio se borra en `finally`. Tope de 8 archivos y 400 líneas, el de `limits`. Un `payload` sin depurar no sale. Si el presupuesto del día ya llegó al tope, el job queda `deferred_budget` y no hay segunda llamada.
3. Comando de verificación y resultado esperado: `node --test` sale 0. `git grep -n api.github.com -- src` no muestra una escritura. Con `LOGS_WATCHER_DRY_RUN=false` el mismo spy sigue en cero llamadas: este corte no tiene escritor que encender.

**Impacto operativo:**

- Migración/compatibilidad: ninguna tabla nueva.
- Rollback: parar el proceso. Las propuestas se quedan en Postgres. No hay PR que cerrar.
- Observabilidad: `msg` `proposal_stored` con el id de la fila, sin el parche en el log.

**Evidencia de finalización:** `node --test` sale 0. Una corrida de fixture deja `github_pr_number` null.

### Tarea: Cuentas, diez filas, y el flag en otro cambio

**Resultado verificable:** el VPS sigue en seco. Hay al menos diez filas revisadas. El flag no se pone en `false` en esta tarea.

**Archivos:**

- Crear: ninguno.
- Modificar: `/etc/logs-watcher/config.json` y el archivo de entorno de systemd en el VPS, modo `640` y `600`, fuera de git. Este repo no los lleva.
- Probar: ninguno. Esta tarea no genera código ni abre una revisión de diff.

**Interfaces:**

- Consume: las filas de `groups` y `proposals`. Las cuentas, cuando existan.
- Produce: una nota de revisión con el conteo. El flag sigue en `true`.

**Pasos:**

1. Prueba o comprobación que debe fallar antes del cambio: `psql "$DATABASE_URL" -c "SELECT count(*) FROM groups"` más `SELECT count(*) FROM proposals` da menos de 10, o nadie ha leído las filas.
2. Implementación mínima: no hay código. En el VPS, usuario de sistema `logs-watcher`, Postgres solo en localhost, unidad systemd `logs-watcher.service` con `Restart=on-failure` y el entorno en un archivo modo `600`. `LOGS_WATCHER_DRY_RUN` no se define, o vale `true`. Configuración vacía hasta que existan las cuentas. Esas cuentas, antes de salir del modo en seco, son: la GitHub App con Contents, Pull requests e Issues, sin Workflows (ADR-0004); la clave de Qwen Cloud del operador en `LLM_API_KEY` y el id en `LLM_MODEL`, sin clave compartida (ADR-0025); el primer target con `owner`, `name`, Sentry (`org`, `project`, `productionEnvironments`) y `posthog.projectId`. Lo que falte deja esa vía en `config_missing`, `production_environments_empty` o el target inactivo. `phases.cicd` no se pone en `true`.
3. Comando de verificación y resultado esperado: la suma de filas de `groups` y `proposals` es al menos 10. Una persona las lee (`class`, `priority`, `state`, `payload` depurado). `systemctl show logs-watcher -p Environment` no contiene `LOGS_WATCHER_DRY_RUN=false`. No hay archivos bajo `.github/workflows/`.

**Impacto operativo:**

- Migración/compatibilidad: el `pg_dump` diario de la arquitectura puede esperar a que haya filas reales. Siete copias, sin sacarlas del VPS.
- Rollback: `systemctl stop logs-watcher`. Volver a una configuración sin target. No hay escritura remota que deshacer.
- Observabilidad: `journalctl -u logs-watcher` muestra `webhook_rejected`, `event_dropped`, `proposal_stored` o `job_dead`. Sin cuerpos.

**Evidencia de finalización:** nota con el número de filas leídas, las cuentas que ya existen y las que faltan, y el flag todavía distinto de `false`. El cambio que lo ponga en `false` es otro. Tiene que traer el escritor de GitHub, que este plan no incluye, y solo después de esta nota. La fase de CI sigue apagada hasta que ese bucle de fix exista.
