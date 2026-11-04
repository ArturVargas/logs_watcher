# Checklist de puesta en marcha: qué tiene que traer Artur

Todo esto va **solo en el VPS** (`r2d2-dev`, `~/services/logs-watcher/`), nunca en git. El servicio ya corre en Docker en modo en seco (`LOGS_WATCHER_DRY_RUN=true`) con `targets: []`.

Dónde va cada cosa en el despliegue:

| Qué | Archivo en el VPS | Dentro del contenedor |
| --- | --- | --- |
| Variables secretas | `~/services/logs-watcher/.env` (modo `600`) | variables de entorno |
| Config de targets | `~/services/logs-watcher/config/config.json` | `/etc/logs-watcher/config.json` (solo lectura) |
| Clave privada de la GitHub App | `~/services/logs-watcher/config/github-app.pem` (modo `600`) | `/etc/logs-watcher/github-app.pem` |

Tras editar: `cd ~/services/logs-watcher && docker compose up -d` (recrea la app). Nunca pegues una clave en un chat, issue o commit.

## 1. Claves y cuentas

| # | Qué | Variable(s) | Cómo se consigue | Estado en el código |
| --- | --- | --- | --- | --- |
| 1 | **Qwen Cloud** (parches, docs y especialistas) | `LLM_API_KEY`, `LLM_MODEL`, opcional `LLM_BASE_URL` (por defecto `https://maas.qwencloudapi.com/compatible-mode/v1`) | Cuenta propia en Qwen Cloud (ADR-0025) → crear API key → elegir el id del modelo (ej. un modelo de código). Revisar antes las condiciones de retención de datos citadas en ADR-0025. | Implementado |
| 2 | **GitHub App** (issues, PRs, comentarios) | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH=/etc/logs-watcher/github-app.pem`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_INSTALLATION_ID` (o `installationId` por target) | GitHub → Settings → Developer settings → GitHub Apps → New. Permisos de repositorio: **Contents RW, Pull requests RW, Issues RW, Metadata R**. Sin Workflows, Administration ni Secrets (ADR-0004). Eventos: `pull_request`, `issue_comment`, `check_suite`, `check_run`. Webhook URL: la URL pública que decidamos (ver "Exponer webhooks"). Generar un webhook secret aleatorio (`openssl rand -hex 32`). Generar la private key (.pem). Instalar la App **solo** en `ArturVargas/metro_app` y `ArturVargas/cop_by`; el installation id sale en la URL de la instalación. | Implementado |
| 3 | **Sentry** (fuente de errores) | `SENTRY_AUTH_TOKEN`; un secreto de webhook por target: `SENTRY_WEBHOOK_SECRET_METRO`, `SENTRY_WEBHOOK_SECRET_COPBY` | Sentry → Settings → Developer Settings → Internal Integration por proyecto (o una por org): scopes `project:read`, `event:read`, `org:read`; activar webhooks del recurso `issue`; la "Client Secret" es el secreto de webhook. Webhook URL: `https://<host>/webhooks/sentry/<targetId>`. Anotar **org slug**, **project slug** y los **environments de producción** (ej. `production`). | Implementado |
| 4 | **JEv / TypeSafe** (importancia y urgencia) | `TYPESAFE_API_KEY` | Cuenta en TypeSafe → API key para `https://api.typesafe.ai/v1/systemone`, modelo `jev-latest` (ADR-0021). | **Pendiente de código**: hoy importancia/urgencia quedan vacías. La clave se puede dejar lista. |
| 5 | **PostHog** (validaciones y embudos) | `POSTHOG_API_KEY` | PostHog → Personal API key con lectura de query/insights. Anotar `projectId` y host (`https://us.posthog.com` o EU). Nombres reales de eventos de validación/embudos. | **Pendiente de código** (ADR-0019) |
| 6 | **Railway** log drain | `RAILWAY_LOG_WEBHOOK_SECRET` | Railway → proyecto → Settings → Log drains / webhook. Secreto aleatorio. URL: `https://<host>/webhooks/logs/<targetId>/railway`. | **Pendiente de código** (ADR-0020) |
| 7 | **Vercel** log drain | `VERCEL_LOG_WEBHOOK_SECRET` | Vercel → Team Settings → Log Drains (requiere plan Pro). Vercel firma con el secreto del drain. URL: `.../webhooks/logs/<targetId>/vercel`. | **Pendiente de código** |
| 8 | **Cloudflare** Logpush / Workers | `CLOUDFLARE_LOG_WEBHOOK_SECRET` | Cloudflare → Analytics & Logs → Logpush a destino HTTP con header de autorización. URL: `.../webhooks/logs/<targetId>/cloudflare`. | **Pendiente de código** |
| 9 | Alertas (opcional) | `ALERT_WEBHOOK_URL` | Un webhook de Slack/Discord/Telegram para alertas. | Opcional |

`DATABASE_URL` y la contraseña de Postgres ya los generó el despliegue; no hay que traerlos.

## 2. Targets

1. **`ArturVargas/metro_app`** (primero). Monorepo pnpm: `apps/game`, `apps/community`, `packages/`. Script de lint/typecheck en `@metro/game`.
2. **`ArturVargas/cop_by`** ("Buy COP on minipay", TypeScript, pnpm + turbo, `apps/`). Encontrado con `gh repo list ArturVargas`. **Confirmar** que "copby" es este repo.

Borrador para `~/services/logs-watcher/config/config.json` (los `""` los rellena Artur):

```jsonc
{
  "targets": [
    {
      "id": "metro",
      "github": { "owner": "ArturVargas", "name": "metro_app", "installationId": "" },
      "sentry": {
        "org": "",            // slug de la org en Sentry
        "project": "",        // slug del proyecto de metro
        "webhookSecretEnv": "SENTRY_WEBHOOK_SECRET_METRO",
        "authTokenEnv": "SENTRY_AUTH_TOKEN",
        "productionEnvironments": ["production"]
      },
      "posthog": { "projectId": "", "apiKeyEnv": "POSTHOG_API_KEY" },
      "issueLanguage": "both",
      "phases": { "cicd": false },
      "testCommand": null,    // ej. ["pnpm", "typecheck"] cuando el clon tenga deps
      "specialists": {
        "uiPaths": ["apps/game/**", "apps/community/**/components/**", "**/*.tsx"],
        "serverPaths": ["**/api/**", "**/server/**", "**/workers/**"]
      }
    },
    {
      "id": "copby",
      "github": { "owner": "ArturVargas", "name": "cop_by", "installationId": "" },
      "sentry": {
        "org": "",
        "project": "",
        "webhookSecretEnv": "SENTRY_WEBHOOK_SECRET_COPBY",
        "authTokenEnv": "SENTRY_AUTH_TOKEN",
        "productionEnvironments": ["production"]
      },
      "posthog": { "projectId": "", "apiKeyEnv": "POSTHOG_API_KEY" },
      "issueLanguage": "both",
      "phases": { "cicd": false },
      "testCommand": null,
      "specialists": {
        // pagos/wallet: security ya corre por las palabras por defecto (payment, wallet, transfer...)
        "securityPathWords": ["auth", "session", "jwt", "wallet", "payment", "transfer", "withdraw", "deposit", "balance", "ledger", "minipay", "onramp", "offramp", "quote", "secret", "token"]
      }
    }
  ],
  "limits": { "dailyBudgetUsd": 5 }
}
```

Un target sin `owner`/`name` queda inactivo; uno sin `sentry.org`/`project` o sin su secreto no procesa esa vía (`config_missing`). Se puede activar uno a uno.

## 3. Exponer webhooks (decisión pendiente)

Hoy la app solo escucha en `127.0.0.1:8787` del VPS; nada está publicado. Para que Sentry/GitHub lleguen hace falta una URL HTTPS pública. Opciones:

- **Cloudflare Tunnel** (`cloudflared`): sin abrir puertos en el firewall; requiere un dominio en Cloudflare y un token del túnel.
- **Caddy** como reverse proxy con TLS automático: requiere abrir 443 y un DNS apuntando al VPS.

## 4. Orden sugerido

1. Qwen key + modelo → `.env`. Seguir en seco y revisar propuestas.
2. Sentry de metro + decidir cómo exponer webhooks → target `metro` activo, en seco.
3. Revisar al menos 10 filas (`groups` + `proposals`).
4. GitHub App instalada en metro → recién entonces `LOGS_WATCHER_DRY_RUN=false` (cambio aparte).
5. Repetir con `copby`.
