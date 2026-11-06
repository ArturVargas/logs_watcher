# Reglas de los especialistas del fix (ADR-0028)

Este documento fija las reglas que el código usa para decidir qué especialista corre. Lo implementa `src/specialists.js` y lo prueba `test/specialists.test.js`. El modelo nunca elige quién corre.

## Cuándo corre cada uno

Solo hay especialistas cuando el job de fix ya tiene un parche de código validado (`reviewFix` ok). El orden es siempre el de ADR-0028 y cada uno corre como máximo una vez.

| Especialista | Corre si |
| --- | --- |
| `solidity` | Algún archivo del parche termina en `.sol`. |
| `rust` | Algún archivo termina en `.rs`. |
| `typescript-backend` | Algún archivo de script es de servidor (tabla de abajo). |
| `typescript-frontend` | Algún archivo de script es de interfaz, o es una hoja de estilos. |
| `business` | La clase de severidad ya está calculada. Recibe además la clase. |
| `docs` | No se llama aquí: es la llamada de deriva de docs que ya existe (`src/pulls.js`), y solo corre cuando se abre el PR (`LOGS_WATCHER_DRY_RUN=false`). El payload lo marca como `docs: "drift"`. |
| `tests` | Siempre que hay parche validado. |
| `security` | El parche toca autenticación, transferencia de valor, secretos o Rust `unsafe` (ver abajo). |

## TypeScript de servidor contra interfaz

Archivos de script: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`. Rutas en minúsculas, globs con `**`.

1. Hojas de estilo (`.css .scss .sass .less`) son interfaz.
2. Si la ruta casa con `serverPaths`, es servidor. **Servidor gana**: `app/api/x/route.tsx` es servidor.
   Por defecto: `api/`, `server/`, `routes/`, `workers/`, `worker/`, `functions/`, `middleware.*`, `*.server.*`, `route.ts|js`, `actions.ts`, `*.action.ts`.
3. Si no, y casa con `uiPaths`, es interfaz.
   Por defecto: `pages/`, `components/`, `app/**/page.*`, `app/**/layout.*`, `hooks/`, `views/`, `forms/`, `ui/`, y cualquier `.tsx` o `.jsx`.
4. Si no casa con ninguna, no llama a ninguno de los dos (ADR-0028: no hay rol genérico). Ejemplo: `src/lib/format.ts`.

## Cuándo corre `security`

Basta una de estas señales en cualquier archivo del parche:

- Una palabra de la ruta contiene: `auth session jwt oauth password passwd crypto signature signer wallet payment transfer withdraw deposit balance ledger secret credential token permission`.
- Un identificador del `before` o `after` (separando camelCase y `_`) es o contiene: `auth session jwt oauth password crypto signature sign verify wallet privateKey payment transfer withdraw deposit balance ledger secret apiKey credential bcrypt hmac`. Las palabras de 4 letras o menos (`auth`, `sign`) solo cuentan como palabra completa, para no disparar con `author` o `design`.
- Manejo de entorno o secretos: `process.env`, `import.meta.env`, `Deno.env`, `std::env`, `env::var`, `dotenv`, `.env`.
- Rust con `unsafe`.

La regla es deliberadamente amplia: un falso positivo cuesta una llamada; un falso negativo deja sin revisar un cambio sensible.

## Configuración por target

Cada target puede reemplazar cualquier lista con `specialists` en su config. Una lista dada reemplaza a la de por defecto; las no dadas siguen igual.

```jsonc
"specialists": {
  "uiPaths": ["apps/game/src/**"],
  "serverPaths": ["apps/api/**"],
  "securityPathWords": ["auth", "wallet", "payment"]
}
```

Claves: `scriptExtensions`, `serverPaths`, `uiPaths`, `uiExtensions`, `securityPathWords`, `securityIdentifiers`, `securityEnvPatterns`.

## Contrato, presupuesto y modo en seco

- Contexto: el diff depurado (`<untrusted source="diff">`) y como máximo 15 docs candidatos con la misma selección que la deriva (`docs/map.yml`, nombres, símbolos). Cero docs es válido. Tope de caracteres: `limits.promptCharCap`.
- Respuesta: `{"evidence":[{"source":"diff"|"doc","quote":"..."}],"summary":"..."}`. Cada cita es literal y de al menos 8 caracteres. Si falla, la respuesta se ignora y no se vuelve a pedir. Clase, urgencia o parches en esa respuesta se tiran.
- Cada llamada se cobra en `cost_ledger` con `kind = 'specialist'` y cuenta para `dailyBudgetUsd`. Antes de cada llamada se mira el tope: si ya se alcanzó, ese especialista y los que siguen quedan en `skipped` con motivo `budget`, y la propuesta se guarda igual.
- Un 429/5xx/401/403 de un especialista no mata el job: queda `skipped: call_failed`.
- El resultado va en `proposals.payload.specialists` (`selected`, `results`, `skipped`, `docs`). Ningún especialista escribe en GitHub. En modo en seco las llamadas al modelo pueden ocurrir (si hay `LLM_API_KEY` y `LLM_MODEL`), pero no hay escritura en GitHub.
