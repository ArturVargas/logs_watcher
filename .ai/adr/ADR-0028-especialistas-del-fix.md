# ADR-0028: El job de fix orquesta como máximo ocho especialistas

- Estado: aceptada
- Fecha: 2026-10-31
- Contexto: Artur quiere especialistas sobre el diff del arreglo, con el mismo paquete de contexto que la deriva de docs: `docs/map.yml`, el nombre y el directorio del archivo cambiado, los símbolos, tope 15. Hace falta un tope, y que no sean servicios aparte. El orquestador no es uno de esos especialistas. ADR-0006, ADR-0007, ADR-0010, ADR-0012, ADR-0016, ADR-0021 y ADR-0025 siguen cerrados.

## Decisión

El orquestador es el job de fix que ya existe. No es un especialista. Los roles viven en el mismo proceso Node.js. No hay otro proceso, ni Redis, ni NATS.

Hay ocho especialistas, y no hay un noveno. Más especializado es mejor: si el diff encaja en uno concreto, corre ese, y no se inventa un rol más amplio que lo cubra. Solo corre el que el diff hace relevante. Cada uno corre como máximo una vez. El que no aplica no se llama. La relevancia la decide código del orquestador, antes de llamar. El modelo no elige quién corre. El orden de llamada es el de esta lista, saltando los que no aplican.

1. `solidity`. Corre si el diff tiene Solidity. Habla de contratos, reentrancy y control de acceso.
2. `rust`. Corre si el diff tiene Rust. Habla de unwrap, lifetimes y Send/Sync.
3. `typescript-backend`. Corre si el diff tiene TypeScript de servidor o de API. No corre por un archivo de interfaz o de formularios.
4. `typescript-frontend`. Corre si el diff tiene TypeScript de interfaz o de formularios. No corre por un archivo de servidor o de API.
5. `business`. Corre en el job de fix cuando ya hay un diff de código validado y la clase ya está calculada. Habla del impacto de usuario y de negocio a partir del paquete de docs y de esa severidad. No ve grabaciones de sesión de PostHog, ni correos, ni ids de usuario. No reclasifica.
6. `docs`. Dice si `docs/` quedó desactualizado. Su única llamada es la llamada de deriva de docs, no una segunda.
7. `tests`. Corre cuando hay un parche de código validado. Dice si ese parche necesita un test. No emite el test y no pide otra llamada de parche.
8. `security`. Corre solo cuando el diff toca autenticación, transferencia de valor, o Rust `unsafe`.

Si el diff tiene TypeScript de los dos tipos, corren `typescript-backend` y `typescript-frontend`, cada uno una vez. Un archivo que no es ninguno de los dos no llama a ninguno. `security` no sustituye a `rust` ni a `solidity`. Si el diff es relevante para los dos, corren los dos, cada uno una vez.

Sin un diff de código validado no corre ningún especialista. En un pull request que no es el job de fix, la deriva sigue siendo una sola llamada y los otros siete no corren.

El paquete de contexto es el diff ya depurado más como máximo 15 docs candidatos, los de la deriva. Cero candidatos es válido. Sin embeddings. Todo ese texto es dato no confiable. `business` recibe además la clase ya calculada, y no recibe otra cosa.

Cada especialista que no es `docs` devuelve `evidence` y `summary`. El orquestador solo conserva eso. Una salida vacía, o sin una cita literal de al menos 8 caracteres de la fuente depurada que declara, se ignora y no se vuelve a pedir. Una clase, una urgencia o un parche en ese JSON se tira. La llamada de `docs` conserva el esquema de parches de la deriva.

Cada llamada cuenta para el tope diario de ADR-0016. No hay un bucle extra. El orquestador fusiona el JSON aceptado en código, lo guarda en el `payload` de la propuesta y no añade una llamada de modelo para fusionarlo. Ese JSON no es un parche y no dispara otra llamada de Qwen.

Solo el orquestador emite un parche de código, una edición de docs o una escritura en GitHub. El parche de código lo escribe Qwen Cloud, con el contrato de ADR-0007: como máximo dos llamadas de ese parche. La edición de docs sale de la única llamada de `docs`. Ninguna escritura en GitHub ocurre si `LOGS_WATCHER_DRY_RUN` no es exactamente `false`.

JEv sigue clasificando la urgencia. La severidad la sigue calculando el código.

## Alternativas consideradas

- Dos especialistas, uno de código y otro de negocio. Artur lo sustituyó por ocho roles más concretos.
- Llamar a los ocho en cada diff. Gasta el tope en roles que el diff no toca.
- Un rol genérico para el archivo que no encaja en los ocho. Es menos especializado.
- Un servicio, una cola Redis o NATS, u otro proceso por especialista. ADR-0006 sigue cerrado.
- Una llamada del orquestador para fusionar el JSON. Artur no quiere esa llamada.
- Una segunda llamada de docs además de la deriva. La de `docs` es esa deriva.
- Embeddings para elegir los 15 docs. ADR-0012 sigue cerrado.
- Dejar que un especialista elija la severidad, vea grabaciones o escriba en GitHub.
- Volver a pedir el parche a Qwen con el JSON de los especialistas. Eso es el bucle que esta decisión no abre.

## Consecuencias

- Un diff solo de Solidity no llama a `rust` ni a los dos de TypeScript.
- Un diff que no toca autenticación, transferencia de valor ni Rust `unsafe` no llama a `security`.
- El validador del parche no cambia. Un especialista no lo salta y no añade un archivo.
- La llamada de docs sigue siendo una por corrida de deriva.
- Un especialista no abre un pull request ni comenta en GitHub por su cuenta.
- El modo en seco puede gastar el tope en estas llamadas y aun así no escribe en GitHub.

## Reabrir si

Artur añade o quita un especialista, o el orquestador tiene que llamar a un modelo para fusionar el JSON.
