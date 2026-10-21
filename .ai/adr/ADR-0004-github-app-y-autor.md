# ADR-0004: El servicio actúa como GitHub App

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Hacen falta webhooks firmados y permisos acotados sobre cada repositorio vigilado. La cuenta `el-chalan-dev` va a escribir la implementación del servicio desde un VPS. Esa cuenta no es la identidad con la que el servicio abre issues y PRs en la aplicación. Qué repositorios son esos lo decide ADR-0017, no este ADR.

## Decisión

En tiempo de ejecución el servicio usa una GitHub App. Se instala en cada target activo definido en ADR-0017. Permisos de repositorio en el bucle de fix: Contents (lectura y escritura), Pull requests (lectura y escritura), Issues (lectura y escritura), Metadata (lectura). Sin Administration ni Secrets. Sin permiso de Workflows en ese bucle. La única ampliación de Workflows es la fase de CI, y solo para el job `cicd_improve` (ADR-0024). Eventos suscritos: `pull_request`, `issue_comment`, `check_suite`, `check_run`.

El token es de instalación y de corta duración. Si el target trae `github.installationId`, se usa ese. Si viene vacío, se usa `GITHUB_INSTALLATION_ID`. No se usa un PAT de usuario.

Los commits y los PRs del servicio los firma la instalación de la App. `el-chalan-dev` es el colaborador que, en una fase posterior, abre los PRs de implementación de este repositorio. No es el autor de los arreglos automáticos.

## Alternativas consideradas

- PAT de `el-chalan-dev`. Mezcla al autor humano con el bot y no tiene firma de webhook por instalación.
- GitHub Action dentro del repositorio vigilado. No cubre el webhook de Sentry ni el barrido de PostHog, y el servicio dejaría de ser un proceso desplegable.

## Consecuencias

- Artur crea la App. La instala en un repositorio cuando ese target ya tiene `owner` y `name`. Hasta entonces la App no tiene dónde instalarse y el servicio no abre issues. El secreto de webhook y la clave privada viven solo en el VPS.
- El servicio reconoce sus propios PRs de arreglo por la rama `logs-watcher/fix-*` y por la fila de `proposals`, no por el login de la App.
- En el bucle de fix la App no edita workflows. El agente de fix tampoco puede hacerlo cuando la fase de CI enciende el permiso (ADR-0024).

## Reabrir si

La aplicación vigilada no puede instalar una GitHub App, o la implementación y el runtime deban compartir la misma cuenta.
