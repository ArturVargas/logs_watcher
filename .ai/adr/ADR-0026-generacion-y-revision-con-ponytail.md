# ADR-0026: La generación y la revisión de código usan ponytail

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: El código de logs_watcher lo escribe `el-chalan-dev` desde un VPS. Hace falta una sola regla para no añadir código de más, y la misma regla al revisar. El skill es [ponytail](https://github.com/DietrichGebert/ponytail). No se copia dentro de este repositorio.

## Decisión

Cada generación de código y cada revisión de código de este repositorio usa ponytail. El nivel es `full`, salvo que la persona pida otro nivel del propio skill.

El texto que manda es el del upstream, en ese clon:

- Generación: `skills/ponytail/SKILL.md`
- Revisión: `skills/ponytail-review/SKILL.md`
- Carga por agente: `INSTALL.md`

`el-chalan-dev`, en el VPS, antes de la primera tarea de código:

```bash
git clone https://github.com/DietrichGebert/ponytail.git "$HOME/ponytail"
```

El clon queda fuera de logs_watcher. No se hace commit de `SKILL.md`, de `AGENTS.md` ni de una regla `.cursor/rules/ponytail.mdc`.

En Cursor, desde ese clon y sin `--project`:

```bash
node "$HOME/ponytail/scripts/cursor-hooks.js" install
```

Eso escribe `~/.cursor/hooks.json` del usuario. Si el agente no es Cursor, se sigue la sección de ese agente en `$HOME/ponytail/INSTALL.md`. En cualquier agente, la tarea de código empieza leyendo `$HOME/ponytail/skills/ponytail/SKILL.md`. La revisión lee `$HOME/ponytail/skills/ponytail-review/SKILL.md`. Un host con el comando usa `/ponytail-review` sobre el diff de esa tarea.

Los hooks de Cursor no inyectan nada en un cloud agent ni en un subagente. Ahí manda leer el `SKILL.md` del clon al empezar.

La revisión que exige el skill sale en inglés, con sus encabezados. No se traduce.

## Alternativas consideradas

- Copiar el skill dentro de logs_watcher. Se queda viejo. Este ADR lo prohíbe.
- Una lista propia de “código pequeño”, aparte del skill. Serían dos reglas.
- Obligar un solo agente. En el VPS vale el agente que `el-chalan-dev` ya use. El skill es lo que no cambia.

## Consecuencias

- Un diff que el skill no permite no entra, aunque un plan lo hubiera pedido. El conflicto se anota en el plan. No se reabre un ADR de producto.
- No se fusiona una tarea con un `Must fix` abierto en esa revisión.
- ADR-0014 sigue siendo el idioma del issue de la aplicación vigilada. No es el idioma del informe de `ponytail-review`.

## Reabrir si

Artur deja de usar ponytail en este repositorio, o el upstream deja de publicarse en https://github.com/DietrichGebert/ponytail.
