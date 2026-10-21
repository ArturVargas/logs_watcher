# ADR-0021: Importancia y urgencia las clasifica un modelo System One

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: Artur quiere importancia y urgencia aparte de la clase de severidad, clasificadas por modelos System One. El primer modelo que citó es JEv, de TypeSafe. Puede haber otros. Esta llamada no escribe parches. Los parches los escribe Qwen Cloud (ADR-0025).

## Decisión

El núcleo depende del puerto `ImportanceClassifier`, con una operación `classify`. La entrada es el texto ya depurado del fallo. La salida es `importance` y `urgency`, cada una `low`, `medium` o `high`, más el `modelId` que respondió y la confianza si el adaptador la trae. Si la llamada no está configurada o falla, las dos salen vacías. Urgencia vacía no cuenta como `low`.

El primer adaptador es `typesafe-system-one`. El id de modelo vive en la configuración. El valor inicial es `jev-latest`, el alias estable que TypeSafe documenta para JEv. La respuesta guarda el id versionado que devuelve el campo `model`, no solo el alias. Otros modelos System One se eligen cambiando `modelId` o el adaptador, sin cambiar la rúbrica de severidad.

Ese adaptador llama al endpoint documentado `POST https://api.typesafe.ai/v1/systemone`. No se inventa otro endpoint, ni otro cuerpo, ni un precio. El precio publicado por el proveedor no entra en el tope de 5.00 USD de ADR-0016. Si la respuesta trae `usage`, se anota en el libro aparte de ese tope. Las preguntas que envía el adaptador son dos `choice` documentados, con etiquetas `low`, `medium` y `high`: una para importancia y otra para urgencia. El texto del fallo va en `state` y es dato no confiable. Las instrucciones de las preguntas son del servicio, no del log.

OQ-4 está cerrada en ADR-0025 y no convierte a JEv en el escritor de parches. Este puerto no llama a `chat/completions`.

## Alternativas consideradas

- Pedir importancia y urgencia a Qwen Cloud. Mezcla generación de parches con una decisión calibrada y haría que JEv dejara de ser el clasificador.
- Inventar un cuerpo HTTP y un precio para JEv. TypeSafe ya documenta el endpoint y el campo `model`. El precio no hace falta para el contrato del puerto.
- Usar la clase de severidad como si fuera la urgencia. Artur las separó, y la fusión automática mira la urgencia (ADR-0022).

## Consecuencias

- Sin `TYPESAFE_API_KEY`, el puerto responde vacío y ningún pull request cumple “urgencia `low`”.
- La clase `blocker` no implica urgencia `high`, ni al revés.
- Cambiar de JEv a otro System One es configuración.

## Reabrir si

JEv deja de exponer `POST /v1/systemone`, o importancia y urgencia deben salir del mismo modelo que escribe el parche.
