# ADR-0029: TypeScript estricto en lugar de JavaScript

- Estado: aceptada
- Fecha: 2026-11-06
- Contexto: Artur aprobó migrar el servicio a TypeScript con tipado estricto. ADR-0006 fijó Node.js 22 y Postgres 16; el plan de implementación y el código previo estaban en `.js`. Hay que tipar sin añadir Express, ORM ni un runtime distinto de Node.
- Relacionada: ADR-0006 (sigue: un proceso Node, Postgres local, sin Redis). Este ADR cambia solo el lenguaje de los fuentes.

## Decisión

El código de aplicación, el CLI y las pruebas se escriben en TypeScript. `tsc` compila a `dist/` (ESM, `module: NodeNext`). En runtime solo corre JavaScript emitido: `node dist/src/main.js` y `node dist/bin/logs-watcher.js`. No se usa `tsx` en producción.

`tsconfig.json` activa `strict` y además `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables` y `verbatimModuleSyntax`.

Los tipos de dominio propios (`Target`, `Limits`, `JobRow`, `Patch`, config, CLI, cola) van tipados sin `any`. Para cuerpos JSON de terceros (webhooks de Sentry/GitHub y respuestas del LLM) existe el alias documentado `Wire` en `src/types.ts`, único escape hatch de `any`, porque esas formas no las controlamos. Preferimos `unknown` + `asRecord`/`asString` en límites nuevos.

La imagen Docker es multi-stage: compila con `typescript` en el stage `build` y el stage final solo lleva `dist/`, `sql/` y dependencias de producción. ADR-0006 no se reabre.

## Alternativas consideradas

- Quedarse en JavaScript con JSDoc. No cumple el tipado estricto pedido.
- Correr `tsx` / `--experimental-strip-types` en producción. Añade un runtime de desarrollo al servicio; se descartó a favor de `dist/` reproducible.
- Reescribir en otro lenguaje. Fuera de alcance; ADR-0006 sigue cerrado.

## Consecuencias

- Los entrypoints pasan de `src/main.js` / `bin/logs-watcher.js` a `dist/src/main.js` / `dist/bin/logs-watcher.js`.
- `npm run build` es requisito antes de `npm test` y antes de construir la imagen.
- El plan de implementación que nombra archivos `.js` queda histórico; la fuente de verdad del lenguaje es este ADR.
- Reabrir si se exige eliminar también `Wire`, o si el despliegue deja de poder usar un stage de build.
