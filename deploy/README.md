# Despliegue con Docker

Layout en el VPS (`~/services/logs-watcher/`):

```
compose.yaml  status.sh  .env (600)  config/config.json (640)  config/github-app.pem (600)  app/ (checkout del código)
```

- `db`: postgres:16, sin puerto publicado, solo red `internal` (sin salida a internet), volumen `pgdata`.
- `migrate`: aplica `sql/schema.sql` (idempotente) en cada `up`.
- `app`: usuario `node` (no root), rootfs de solo lectura, `cap_drop: ALL`, `no-new-privileges`, 512 MB / 1 CPU. Webhooks en `127.0.0.1:8787` del host solamente.
- Logs `json-file` 10 MB × 3.

Operación:

```bash
cd ~/services/logs-watcher
./status.sh                 # salud, jobs muertos, gasto del día, últimos logs
docker compose up -d --build   # tras actualizar app/ o .env
docker compose exec app logs-watcher jobs retry <uuid>
```
