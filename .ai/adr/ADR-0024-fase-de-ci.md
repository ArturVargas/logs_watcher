# ADR-0024: La CI se mejora en una fase posterior, con diffs pequeños

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: El arreglo normal no debe tocar workflows. Artur también quiere que la CI se configure y mejore poco a poco, después del bucle de fix del MVP, y que el pipeline siga en verde. Esa es la única fase en la que los workflows pueden cambiar.

## Decisión

La fase de CI es posterior al bucle de fix del MVP. No está activa hasta que `phases.cicd` sea `true`. El valor inicial es `false`.

Con la fase apagada, la GitHub App no tiene permiso de Workflows y ningún job edita `.github/workflows/`. Eso conserva la prohibición del arreglo normal que ya estaba en ADR-0004.

Con la fase encendida, el permiso de Workflows pasa a escritura solo para el job `cicd_improve`. Ese job es el único que puede editar archivos bajo `.github/workflows/`. El agente de fix sigue sin poder hacerlo, aunque el token de la App ya tenga el permiso. El diff de ese job se rechaza si cambia más de 80 líneas o toca algo fuera de `.github/workflows/`.

El pipeline tiene que seguir en verde. Si el SHA de la rama por defecto no tiene CI en verde, `cicd_improve` no abre otro cambio. El pull request de CI se fusiona solo si cumple ADR-0022, incluida la CI en verde del propio SHA. Si el pipeline queda en rojo, no hay más ediciones de workflow hasta que una persona lo deje en verde.

## Alternativas consideradas

- Dar permiso de Workflows desde el MVP y dejar que el fix edite la CI. Un arreglo de un bug podría cambiar el pipeline.
- No tocar nunca los workflows. No hay forma de configurar la CI que Artur pidió.
- Diffs grandes de una sola vez. Cuesta ver qué rompió el pipeline.

## Consecuencias

- ADR-0004 sigue describiendo el permiso del bucle de fix, sin Workflows. La ampliación vive aquí y solo con `phases.cicd`.
- Mientras la fase está apagada, “CI en verde” de ADR-0022 casi no se cumple, y la fusión automática no corre. Una persona puede fusionar.
- Un workflow roto bloquea la siguiente mejora automática.

## Reabrir si

El arreglo de un bug tiene que modificar un workflow para ser correcto, o la fase de CI debe convivir con diffs de más de 80 líneas.
