# ADR-0010: La severidad la calcula el servicio

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Hace falta una clase de severidad que una persona o un agente pueda asignar sin interpretar el ánimo del error. El nivel que manda Sentry (`error`, `fatal`) no dice si el usuario puede seguir.

## Decisión

La clase la calcula código del servicio a partir de cuatro booleanos: `userFlowInvolved`, `userCanUseApp`, `processTerminated`, `userFlowCompletes`. El orden y las reglas que rellenan esos booleanos desde el evento están en la especificación y son normativos.

Clases, mutuamente excluyentes: `blocker`, `truncated`, `flow-blocked`, `non-blocking`, `no-user-impact`. Si falta un booleano obligatorio después del extractor y, como mucho, de una llamada LLM con cita válida, la clase es `unclassified`.

La prioridad `P0`–`P3` es una función aparte, también en la especificación, usando `userCount` y la suma de `stats.24h` cuando venga. La prioridad no cambia la clase.

Los errores HTTP 4xx con el proceso no terminado se descartan antes de clasificar. No son un fallo real de la fase 1.

Las transacciones que significan “la aplicación no arranca o no deja entrar” salen de la configuración `blockerTransactions`. El valor inicial es `["/", "/login", "/signup", "/auth/callback"]`.

## Alternativas consideradas

- Copiar el `level` de Sentry a la etiqueta de severidad. No distingue un fallo total de un error capturado.
- Pedir al modelo que elija la clase. Dos corridas pueden discrepar con la misma evidencia.
- Dejar la lista de transacciones bloqueantes vacía hasta que Artur la dicte. Mientras tanto ningún fallo puede ser `blocker` y el implementador tendría que inventar la lista.

## Consecuencias

- Un fallo no capturado en `/login` es `blocker`. El mismo fallo en otra ruta es `truncated`.
- Un 500 capturado en una ruta que no está en la lista es `flow-blocked`.
- Cambiar la lista es un cambio de configuración, no de código.
- `unclassified` abre issue y no abre PR.

## Reabrir si

Las rutas de entrada reales de la aplicación no son las cuatro del valor inicial, o un 4xx capturado debe tratarse como fallo.
