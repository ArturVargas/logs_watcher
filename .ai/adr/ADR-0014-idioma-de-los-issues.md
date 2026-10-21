# ADR-0014: El idioma del issue lo elige el target

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto: La versión del 2026-10-19 exigía español en todo el issue. Artur la sustituye: el issue puede ir en español, en inglés, o elegir uno de los dos según el texto que disparó el hallazgo. Un mismo cuerpo no mezcla idiomas.

## Decisión

Cada target tiene `issueLanguage`: `es`, `en` o `both`. El valor por defecto es `both`.

Con `es` o `en`, el título, el cuerpo, los comentarios del servicio y el `summary` del pull request van en ese idioma. Con `both`, el servicio elige un solo idioma para todo el issue: si el texto que dispara el hallazgo tiene un idioma claro, usa ese; si no, español. La elección se guarda en el grupo y los comentarios posteriores usan el mismo idioma. No hay un cuerpo que empiece en un idioma y siga en el otro.

El idioma claro se decide sin el modelo de parches (ADR-0025) y sin el clasificador de importancia. Sobre el texto ya depurado se cuentan palabras enteras. Español: `el`, `la`, `los`, `las`, `que`, `para`, `con`, `por`, `una`, `del`. Inglés: `the`, `and`, `for`, `with`, `this`, `from`, `when`, `that`. Si el español tiene al menos dos aciertos y más que el inglés, el idioma es `es`. Si el inglés tiene al menos dos y más que el español, es `en`. En cualquier otro caso, español.

Los identificadores técnicos se quedan en inglés: clases, etiquetas, rutas, eventos, comandos y claves JSON. Los códigos de log (`msg`) van en inglés. Una cita de evidencia se copia literal, en el idioma en que vino, dentro del bloque de evidencia.

## Alternativas consideradas

- Mantener solo español. Choca con la decisión nueva de Artur.
- Mezclar español e inglés en el mismo cuerpo cuando `both`. Cuesta de leer y no hay una sola plantilla que validar.
- Pedir el idioma al modelo de parches. Puede cambiar a mitad del issue.

## Consecuencias

- Hay dos plantillas, una por idioma, con las mismas secciones. El servicio usa una entera.
- Un grupo no cambia de idioma porque un comentario posterior venga en el otro.
- El valor por defecto `both` no inventa inglés si el texto no lo muestra con claridad.

## Reabrir si

Hace falta un tercer idioma, o el mismo issue debe llevar los dos textos a la vez.
