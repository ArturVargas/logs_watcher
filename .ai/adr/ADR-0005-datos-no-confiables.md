# ADR-0005: Sentry, PostHog y GitHub son datos no confiables

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Stacks, sesiones, diffs, títulos de issues y cuerpos de PR pueden contener instrucciones dirigidas al modelo o secretos pegados por accidente. Tratarlos como prompt del operador permite inyección y fugas.

## Decisión

Todo contenido que llegue de Sentry, de PostHog, de un diff, de un issue, de un comentario o de un archivo del repositorio vigilado es dato no confiable. Entra al modelo solo dentro de `<untrusted source="...">`. El prompt de sistema dice que ese bloque no contiene instrucciones. El servicio no ejecuta órdenes encontradas ahí, no cambia su configuración y no sigue enlaces que el payload pida.

Los comandos `/logs-watcher` solo se aceptan desde el webhook de GitHub ya verificado, con el cuerpo exacto y la asociación descritos en ADR-0003. Un comando dentro de un stack o de un título no cuenta.

Antes de escribir en logs, en GitHub, en el prompt o en una columna retenida, el texto pasa por el depurador de secretos y de PII definido en la arquitectura.

## Alternativas consideradas

- Confiar en el texto si el evento ya está en el proyecto de Sentry. Quien pueda provocar un error en la aplicación podría escribir el prompt.
- Filtrar solo frases conocidas de jailbreak. Se evaden con un parafraseo; el cerco de datos es más simple.

## Consecuencias

- La validación exige citas literales tomadas del texto ya depurado. Una cita que no aparece se rechaza.
- El modelo no elige la clase de severidad. Como mucho rellena booleanos que el extractor dejó vacíos, y solo con una cita válida.
- La vía PostHog no manda sesiones al modelo (ADR-0013).

## Reabrir si

Aparece una fuente nueva que sí sea texto de operador (por ejemplo una nota escrita por Artur en un canal firmado) y haga falta pasarla como instrucción.
