# ADR-0027: La revisión determinista usa la herramienta del archivo

- Estado: aceptada
- Fecha: 2026-10-22
- Contexto: Artur fijó el código que logs_watcher vigila: Solidity, Rust y TypeScript, en el frontend, el backend y la blockchain. La capa de revisión determinista tiene que usar la herramienta de ese archivo. Un stack único no cubre los tres. El servicio sigue en Node.js y Postgres (ADR-0006). Qwen Cloud escribe los parches (ADR-0025). JEv clasifica importancia y urgencia (ADR-0021). Ponytail genera y revisa el código de este repositorio (ADR-0026).

## Decisión

La capa de revisión determinista elige la herramienta según el lenguaje del archivo. No hay un stack por defecto para todo el diff.

Esas herramientas corren solo cuando ese lenguaje está en el diff:

- Solidity (`.sol`): Slither, Aderyn y solhint. El AST sale de solc o de solidity-parser.
- Rust (`.rs`): clippy, cargo-audit y cargo-deny. El AST sale de syn. El grafo de símbolos sale de rust-analyzer cuando está disponible.
- TypeScript: el eslint y el `tsc` del repositorio vigilado. El AST sale del compilador de TypeScript o de tree-sitter.

Un archivo de otro lenguaje no recibe un linter inventado. Si rust-analyzer no está, el corte sigue con syn y no inventa otro grafo. Si el repositorio vigilado no tiene eslint o `tsc` para ese archivo, no se inventa una configuración.

El primer corte de esta capa se queda así: un webhook `pull_request`, el diff asociado a un símbolo, un hallazgo determinista y un comentario en línea que cita ese hallazgo. Publicar el comentario no fusiona.

El webhook entra con las acciones `opened`, `synchronize` y `reopened`, la misma firma y el mismo target activo que el resto del servicio. Encola el trabajo. No corre la herramienta dentro del request. El worker toma el primer archivo cambiado, en orden de path, que sea de uno de esos tres lenguajes, lo asocia a un símbolo con el AST de ese lenguaje y publica un solo comentario. El orden de herramientas de ese corte es fijo: en Solidity, Slither, luego Aderyn, luego solhint; en Rust, clippy, luego cargo-audit, luego cargo-deny; en TypeScript, el eslint del repositorio, luego `tsc`. Se cita el primer hallazgo.

El comentario nombra la herramienta, el identificador del hallazgo y el símbolo. Va en la línea del diff de ese símbolo. Pasa por el depurador. No es un parche de Qwen Cloud y no es una clase de JEv. Con el modo en seco no se publica. La misma entrega de GitHub no publica un segundo comentario.

Qwen Cloud sigue escribiendo los parches. JEv sigue clasificando importancia y urgencia. Ponytail sigue generando y revisando el código de logs_watcher. Esta capa no los sustituye.

El proceso sigue siendo Node.js 22 y Postgres 16. Esta decisión no lo pasa a Rust, no añade Redis ni NATS, y no añade embeddings.

## Alternativas consideradas

- Un stack único para Solidity, Rust y TypeScript. El archivo que no encaja se queda sin herramienta.
- Inventar un linter para cada lenguaje que aparezca. Artur no eligió esas herramientas.
- Pedir el comentario a Qwen Cloud. Qwen sigue escribiendo parches. Este corte cita un hallazgo de herramienta.
- Pedir la revisión a JEv. JEv clasifica importancia y urgencia.
- Pasar el repositorio vigilado por ponytail. Ponytail revisa el código de este repositorio.
- Reescribir el servicio en Rust, o añadir Redis o NATS, para correr clippy. La cola ya está en Postgres.
- Asociar el diff a un símbolo con embeddings. El símbolo sale del AST. ADR-0012 sigue cerrado.

## Consecuencias

- Un diff sin `.sol` no corre Slither, Aderyn ni solhint. Un diff sin `.rs` no corre clippy, cargo-audit ni cargo-deny. Un diff sin TypeScript no corre el eslint ni el `tsc` de ese repositorio.
- Una herramienta ausente no se sustituye por la de otro lenguaje. No se publica un hallazgo fabricado. El log queda en `review_tool_missing`.
- El comentario no llama a la API de merge ni aprueba el pull request. ADR-0022 no cambia.
- El permiso de Pull requests de ADR-0004 alcanza para el comentario en línea. No se pide Workflows por esta capa.
- El primer corte publica como mucho un comentario por entrega.
- Un pull request desde un fork no recibe push. El comentario, si se publica, no fusiona y no empuja.

## Reabrir si

Artur añade un lenguaje vigilado, retira uno de los tres, o el comentario de esta capa tiene que fusionar.
