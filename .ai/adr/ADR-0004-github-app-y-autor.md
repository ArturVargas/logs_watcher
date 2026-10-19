# ADR-0004: El servicio actúa como GitHub App

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Hacen falta webhooks firmados y permisos acotados sobre el repositorio vigilado. La cuenta `el-chalan-dev` va a escribir la implementación del servicio desde un VPS. Esa cuenta no es la identidad con la que el servicio abre issues y PRs en la aplicación.

## Decisión

En tiempo de ejecución el servicio usa una GitHub App instalada en el repositorio vigilado. Permisos de repositorio: Contents (lectura y escritura), Pull requests (lectura y escritura), Issues (lectura y escritura), Metadata (lectura). Sin permiso de Workflows, Administration ni Secrets. Eventos suscritos: `pull_request`, `issue_comment`.

Los commits y los PRs del servicio los firma la instalación de la App. `el-chalan-dev` es el colaborador que, en una fase posterior, abre los PRs de implementación de este repositorio. No es el autor de los arreglos automáticos.

La autenticación es un installation token de corta duración. No se usa un PAT de usuario.

## Alternativas consideradas

- PAT de `el-chalan-dev`. Mezcla al autor humano con el bot y no tiene firma de webhook por instalación.
- GitHub Action dentro del repositorio vigilado. No cubre el webhook de Sentry ni el barrido de PostHog, y el servicio dejaría de ser un proceso desplegable.

## Consecuencias

- Artur crea la App y la instala en el repositorio de OQ-1, con el secreto de webhook y la clave privada solo en el VPS.
- El servicio reconoce sus propios PRs de arreglo por la rama `logs-watcher/fix-*` y por la fila de `proposals`, no por el login de la App.
- La App no recibe permiso para editar workflows de CI.

## Reabrir si

La aplicación vigilada no puede instalar una GitHub App, o la implementación y el runtime deban compartir la misma cuenta.
