# ADR-0006: Un servicio Node.js y Postgres en un VPS

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: El flujo tiene que quedar desplegado: webhooks, cola, reintentos y más de un tipo de job. Un script de un solo uso no alcanza. La implementación se hará desde un VPS.

## Decisión

Fase 1 es un solo proceso Node.js 22 en un VPS Linux, supervisado por systemd (`logs-watcher.service`), con Postgres 16 en el mismo host, escuchando solo en `127.0.0.1`. El proceso expone el HTTP de webhooks y, en el mismo proceso, toma jobs de la tabla `jobs` con `FOR UPDATE SKIP LOCKED`, de uno en uno.

No hay Redis, ni un segundo servicio, ni alta disponibilidad. El esquema de la cola permite un segundo worker más adelante sin cambiar la decisión de producto.

Los secretos viven en archivos de modo `600` bajo `/etc/logs-watcher/`, no en el repositorio.

## Alternativas consideradas

- SQLite en un script. Choca con webhooks concurrentes y con `SKIP LOCKED`.
- Cola en Redis más un worker aparte. Suma un componente que la fase 1 no necesita.
- Funciones sueltas en el proveedor de cada webhook. Parten el estado y complican el tope de coste.

## Consecuencias

- Un reinicio a mitad de un job lo devuelve a la cola cuando vence `locked_at` (5 minutos).
- El webhook responde en cuanto la fila de `inbox` queda confirmada. No llama al modelo en el request.
- Backup: `pg_dump` local diario, 7 copias, sin sacarlo del VPS.

## Reabrir si

Hace falta más de un nodo, o el volumen de webhooks no cabe en un worker secuencial.
