# ADR-0025: Los parches los escribe Qwen Cloud

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: OQ-4 preguntaba qué modelo puede escribir parches y si el código depurado puede salir del VPS. Artur cerró la pregunta: es un modelo de Qwen Cloud, con cuenta y clave del operador. JEv sigue siendo solo el clasificador de importancia y urgencia (ADR-0021).

## Decisión

Los parches de arreglo y de documentación los escribe un modelo de Qwen Cloud por su API compatible con OpenAI. Sirven varios modelos de Qwen. El id va en la configuración (`LLM_MODEL` o el nombre que ponga `llm.modelEnv`). No hay un modelo único grabado en el servicio. Si ese id está vacío, no hay llamada de parche ni de docs.

La base por defecto es `https://maas.qwencloudapi.com/compatible-mode/v1`, la que documentan la primera llamada y el chat compatible con OpenAI de Qwen Cloud. La llamada es `POST {base}/chat/completions` con `Authorization: Bearer` y la clave del operador. El contrato de una llamada, temperatura 0 y JSON sigue en ADR-0007. Si el operador usa una clave de Token Plan, pone la base que la propia página de claves de Qwen Cloud documenta para esa clave (`https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`). El servicio no inventa otra ruta.

El operador de logs_watcher abre su propia cuenta de Qwen Cloud y pone la clave en la variable que nombra `llm.apiKeyEnv`. El servicio no lleva una clave compartida.

Artur acepta que el código y los logs ya depurados salgan del VPS hacia esa API. El depurador sigue quitando tokens, correos y datos de usuario antes de la llamada. Un payload sin depurar no sale.

## Alternativas consideradas

- Dejar OQ-4 abierta. Artur ya eligió el proveedor.
- Usar JEv para escribir el parche. JEv no genera texto. ADR-0021 lo deja en importancia y urgencia.
- Grabar un solo id de modelo, por ejemplo el de un ejemplo de la documentación. Artur quiere poder cambiar de modelo de Qwen por configuración.

## Consecuencias

- Sin clave o sin id de modelo no hay pull request de arreglo ni parche de docs. La plantilla determinista y la severidad que no necesita este modelo siguen.
- JEv y esta clave son credenciales distintas. El tope de 5.00 USD de ADR-0016 sigue siendo el de estas llamadas de parche.
- Las condiciones de retención y de uso de datos de la API de Qwen Cloud no quedan cerradas aquí. Hay que revisarlas. Las páginas públicas consultadas no dicen una sola regla: [Safety](https://docs.qwencloud.com/developer-guides/run-and-scale/safety), [Data security](https://docs.qwencloud.com/developer-guides/security-compliance/data-security), [Account FAQ](https://docs.qwencloud.com/resources/faq-account) y [Token Plan FAQ](https://docs.qwencloud.com/token-plan/team/token-plan-team-faq). Esas condiciones quedan sin verificar como conclusión. Este ADR no inventa un plazo ni un permiso de entrenamiento.

## Reabrir si

Los parches tienen que salir de otro proveedor, o Artur retira el permiso de enviar código depurado a Qwen Cloud.
