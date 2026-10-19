# ADR-0014: Los issues se escriben en español

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Quien revisa los tickets en esta fase lee las especificaciones en español. El modelo y las plantillas no deben mezclar idiomas en el texto que ve una persona.

## Decisión

Títulos, cuerpos, comentarios del servicio y el campo `summary` de un PR de fix van en español. Los identificadores técnicos se quedan en inglés: clases de severidad, etiquetas, rutas, nombres de eventos, comandos y claves JSON.

Los códigos de log (`msg`) van en inglés, en `snake_case`, para poder buscarlos. No incluyen texto del evento.

## Alternativas consideradas

- Issues en inglés porque el stack lo está. Obliga a Artur a leer otro idioma en el ticket que tiene que aprobar.
- Dejar el idioma al modelo en cada llamada. Los tickets de un mismo tipo salen distintos.

## Consecuencias

- Las plantillas de la especificación son el texto canónico, no un ejemplo.
- Un mensaje de excepción citado como evidencia se copia literal, en el idioma en que vino, dentro del bloque de evidencia.

## Reabrir si

El equipo que triajea los issues no trabaja en español.
