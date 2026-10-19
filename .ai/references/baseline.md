# Línea base del proyecto

Completar al adoptar el kit en un proyecto existente.

## Estado actual

Repositorio recién creado a partir del AI Engineering Kit. No hay código de logs_watcher, ni esquema desplegado, ni integraciones conectadas. La primera iniciativa es la fase 1 de especificación: `.ai/runs/2026-10-19-logs-watcher/`.

## Arquitectura y despliegue

No hay despliegue. El diseño que deberá implementarse después de la revisión está en `.ai/runs/2026-10-19-logs-watcher/04-architecture.md`: un proceso Node.js 22, Postgres 16 en el mismo VPS, webhooks de Sentry y de una GitHub App, y un barrido programado de PostHog.

## Dependencias e integraciones

Ninguna está conectada. El servicio, cuando exista, hablará con la API y los webhooks de Sentry, la API de consultas de PostHog, una GitHub App, y un endpoint de chat compatible con OpenAI. Owner del repositorio vigilado, proyecto de Sentry, proyecto de PostHog y proveedor LLM siguen en las decisiones abiertas de `03-specification.md`.

## Riesgos y deuda conocida

No hay deuda de código. El corpus de `docs/` de la aplicación vigilada todavía no se conoce. Los secretos no están en este repositorio y no deben añadirse.

## Próxima iniciativa

Cuando Artur apruebe la especificación, la etapa siguiente es el plan de implementación, y después el código escrito por `el-chalan-dev`. Esa etapa no forma parte de este cambio.
