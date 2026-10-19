# ADR-0016: Tope de coste y reintentos

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: El modelo se paga por token y los proveedores limitan la tasa. Sin un tope, un grupo ruidoso o un diff grande puede gastar de más o bloquear la cola.

## Decisión

El tope diario por defecto es 5.00 USD en UTC, estimado con `usage` de la respuesta o, si falta, con caracteres/4. Precios por defecto en configuración: 0.40 USD por millón de tokens de entrada y 1.60 USD por millón de salida. Si el acumulado del día ya alcanzó el tope, el job pasa a `deferred_budget` y se reprograma al siguiente medianoche UTC. Los webhooks se siguen aceptando y los issues deterministas se siguen abriendo.

Tasa de salida: GitHub 4 solicitudes por segundo, Sentry 2, PostHog 1. Ante 429 se respeta `Retry-After` si es un entero en segundos.

Reintentos de red y de HTTP 408, 429, 500, 502, 503 y 504: cinco intentos, esperas de 1, 2, 4, 8 y 16 segundos más un jitter de 0 a 250 ms. Después, el job queda `dead`. Un 401 o 403 del proveedor no se reintenta.

El cuerpo de un prompt de usuario se corta a 80 000 caracteres. La salida pedida al modelo se limita a 4 096 tokens.

## Alternativas consideradas

- Sin tope, solo alertas. El gasto ocurre antes de que alguien mire la alerta.
- Parar también la apertura determinista de issues cuando se acaba el presupuesto. Esconde fallos que no necesitan modelo.
- Cola infinita de reintentos. Un 500 permanente llena el worker.

## Consecuencias

- El día en que se agota el presupuesto no hay PRs nuevos de fix ni de docs hasta la medianoche UTC, salvo que alguien suba `dailyBudgetUsd` y reinicie.
- Los precios por defecto pueden no coincidir con la factura real. Sirven para frenar, no para contabilizar al céntimo.
- Un job `dead` no se reintenta solo. Hace falta el comando de operador descrito en la arquitectura.

## Reabrir si

La factura real se aleja del estimado de forma que el tope frena demasiado pronto o demasiado tarde, o hace falta un tope por PR distinto del tope diario.
