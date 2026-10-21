# Línea base del proyecto

Completar al adoptar el kit en un proyecto existente.

## Estado actual

Repositorio recién creado a partir del AI Engineering Kit. No hay código de logs_watcher, ni esquema desplegado, ni integraciones conectadas. La primera iniciativa es la fase 1 de especificación: `.ai/runs/2026-10-19-logs-watcher/`.

## Arquitectura y despliegue

No hay despliegue. El diseño que deberá implementarse después de la revisión está en `.ai/runs/2026-10-19-logs-watcher/04-architecture.md`: un proceso Node.js 22, Postgres 16 en el mismo VPS, webhooks de Sentry y de una GitHub App, y un barrido programado de PostHog.

## Dependencias e integraciones

Ninguna está conectada. El servicio, cuando exista, hablará con Sentry, PostHog, los drenajes de logs de Railway, Vercel y Cloudflare, una GitHub App, el endpoint documentado de JEv (`POST https://api.typesafe.ai/v1/systemone`) para importancia y urgencia, y un endpoint de chat compatible con OpenAI para los parches. El `owner`, el `name`, la organización de Sentry, el slug, `productionEnvironments` y el `projectId` de PostHog del primer target son configuración de despliegue, sin valor por defecto (ADR-0017, ADR-0018, ADR-0019). `baseUrl` vale `https://sentry.io` si no se escribe otra. El host de PostHog es `https://us.posthog.com`. El `modelId` inicial del clasificador es `jev-latest`. El proveedor LLM de generación de ese primer target sigue en OQ-4.

## Riesgos y deuda conocida

No hay deuda de código. El corpus de `docs/` de la aplicación vigilada todavía no se conoce. Los secretos no están en este repositorio y no deben añadirse.

## Próxima iniciativa

Cuando Artur apruebe la especificación, la etapa siguiente es el plan de implementación, y después el código escrito por `el-chalan-dev`. Esa etapa no forma parte de este cambio.
