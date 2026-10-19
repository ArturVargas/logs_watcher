# Especificación

## Problema y usuario

Artur necesita enterarse de los fallos reales de su aplicación y de los puntos donde los usuarios se atascan, sin vigilar a mano Sentry y PostHog. Hoy un error puede quedar solo en Sentry, y un abandono de pago o de formulario solo en una sesión.

logs_watcher es un servicio que hace dos trabajos distintos:

- La vía Sentry abre un issue de GitHub por cada fallo aceptado, dice qué hace el error, con qué contexto, a qué afecta y de qué clase es, y abre un PR de arreglo cuando la clase es un fallo real. Una persona aprueba. El servicio no fusiona.
- La vía PostHog abre otro tipo de issue, para diseño y producto, cuando hay errores mostrados al usuario, validaciones que fallan, fricción o abandonos. En esta fase no arregla código.

Quien aprueba es cualquier colaborador con asociación `OWNER`, `MEMBER` o `COLLABORATOR` en el repositorio vigilado (ADR-0003). Quien implementará el servicio, más adelante, es la cuenta `el-chalan-dev`. La identidad que abre issues y PRs en la aplicación es una GitHub App (ADR-0004).

## Resultado esperado

Con la fase 1 en marcha y las decisiones abiertas resueltas:

1. Un fallo nuevo de Sentry en un entorno de producción aceptado produce un solo issue de GitHub, con la plantilla de Sentry, las etiquetas de esa vía y una clase de la rúbrica.
2. Si la clase es `blocker`, `truncated` o `flow-blocked`, el servicio abre un PR de arreglo ligado a ese issue. El PR no se fusiona solo. Tras el comentario exacto `/logs-watcher approve`, queda marcado como aprobado y espera el merge de una persona.
3. Si ese arreglo, u otro PR de código, deja `docs/` desfasado, el servicio propone el parche de documentación en la misma rama del fix o en un PR de docs aparte.
4. Cada seis horas, PostHog produce issues de hallazgo con la plantilla de PostHog y sin PR.
5. Repetir el mismo webhook, el mismo grupo de Sentry o el mismo hallazgo no abre un segundo issue.
6. Stacks, diffs, sesiones y cuerpos de issues no se ejecutan como instrucciones.

Un fallo real, para el PR automático, es un evento que pasó los filtros y cuya clase es `blocker`, `truncated` o `flow-blocked` (ADR-0011). Las otras clases sí generan issue.

Los ADR aceptados que esta especificación no reabre están en `.ai/adr/`.

## Alcance

### Fase 1, que es el MVP

Un servicio desplegable en un VPS (ADR-0006) que:

- recibe webhooks de Sentry y de la GitHub App, comprueba la firma y encola trabajo;
- agrupa por el issue de Sentry, clasifica con la rúbrica y abre o actualiza el issue de GitHub;
- propone un fix y, si aplica, un parche de `docs/`;
- barre PostHog y abre issues de hallazgo;
- guarda cola, propuestas y punteros en Postgres;
- corta el gasto del modelo y reintenta los fallos transitorios (ADR-0016).

El primer arranque es en seco: `LOGS_WATCHER_DRY_RUN=true` guarda propuestas y no llama a ningún endpoint de escritura de GitHub. Si el modelo está configurado, las llamadas sí se hacen y cuentan para el tope. El orden de puesta en marcha está en la arquitectura, sección Operación.

### Vía Sentry

Cubre ingesta, deduplicación, rúbrica, plantilla de issue, PR de fix, guardarraíles, actualización del ticket y deriva de docs del propio fix.

### Vía PostHog

Cubre errores mostrados (`$exception`), fricción (`$rageclick`, `$dead_click`), validaciones configuradas y abandonos de embudos configurados. Solo documenta.

### Fases posteriores

No se construyen ahora. El diseño no las cierra por dentro: el puerto `IssueTracker` admite otro adaptador (Linear, ADR-0001) y el puerto `DocsPublisher` admite otro publicador (Mintlify, ADR-0002). Los embeddings de docs quedan fuera hasta que un ADR nuevo los active (ADR-0012). Ampliar el auto-fix a otras clases exige reabrir ADR-0011. Añadir otro repositorio no es una fase posterior: es otra entrada en `targets` (ADR-0017).

### Targets

Decisión cerrada en ADR-0017. OQ-1 ya no es una pregunta de producto.

El `owner` y el `name` de GitHub de la aplicación vigilada siguen sin conocerse. No hay repositorio por defecto y esta especificación no inventa uno.

El MVP vigila un solo proyecto. El servicio modela el blanco como una colección desde el principio: hoy puede haber una entrada y más adelante varias. Añadir repositorios o aplicaciones es configuración, no un rediseño.

Un target ata una aplicación: su repositorio de GitHub, su proyecto de Sentry y su proyecto de PostHog.

`owner` y `name` son configuración obligatoria de despliegue para que ese target actúe. Hasta que estén configurados, la GitHub App no tiene dónde instalarse y no se abre ningún issue. Una configuración vacía (`targets` vacío, o un target con `owner` o `name` vacíos) es válida. El resto de la especificación no queda bloqueada por no conocer el repositorio hoy.

OQ-2, OQ-3 y OQ-4 siguen abiertas y se responden para ese primer target. Sus valores son configuración de ese target.

Un target está activo solo cuando `github.owner` y `github.name`, ya recortados, no están vacíos. Un target inactivo no llama a GitHub, a Sentry ni a PostHog y no abre issues. El webhook de Sentry de ese `id` responde 200, guarda la entrega y la marca `target_inactive`. Un `id` que no está en `targets` responde 404. Un evento de GitHub cuyo repositorio no coincide con ningún target activo responde 200 y no encola.

`id` del target coincide con `^[a-z0-9][a-z0-9-]{0,39}$`. En el ejemplo, `primary` es solo la clave de esa entrada. No es un owner ni un nombre de repositorio. La rama base no se configura: se lee `default_branch` del repositorio de ese target cuando el target está activo.

### Configuración que el servicio no inventa

Archivo `/etc/logs-watcher/config.json`, modo `640`, fuera de git. El proceso arranca con `targets` vacío o con entradas inactivas. Si a un target activo le falta un proveedor, esa vía de ese target no llama al proveedor y registra `config_missing`.

```json
{
  "targets": [
    {
      "id": "primary",
      "github": { "owner": "", "name": "", "installationId": "" },
      "sentry": {
        "baseUrl": "https://sentry.io",
        "org": "",
        "project": "",
        "webhookSecretEnv": "SENTRY_WEBHOOK_SECRET",
        "authTokenEnv": "SENTRY_AUTH_TOKEN",
        "productionEnvironments": [],
        "blockerTransactions": ["/", "/login", "/signup", "/auth/callback"],
        "ignoreTitlePatterns": [
          "ResizeObserver loop",
          "AbortError",
          "Network request failed",
          "Load failed",
          "Non-Error promise rejection captured"
        ]
      },
      "posthog": {
        "host": "",
        "projectId": "",
        "apiKeyEnv": "POSTHOG_API_KEY",
        "validationEvents": [],
        "funnels": []
      },
      "llm": {
        "baseUrlEnv": "LLM_BASE_URL",
        "apiKeyEnv": "LLM_API_KEY",
        "modelEnv": "LLM_MODEL"
      },
      "testCommand": null
    }
  ],
  "limits": {
    "dailyBudgetUsd": 5,
    "inputUsdPerMillion": 0.4,
    "outputUsdPerMillion": 1.6,
    "maxFixFiles": 8,
    "maxFixChangedLines": 400,
    "promptCharCap": 80000,
    "maxOutputTokens": 4096
  }
}
```

`targets: []` es válido y equivale a no vigilar nada. `testCommand` es `null` o una lista de argv, por ejemplo `["npm", "test"]`. No es una cadena de shell. `github.installationId` vacío usa `GITHUB_INSTALLATION_ID`. `funnels[].id` es estable. Cada paso tiene `event`. No hay pasos por defecto. El tope de coste sigue siendo del proceso, compartido por todos los targets.

Variables de entorno, también fuera de git:

| Variable | Efecto si falta |
| --- | --- |
| `DATABASE_URL` | El proceso no arranca. |
| `LOGS_WATCHER_CONFIG` | Ruta por defecto `/etc/logs-watcher/config.json`. |
| `LOGS_WATCHER_DRY_RUN` | Por defecto `true` hasta que una persona lo ponga en `false`. |
| `SENTRY_WEBHOOK_SECRET`, `SENTRY_AUTH_TOKEN` | La vía Sentry del target que las referencia no procesa. |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_INSTALLATION_ID` | No hay escritura ni lectura de GitHub. La clave por defecto es `/etc/logs-watcher/github-app.pem`. `GITHUB_INSTALLATION_ID` solo se usa si el target deja `installationId` vacío. |
| `POSTHOG_API_KEY` | No hay barrido de PostHog del target que la referencia. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | No hay llamadas al modelo del target que las referencia. La plantilla determinista sigue en pie. |
| `ALERT_WEBHOOK_URL` | Las alertas quedan solo en el log y en la tabla `alerts`. |

Esos nombres son los que referencia el target de ejemplo. Otro target puede nombrar otras variables. Si la variable que ese target referencia no está, esa vía de ese target no llama al proveedor. `GITHUB_INSTALLATION_ID` vacío y `github.installationId` vacío impiden la API de GitHub de ese target aunque owner y name ya estén puestos.

## Fuera de alcance

- Código de aplicación, plan de implementación y merge de esta especificación.
- Arreglo automático de hallazgos de PostHog, de clases `non-blocking`, `no-user-impact` y `unclassified`, y de cualquier evento filtrado.
- Descargar o enlazar session replay. Guardar `distinct_id`, correo, IP o texto libre de la UI.
- Linear, Mintlify y embeddings.
- Alta disponibilidad y más de un worker. Vigilar otro repositorio no está fuera de alcance: es otra entrada de `targets`.
- Editar workflows de CI, lockfiles, manifiestos de dependencias o archivos de `.github/`.
- Ejecutar como instrucción el texto que venga en un stack, un diff o un comentario que no sea un comando exacto.
- Fusionar PRs, activar auto-merge o aprobar con la propia App.
- Inventar nombres de eventos de pago, de formularios o de entornos de producción.

## Flujo principal

### Filtro de un evento de Sentry

El webhook de Sentry es `POST /webhooks/sentry/{targetId}`. Responde en menos de 2 segundos: verifica la firma con la variable nombrada en `webhookSecretEnv` de ese target, inserta `inbox` con clave `{targetId}:{delivery}` y, si el recurso se acepta y el target está activo, encola `classify_and_file`. No descarta por entorno ni por `handled` en el request. Esos filtros corren en el worker, cuando ya leyó el último evento.

Firma: HMAC-SHA256 en hexadecimal del cuerpo crudo, cabecera `Sentry-Hook-Signature`, comparación en tiempo constante. Si `Sentry-Hook-Timestamp` viene y se aleja más de 300 segundos, se responde 401 y no se inserta. Recursos aceptados: `issue` (acciones `created` y `unresolved`) y `event_alert`. El resto, con firma válida, responde 204 y no encola. El webhook de GitHub es uno, `POST /webhooks/github`, y se enruta por `repository.owner.login` y `repository.name` al target activo.

Clave de entrega de Sentry, ya prefijada: `{targetId}:{Request-ID}` o, si falta la cabecera, `{targetId}:{SHA-256 del cuerpo}`. Repetida: 200 y fin. GitHub usa `X-GitHub-Delivery`.

Si el target está inactivo, el job no llega a crearse. Si está activo y `sentry.org` o `sentry.project` están vacíos, el job termina con `config_missing` y no llama a la API. Con la configuración puesta, el worker lee el último evento y descarta en este orden:

1. El tipo del evento es `transaction`.
2. `level` es `info` o `debug`.
3. `productionEnvironments` está vacío, o `environment` no está en esa lista.
4. El título contiene, sin distinguir mayúsculas, algún `ignoreTitlePatterns`.
5. Hay un estado HTTP entre 400 y 499 y el proceso no está terminado (la regla de `processTerminated` de más abajo). Motivo `handled_4xx`.

Lo descartado actualiza la fila de `inbox` con el motivo y termina el job en `done`. No abre issue. Variables locales del frame (`vars`) se eliminan antes de guardar y antes de cualquier prompt.

Al empezar `classify_and_file` el worker pone `groups.dirty` en falso. Si durante el job llega otro evento del mismo target y del mismo id de Sentry, solo marca `dirty`. Al terminar, si `dirty` es verdadero, el mismo row vuelve a `queued`. No se inserta otro job. La clave del grupo es `targetId` más `sentryIssueId`.

### Datos que se leen de Sentry

`GET {baseUrl}/api/0/issues/{id}/` y `GET {baseUrl}/api/0/issues/{id}/events/latest/`.

Se usan, y nada más para decidir: `exception.values[].mechanism.handled`, `exception.values[].mechanism.type`, `exception.values[].type`, `exception.values[].value`, `exception.values[].stacktrace.frames[]` (`filename`, `function`, `lineNo`, `inApp`), tags `handled`, `transaction`, `url`, `environment`, `release`, `contexts.response.status_code`, tag `http.status_code`, `level`, `userCount`, `count`, `stats.24h`, `permalink`, `culprit`, `title`, `release`. De `user` solo importa si la clave existe. No se copia `id`, `email` ni `ip_address`.

`eventCount24h` es la suma de los conteos de `stats.24h`. Si el campo no viene, el issue dice `no disponible` y no se estima. `userCount` es el total que devuelve Sentry, no una ventana de 24 horas.

### Rúbrica de severidad

Los booleanos los rellena el servicio. El modelo no elige la clase (ADR-0010). Primera regla que acierta, y se para.

`processTerminated`:

1. `true` si algún `mechanism.handled` es `false`.
2. `true` si algún `mechanism.type` es `onunhandledrejection` u `onerror`.
3. `true` si el tag `handled` es `no` o `false`.
4. `false` si todos los valores de excepción tienen `mechanism.handled` `true`.
5. `false` si el tag `handled` es `yes` o `true`.
6. Si no, queda vacío.

`userFlowInvolved`:

1. `false` si no hay clave `user`, ni `request`, ni tag `url`.
2. `true` si hay clave `user`, o `request`, o tag `url`.
3. Una transacción sola, sin usuario ni request ni url, no cuenta como flujo de usuario. Cae en la regla 1.

`userCanUseApp`, solo si `userFlowInvolved` es `true`:

1. Vacío si no hay tag `transaction` ni pathname de request.
2. `false` si ese pathname o esa transacción está en `blockerTransactions` y (`processTerminated` es `true` o el estado HTTP es mayor o igual que 500).
3. `true` si hay pathname o transacción y la regla 2 no acertó.

El pathname no incluye query. La comparación es exacta, sin barra final extra: `/login/` no es `/login`.

`userFlowCompletes`, solo si `userFlowInvolved` es `true`:

1. `false` si `processTerminated` es `true`.
2. `false` si el estado HTTP es mayor o igual que 500.
3. `true` si `processTerminated` es `false`, hay estado HTTP y es menor que 500.
4. `true` si `processTerminated` es `false` y `level` es `warning`.
5. Si no, queda vacío.

Clase, en este orden:

1. Si `userFlowInvolved` es `false`, la clase es `no-user-impact`. Los otros booleanos pueden faltar.
2. Si `userFlowInvolved` es `true` y falta cualquiera de los otros tres, y el modelo está configurado, el job hace una llamada LLM para rellenar solo los que faltan. Cada valor viene con una cita de al menos 8 caracteres, literal en el evento ya depurado. Un campo que el extractor ya fijó se descarta. Si el modelo no está configurado, o después de la llamada sigue faltando alguno, la clase es `unclassified`.
3. Si `userCanUseApp` es `false`, la clase es `blocker`.
4. Si `processTerminated` es `true` y `userFlowCompletes` es `false`, la clase es `truncated`.
5. Si `userFlowCompletes` es `false`, la clase es `flow-blocked`.
6. Si `userFlowCompletes` es `true`, la clase es `non-blocking`.

| Situación | Clase |
| --- | --- |
| Excepción no capturada en `/` o `/login` | `blocker` |
| Excepción no capturada en `POST /api/orders`, con el resto de la aplicación usable | `truncated` |
| 500 capturado en `/checkout`, la UI muestra el error y otras rutas siguen | `flow-blocked` |
| Excepción capturada, la compra termina, el estado es menor que 500 | `non-blocking` |
| Cron o job sin `user`, sin `request` y sin tag `url` | `no-user-impact` |
| Hay usuario o request, pero no hay transacción ni `handled` ni estado, y la cita del modelo no valida | `unclassified` |

Prioridad, sin cambiar la clase:

| Clase | Prioridad |
| --- | --- |
| `blocker` | `P0` |
| `truncated` y `userCount` mayor o igual que 25 | `P0` |
| `truncated` | `P1` |
| `flow-blocked` y `userCount` mayor o igual que 25 | `P1` |
| `flow-blocked` | `P2` |
| `non-blocking`, y `userCount` mayor o igual que 25 o `eventCount24h` mayor o igual que 200 | `P2` |
| `non-blocking` | `P3` |
| `no-user-impact` y `eventCount24h` mayor o igual que 200 | `P2` |
| `no-user-impact` | `P3` |
| `unclassified` | sin prioridad |

Si `eventCount24h` es `no disponible`, no se usa para subir la prioridad.

### Plantilla del issue de Sentry

Un issue por `sentry_issue_id` (ADR-0015). Título, como máximo 120 caracteres: `[{severityClass}] {exceptionType}: {culprit}`. Si no hay tipo: `[{severityClass}] Error sin tipo: {culprit}`.

Cuerpo, con los tokens sustituidos por el servicio. El párrafo no lo redacta el modelo (ADR-0007, ADR-0014).

```markdown
<!-- logs-watcher-sentry-issue: {sentryIssueId} -->
<!-- logs-watcher-generation: {generationKey} -->

## Qué hace el error

Excepción {exceptionType} en {culprit}. El nivel que envía Sentry es {level}. El mecanismo handled es {handled}.

## Contexto

- Stack:
{stack}
<!-- logs-watcher-facts:start -->
- Release: {release}
- Entorno: {environment}
- Rutas afectadas: {routes}
- Usuarios afectados (conteo): {userCount}
- Frecuencia: {eventCountTotal} en total, {eventCount24h} en las últimas 24 h según Sentry
- Evento más reciente: {eventId}
<!-- logs-watcher-facts:end -->

## Qué afecta

El alcance para el usuario es la clase de severidad de abajo. Rutas, conteos y frecuencia están en el bloque de hechos.

## Severidad

<!-- logs-watcher-severity:start -->
- Clase: {severityClass}
- Prioridad: {priority}
<!-- logs-watcher-severity:end -->
<!-- logs-watcher-evidence:start -->
{evidenceBullets}
<!-- logs-watcher-evidence:end -->

## Fuentes

- Sentry: {sentryUrl}
- Evento: {eventId}

<!-- logs-watcher-progress:start -->
- Estado del fix: {progressState}
<!-- logs-watcher-progress:end -->
```

`{stack}` son como máximo 5 líneas `{filename}:{line} {function}`, primero las que tengan `inApp` verdadero. Si no hay frames: `no disponible`. `{routes}` sale del tag `transaction` y del pathname; si no hay ninguno: `desconocida`. `{release}` sale de `release` o del tag; si no hay: `desconocida`. `{evidenceBullets}` son viñetas con citas literales ya depuradas, de al menos 8 caracteres, tomadas del título, del `culprit`, del tipo, del mensaje recortado a 300 caracteres y del primer frame. `{handled}` es `true`, `false` o `desconocido`.

Estados de `{progressState}`: `detectado` mientras un fix elegible aún no tiene PR; `sin-fix-automatico` al crear el issue si la clase es `non-blocking`, `no-user-impact` o `unclassified`; `propuesta-abierta`, `aprobada`, `obsoleta`, `rechazada` y `resuelta` cuando el flujo del PR llega a ese punto.

Etiquetas que el servicio crea si no existen: `logs-watcher` (`1d4ed8`), `logs-watcher:sentry` (`b91c1c`), `logs-watcher:approved` (`15803d`), `logs-watcher:stale` (`a16207`), `tests:missing` (`a16207`), `severity:blocker` (`7f1d1d`), `severity:truncated` (`c2410c`), `severity:flow-blocked` (`b45309`), `severity:non-blocking` (`0369a1`), `severity:no-user-impact` (`334155`), `severity:unclassified` (`64748b`), `priority:p0` (`7f1d1d`), `priority:p1` (`c2410c`), `priority:p2` (`b45309`), `priority:p3` (`0369a1`), `auto-fix:no` (`334155`). Cada issue de Sentry lleva `logs-watcher`, `logs-watcher:sentry`, una sola `severity:*` y, si no es `unclassified`, una sola `priority:*`. Las clases sin PR llevan además `auto-fix:no`. `logs-watcher:approved` y `logs-watcher:stale` van en el PR, no en el issue.

El servicio solo reemplaza los bloques `logs-watcher-facts`, `logs-watcher-severity`, `logs-watcher-evidence` y `logs-watcher-progress`, y solo si cada par de marcadores aparece una sola vez (ADR-0008). El comentario de generación del encabezado es el de la creación y no se reescribe. Hechos y severidad se actualizan en cada evento aceptado. La etiqueta `severity:*` y, si aplica, `priority:*` se sustituyen por la clase nueva. La evidencia se reemplaza solo si cambió el frame superior (`filename` más `function`). Si un bloque no está o está repetido, se comenta y se marca `progress_stale`. No se reescribe el issue entero.

`generationKey` del issue de Sentry: SHA-256 hexadecimal de `issue\n{targetId}\n{sentryIssueId}\n{latestEventId}`.

### Agrupación y deduplicación

- La clave de grupo de Sentry es el id de issue de Sentry. No se calcula otro fingerprint (ADR-0015).
- Antes de crear, se busca la fila local y el marcador `logs-watcher-sentry-issue: {id}` en GitHub. Si la búsqueda devuelve varios, se usa el número menor y se comenta en los demás `duplicado de #{n}` sin cerrarlos.
- Un evento posterior del mismo id actualiza el mismo issue. Si estaba cerrado, se reabre.
- PostHog usa `dedupeKey` = SHA-256 de `posthog\n{targetId}\n{type}\n{pathname}\n{signature}`. Misma regla de un issue de por vida, dentro de ese target.
- Firmas: `error-shown` es tipo de excepción más el mensaje en minúsculas, con las tandas de dígitos cambiadas por `#`, espacios colapsados y recorte a 120 caracteres. `friction` es nombre del evento más pathname más tag. `validation` es nombre del evento más pathname. `drop-off` es id del embudo más el índice del paso de origen. El texto interior del elemento no entra en la firma.
- Comentarios de actualización: `<!-- logs-watcher-update: {id} -->`, con `{id}` igual al id de evento o al fin de ventana. Si el marcador ya existe, no se comenta otra vez.

### Flujo del agente de fix

Solo para `blocker`, `truncated` y `flow-blocked`. Rama: `logs-watcher/fix-{targetId}-{sentryIssueId}-{8 primeros hex de generationKey}`. `generationKey` del fix: SHA-256 de `fix\n{targetId}\n{sentryIssueId}\n{latestEventId}\n{baseSha}`.

Pasos:

1. Clonar con profundidad 1 la rama por defecto, con el installation token, en `/var/lib/logs-watcher/work/{proposalId}`. Borrar ese directorio al terminar el job, bien o mal.
2. Una llamada LLM con el evento depurado, la lista de archivos que el stack cita y que existan en el clon (como máximo 8, 20 000 caracteres cada uno) y el esquema de abajo. El texto va dentro de `<untrusted>`.
3. Validar. Si falla, una segunda llamada con los códigos de error. Si vuelve a fallar, no hay PR: comentario en el issue con el código `fix_invalid`. El progreso se queda en `detectado`.
4. `git apply --check`. Si no aplica, no hay PR y el comentario lleva `fix_does_not_apply`.
5. Commit en la rama nueva. Mensaje: `fix: {summary}` con colas `Sentry-Issue: {id}` y `GitHub-Issue: {n}`. El `summary` validado tiene como máximo 400 caracteres.
6. Correr la deriva de docs sobre ese diff, antes de abrir el PR. `generationKey` de esa corrida: SHA-256 de `docs\nfix\n{targetId}\n{sentryIssueId}\n{headSha}\n{paths ordenados separados por coma}`. Si hay parches válidos, van en un segundo commit de la misma rama. Si la deriva no produce parche, el fix sigue. La propuesta de docs queda `pending` solo cuando hubo candidatos y la validación falló.
7. Abrir el PR contra `default_branch`, ya con los commits de fix y de docs. Cuerpo con el marcador de propuesta. Escribir en el issue el progreso `propuesta-abierta` y la URL del PR.

Esquema que debe cumplir el modelo:

```json
{
  "refusal": "none",
  "summary": "texto en español, máximo 400 caracteres",
  "evidence": [{ "source": "event", "quote": "cita literal de al menos 8 caracteres" }],
  "patches": [{ "path": "src/orders.ts", "before": "texto exacto", "after": "texto de reemplazo" }],
  "newTests": [{ "path": "src/orders.test.ts", "content": "archivo completo" }]
}
```

`refusal` es `none`, `insufficient_evidence`, `unsafe_scope` o `no_code_fix`. Distinto de `none`: `patches` y `newTests` vacíos, no hay PR, comentario con ese código. `source` es `event`, `file` o `issue`.

Guardarraíles del validador. Si uno falla, no hay PR:

- Al menos una evidencia, y cada `quote` es subcadena de la fuente depurada que declara.
- Entre 1 y 8 parches, y la suma de líneas añadidas y quitadas no pasa de 400.
- `path` relativo, sin `..`, sin absoluto, sin prefijo `.git/`, `.github/` o `secrets/`, y sin estos nombres: `package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `go.mod`, `Gemfile`, `requirements.txt`, `Cargo.toml`, `Dockerfile`, `docker-compose.yml`, ni sufijos `.env`, `.pem`, `.key`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `poetry.lock`, `composer.lock`.
- Cada `before` aparece una sola vez en el archivo en `base_sha`.
- Se rechaza un `catch` nuevo cuyo cuerpo, sin comentarios ni espacios, no contiene `throw` ni `console.` ni `logger` ni `log(`. Un `catch` vacío o que solo hace `return` no pasa.
- Si el repositorio tiene `tests/`, `__tests__/`, o algún archivo `*.test.*` o `*.spec.*` en `js`, `jsx`, `ts`, `tsx`, `py`, `go` o `rb`, `newTests` trae al menos un archivo que encaje con ese layout. Si no hay layout, `newTests` es `[]` y el PR lleva `tests:missing`.
- Si `testCommand` no es null, el worker ejecuta ese argv en el clon, con tope de 10 minutos, y sin las variables `DATABASE_URL`, `LLM_API_KEY`, `SENTRY_AUTH_TOKEN`, `SENTRY_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY_PATH` ni `POSTHOG_API_KEY`. Si el comando sale distinto de cero, no se abre el PR y el comentario lleva `tests_failed`. Si es null, no se ejecuta y el PR puede abrirse con `tests:missing` (ADR-0011).
- Un frame cuyo archivo esté en la lista denegada no autoriza a parchearlo. Comentario `fix_blocked_denied_path`.

Cuerpo del PR:

```markdown
<!-- logs-watcher-proposal: {proposalId} -->
<!-- logs-watcher-generation: {generationKey} -->

## Qué cambia

{summary}

## Evidencia

{evidenceBullets}

## Severidad

- Clase: {severityClass}
- Prioridad: {priority}
- Issue: #{issueNumber}

## Documentación

{docsStatus}

## Aprobación

El servicio no fusiona. Una persona con asociación OWNER, MEMBER o COLLABORATOR escribe exactamente:

/logs-watcher approve

## Fuentes

- Sentry: {sentryUrl}
- Evento: {eventId}
```

`{docsStatus}` es `actualizada en este PR`, `sin impacto` o `pendiente`.

Comandos, solo si el cuerpo recortado es exactamente uno de estos y el autor cumple ADR-0003:

| Comando | Efecto |
| --- | --- |
| `/logs-watcher approve` | Propuesta `approved`, etiqueta `logs-watcher:approved`, progreso `aprobada`. No llama a merge. |
| `/logs-watcher reject` | Propuesta `rejected`, progreso `rechazada`. No cierra el issue. |
| `/logs-watcher refresh` | Solo desde `rejected` o `stale`. Cierra el PR viejo si sigue abierto, crea otra propuesta y otra rama con la base y el evento actuales. |

Un comentario de la propia App, o de cualquier `Bot`, se ignora. El comando en el issue vale si el marcador de Sentry está en ese issue y hay un PR abierto ligado; si no hay PR, se responde `no hay PR abierto`.

Si el PR se cierra y `merged` es verdadero: progreso `resuelta` con el SHA, el issue de GitHub se cierra con razón `completed`, la propuesta sigue `approved`. Si se cierra sin merge: propuesta `rejected`, progreso `rechazada`, el issue sigue abierto.

Si Sentry marca el grupo como resuelto, se comenta y no se cierra el issue de GitHub.

La propuesta pasa a `stale` cuando el parche ya no aplica sobre la base nueva o sobre los blobs nuevos. No hay force-push.

### Deriva de documentación

Se corre dentro del job de fix, antes de abrir el PR, y también en `pull_request` `opened`, `synchronize` y `reopened` cuando la rama no empieza por `logs-watcher/fix-`. Esas ramas ya llevaron la deriva en el job de fix. Un push posterior de una persona sobre `logs-watcher/fix-*` no relanza la deriva.

1. Listar archivos del PR, como máximo 100. Si hay más, no se llama al modelo, métrica `docs_diff_too_large`, un solo comentario.
2. Si todos los archivos están bajo `docs/` o terminan en `.md` o `.mdx`, fin.
3. Candidatos desde `docs/map.yml` del head, si parsea. Si no parsea, métrica `docs_map_invalid` y se sigue sin esas reglas. Cada `docs` de una regla tiene que vivir bajo `docs/`. Como máximo 100 reglas.
4. Por cada archivo de código cambiado, si el nombre sin extensión o el directorio padre tiene al menos 3 caracteres, añadir docs cuyo path contenga ese token.
5. En las líneas añadidas, tokens de `(?:export )?(?:function|class|const|type|interface) ([A-Za-z_][A-Za-z0-9_]{2,})`. Búsqueda literal en docs. Primero los aciertos del mapa, luego los símbolos, luego el nombre. Tope 15 archivos.
6. Si hay más de 200 `.md` o `.mdx` bajo `docs/` y la lista queda vacía, métrica `docs_prefilter_empty_large_corpus` y fin. Sin embeddings.
7. Si la lista queda vacía, fin, sin llamada al modelo.
8. Una llamada. Parches solo bajo `docs/`. Mismas reglas de `before` único y de citas. `generationKey` de un PR ya abierto: SHA-256 de `docs\n{targetId}\n{prNumber}\n{headSha}\n{paths ordenados separados por coma}`. La rama de un PR de docs que no es el fix es `logs-watcher/docs-{targetId}-{prNumber}-{8 hex}`.

Formato opcional de `docs/map.yml` en el repositorio vigilado:

```yaml
rules:
  - paths: ["src/billing/**"]
    docs: ["docs/billing.md"]
```

Los globs solo usan `*` y `**`. No son expresiones regulares arbitrarias.

Salida del modelo:

```json
{
  "noChange": false,
  "evidence": [{ "source": "diff", "quote": "cita literal" }],
  "patches": [{ "path": "docs/billing.md", "before": "texto exacto", "after": "texto nuevo" }],
  "newSections": [{ "path": "docs/billing.md", "heading": "## Título", "body": "párrafo" }]
}
```

`source` es `diff` o `doc`. `noChange` verdadero exige listas vacías. Una sección nueva solo se añade si el `heading` no existe ya en el archivo.

Dónde se escribe (ADR-0012):

- PR de fix nuestro: mismo repositorio, rama `logs-watcher/fix-*`, y la fila `proposals` corresponde a ese PR. El parche va en esa rama.
- Otro PR del mismo repositorio: rama `logs-watcher/docs-{prNumber}-{8 hex}` y un PR contra la rama por defecto.
- Fork: no se empuja. Se guarda la propuesta y se comenta `no se escribe en un fork`.

`{docsStatus}` y el marcador `<!-- logs-watcher-proposal: {id} -->` identifican el PR de docs. Si el head cambia y el parche no aplica, la propuesta queda `stale`.

### Vía PostHog

Reloj cada 6 horas en punto UTC, y una vez a los 2 minutos de arrancar el proceso. Un job por target activo con PostHog configurado. Clave del job: `posthog:{targetId}:{fin de ventana en hora UTC}`. Ventana: últimas 24 horas. Sin modelo (ADR-0013).

Consultas a `POST {host}/api/projects/{projectId}/query/` con la clave personal de solo lectura.

Errores mostrados. Abre hallazgo si `events` es mayor o igual que 5.

```sql
SELECT properties.$pathname AS pathname,
       properties.$exception_types AS exception_types,
       count() AS events,
       count(DISTINCT person_id) AS users
FROM events
WHERE timestamp >= now() - INTERVAL 1 DAY
  AND event = '$exception'
GROUP BY pathname, exception_types
HAVING events >= 5
ORDER BY events DESC
LIMIT 50
```

Fricción. Abre hallazgo si `users` es mayor o igual que 5 y `events` mayor o igual que 10. La misma consulta con `$dead_click`.

```sql
SELECT properties.$pathname AS pathname,
       properties.$el_tag AS tag,
       count() AS events,
       count(DISTINCT person_id) AS users
FROM events
WHERE timestamp >= now() - INTERVAL 1 DAY
  AND event = '$rageclick'
GROUP BY pathname, tag
HAVING users >= 5 AND events >= 10
LIMIT 50
```

Validaciones: solo si `validationEvents` no está vacío. Un grupo por nombre de evento y pathname, umbral `events` mayor o igual que 10. Si la lista está vacía, esta consulta no se hace.

Abandono: solo si `funnels` no está vacío. Por cada par de pasos consecutivos, con `FunnelsQuery` y `dateRange.date_from` igual a `-1d`. Se abre hallazgo si el paso de origen tiene al menos 10 usuarios, el cociente destino/origen es menor que 0.5, y la diferencia absoluta es al menos 10. Un issue por par de pasos. Si el embudo no está configurado, no se inventa el pago ni el formulario.

El pathname que se publica lleva la query quitada. La query no se guarda.

### Plantilla del issue de PostHog

Títulos:

- `[posthog][error-shown] {exceptionType} en {pathname}`
- `[posthog][friction] {pathname}`
- `[posthog][validation] {event} en {pathname}`
- `[posthog][drop-off] {funnelId} paso {from} a {to}`

```markdown
<!-- logs-watcher-posthog: {dedupeKey} -->

## Hallazgo

- Tipo: {findingType}

## Qué se observó

En las últimas 24 h, {events} eventos `{event}` en `{pathname}` afectaron a {users} usuarios.

## A quién afecta

Solo conteos. Este issue no identifica personas ni enlaza grabaciones.

## Dónde

- Ruta: {pathname}
- Embudo: {funnelOrNone}
- Paso: {stepOrNone}

## Por qué importa al diseño

{why}

## Fuentes

- PostHog: consulta agregada de las últimas 24 h, ventana que termina {windowEnd}
- Tipo de consulta: {findingType}

## No es un bug para auto-fix

Este issue es para diseño o producto. El servicio no abre un PR a partir de él.

<!-- logs-watcher-counts:start -->
- Eventos: {events}
- Usuarios: {users}
- Ventana fin: {windowEnd}
<!-- logs-watcher-counts:end -->
```

`{why}` es una frase fija según el tipo: `error-shown` dice que el usuario vio un error en esa ruta; `friction` dice que hubo clics repetidos o clics sin efecto; `validation` dice que una validación configurada se disparó sin completar el flujo; `drop-off` dice que el paso siguiente del embudo no se completó por encima del umbral. No hay texto libre del modelo.

Etiquetas: `logs-watcher`, `logs-watcher:posthog` (`7c3aed`), `audience:design` (`6d28d9`), `auto-fix:no`, y una de `finding:friction` (`7c3aed`), `finding:drop-off` (`5b21b6`), `finding:error-shown` (`6d28d9`), `finding:validation` (`4c1d95`). No llevan `severity:*` ni `priority:*`.

El bloque de conteos se reemplaza en cada barrido si los marcadores aparecen una sola vez. Si no, se comenta.

## Criterios de aceptación

| Criterio | Cómo se verificará |
| --- | --- |
| Un webhook con firma mala recibe 401 y no crea fila de `inbox` ni issue. | Prueba con cuerpo firmado con otro secreto. |
| La misma `Request-ID` o el mismo `X-GitHub-Delivery` dos veces deja un solo job. | Insertar la entrega dos veces y contar jobs. |
| Un 401 de login capturado no abre issue. Un 500 no capturado en `/login` abre issue `severity:blocker` y prioridad `P0`. | Fixtures de evento con `mechanism.handled`, status y transacción. |
| Una excepción no capturada en `/api/orders` queda en `truncated`. Un 500 capturado en `/checkout` queda en `flow-blocked`. Una excepción capturada con status 200 queda en `non-blocking` y lleva `auto-fix:no`. Un cron sin request ni usuario queda en `no-user-impact`. | Tabla de fixtures, una aserción por fila de la rúbrica. |
| Si falta un booleano y la cita del modelo no está en el evento, la clase es `unclassified` y no hay PR. | Fixture con cita inventada. |
| Dos eventos del mismo `sentry_issue_id` actualizan un solo issue y no crean otro. | Corrida doble y búsqueda del marcador. |
| El PR de fix no aparece para `non-blocking`. Sí aparece para `truncated`, sin llamada a la API de merge. | Tests del encolado y un doble que falle si se llama a merge. |
| Un parche con `before` repetido, path `package.json`, o `catch` vacío no abre PR. | Tres propuestas inválidas. |
| Cambiar el archivo después del análisis deja la propuesta `stale` y no hace push. | Mover el blob y correr el chequeo. |
| `/logs-watcher approve` escrito por un `COLLABORATOR` marca `approved`. El mismo texto dentro de una frase, o escrito por un `Bot`, no hace nada. | Tres comentarios fixture. |
| Un PR de código que cambia `src/billing/pay.ts` y un mapa que apunta a `docs/billing.md` produce un parche solo bajo `docs/`. | Fixture de diff más `docs/map.yml`. |
| Un PR desde un fork no recibe push. | Head repo distinto del base. |
| La consulta de PostHog no selecciona `distinct_id` ni correo, y el issue no contiene `@` ni la query de la URL. | Aserción sobre el SQL construido y sobre el cuerpo. |
| Con `funnels` vacío no se menciona un pago inventado. | Barrido con configuración vacía. |
| Al superar 5.00 USD en el día UTC, el job de modelo queda `deferred_budget` y el issue determinista de un `blocker` sí se crea. | Libro de coste precargado. |
| `LOGS_WATCHER_DRY_RUN=true` no llama a `POST /repos/.../issues` ni a pulls. | Registro de clientes. |

## Errores y casos límite

| Condición | Detección | Efecto | Reintento |
| --- | --- | --- | --- |
| Firma inválida o timestamp de Sentry fuera de 300 s | HMAC o reloj | 401, sin fila | No |
| Cuerpo mayor de 1 000 000 bytes | Límite al leer | 413, sin fila | No |
| Entrega repetida | Clave única de `inbox` | 200, sin job nuevo | No |
| Inserción en Postgres caída | Error de commit | 500 para que el proveedor reintente el webhook | El proveedor |
| Issue de Sentry 404 | API | Job `done`, sin issue de GitHub | No |
| 401 o 403 de Sentry, GitHub o PostHog | HTTP | Job `dead`, alerta | No |
| 429 o 5xx de un proveedor | HTTP | Espera de ADR-0016 | Hasta 5 |
| JSON del modelo inválido | Validador | Una segunda llamada | Solo esa |
| Parche que no aplica | `git apply --check` | Sin PR, comentario `fix_does_not_apply` | No, hasta `refresh` |
| Presupuesto diario agotado | Suma de `cost_ledger` | `deferred_budget` hasta la medianoche UTC | Solo entonces |
| Bloque del issue editado a mano | `before` no único | Comentario, `progress_stale`, sin reescritura | No |
| Prompt con instrucciones dentro del stack | Cerco `<untrusted>` | Se ignoran como órdenes; las citas siguen teniendo que ser literales | No |
| PostHog responde 403 o un cuerpo de error | HTTP | Job `dead`, sin issue que pegue ese cuerpo | 403 no; 5xx sí |
| Diff de más de 100 archivos | Conteo | Sin llamada de docs, un comentario | No |
| `docs/map.yml` inválido | Parseo | Se ignora el mapa, sigue la heurística | No |
| Comando de pruebas distinto de cero | Exit code | Sin PR, `tests_failed` | No, hasta `refresh` |
| Worker muerto a mitad de job | `locked_at` de más de 5 minutos | El job vuelve a `queued` si le quedan intentos | Sí |

El texto de `last_error` pasa por el depurador antes de guardarse. No se guarda el cuerpo del proveedor en el error.

## Requisitos no funcionales

- Seguridad y privacidad: firmar los dos webhooks; mínimo privilegio de la GitHub App (ADR-0004); depurar secretos y PII antes de logs, GitHub, prompts y columnas retenidas; no tratar el contenido externo como instrucciones (ADR-0005); Postgres solo en localhost; issues de PostHog solo con agregados (ADR-0013). El depurador concreto está en la arquitectura.
- Rendimiento y disponibilidad: el webhook no llama al modelo y responde en menos de 2 segundos cuando Postgres está bien. Un solo nodo, sin objetivo de alta disponibilidad. Un job a la vez.
- Accesibilidad: no aplica. El servicio no tiene interfaz de usuario. Los issues son Markdown de GitHub.
- Coste: tope diario 5.00 USD, precios por defecto 0.40 y 1.60 USD por millón de tokens de entrada y de salida, prompt de usuario a 80 000 caracteres, salida a 4 096 tokens, una llamada de clasificación, como máximo dos de fix y una de docs por job (ADR-0016). La vía PostHog no gasta modelo.

Tasa de salida: GitHub 4 solicitudes por segundo, Sentry 2, PostHog 1. Ante 429 se usa `Retry-After` si es un entero en segundos; si no, la espera del reintento.

## Observabilidad

- Señales necesarias (logs, métricas, trazas o eventos):
  - Log JSON con `ts`, `level`, `msg` en `snake_case` inglés, `jobId`, `kind`, `sentryIssueId`, `githubIssue`, `pr`, `durationMs`. Sin cuerpos, sin cabeceras de autorización y sin texto del evento dentro de `msg`.
  - Métricas en `GET /metrics`, solo en `127.0.0.1:9090`: `logs_watcher_webhooks_total{source,result}`, `logs_watcher_jobs_total{kind,result}`, `logs_watcher_llm_tokens_total{direction}`, `logs_watcher_budget_deferred_total`, `logs_watcher_proposals_total{kind,state}`, `logs_watcher_docs_prefilter_total{result}`.
  - El worker escribe `worker_heartbeat` cada 30 segundos.
  - Alertas locales, y POST a `ALERT_WEBHOOK_URL` si existe, con `{ "code", "detail" }` depurado y tope de 5 segundos: heartbeat de más de 2 minutos, job que pasa a `dead`, más de 10 firmas inválidas en 10 minutos, cualquier `deferred_budget`.
- Alertas o runbook: el runbook de operador (reintentar un job `dead`, subir el tope, rotar un secreto sin apagar la verificación) está en la arquitectura, sección Operación. Cada job `dead` deja `last_error` depurado y un código estable.

## Decisiones abiertas

OQ-1 está cerrada. El blanco es una colección de targets (ADR-0017 y la sección Targets de Alcance). `owner` y `name` no son una pregunta de producto: son configuración de despliegue del target, sin valor por defecto.

Siguen abiertas tres preguntas, las tres sobre el primer target. El implementador no inventa un valor para ellas. Mientras falten, el servicio arranca y la vía afectada de ese target no llama a ese proveedor.

<a id="oq-2"></a>

### OQ-2. Proyecto de Sentry y entornos de producción

Para el primer target, ¿cuál es la organización, el slug del proyecto, la `baseUrl` si no es `https://sentry.io`, y la lista exacta de `environment` que cuentan como producción?

La respuesta rellena `sentry` de esa entrada. No elige el repositorio. Con `productionEnvironments` vacío la vía Sentry de ese target descarta todos los eventos a propósito, para no tratar staging como producción. El servicio no elige esos nombres.

<a id="oq-3"></a>

### OQ-3. PostHog, validaciones y embudos

Para el primer target, ¿cuál es el host (`https://us.posthog.com`, `https://eu.posthog.com` u otro), el id de proyecto, los nombres de evento de `validationEvents`, y los embudos?

La respuesta rellena `posthog` de esa entrada. Hace falta, como mínimo, el embudo de pago y el de cada formulario cuyo abandono interese. Cada embudo lleva un `id` estable y los `event` de sus pasos, en orden. Ejemplo de forma, no de nombres reales:

```json
{
  "id": "payment",
  "steps": [
    { "event": "..." },
    { "event": "..." },
    { "event": "..." }
  ]
}
```

Si en ese target faltan `host` o `projectId`, no hay barrido suyo. Si solo faltan `validationEvents` o `funnels`, se omiten esas consultas y no se inventan eventos de pago ni de formularios. Errores `$exception` y clics `$rageclick` y `$dead_click` sí pueden correr en ese target en cuanto host y proyecto existan y el target esté activo.

<a id="oq-4"></a>

### OQ-4. Proveedor LLM y salida de código depurado

Para el primer target, ¿a qué endpoint compatible con `/chat/completions` se puede llamar, con qué modelo, y se acepta enviar fuera del VPS stacks, diffs y fragmentos de `docs/` de ese target ya pasados por el depurador?

La respuesta da valor a las variables que nombra el bloque `llm` de esa entrada. Sin esas variables no hay llamadas para ese target. La clasificación determinista y los issues de plantilla siguen. No hay PR de fix ni parche de docs de ese target, porque ambos necesitan el modelo. El servicio no elige proveedor ni asume una residencia de datos. Otro target puede nombrar otras variables sin cambiar el esquema.
