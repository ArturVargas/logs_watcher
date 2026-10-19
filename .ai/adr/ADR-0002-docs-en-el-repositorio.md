# ADR-0002: La documentación vive en docs/, detrás de un puerto

- Estado: aceptada
- Fecha: 2026-10-19
- Contexto: Si un arreglo o un PR deja la documentación vieja, el servicio debe proponer el cambio. Mintlify puede conectarse después. Hoy la documentación de la aplicación vigilada está en su carpeta `docs/`.

## Decisión

La fuente editable de la fase 1 es la carpeta `docs/` del repositorio vigilado (Markdown y MDX). El núcleo depende del puerto `DocsPublisher`, con estas operaciones: `read`, `list`, `searchLiteral`, `applyPatches`. `FilesInRepoAdapter` las implementa con la API de contenidos de GitHub y un clon corto de trabajo. Ningún parche de documentación puede salir de `docs/`.

## Alternativas consideradas

- Publicar directo en Mintlify en la fase 1. Acopla el flujo a un proveedor que todavía no está elegido.
- Editar la documentación con un `PATCH` al issue. No deja el archivo revisable en un PR.

## Consecuencias

- El mapeo código → docs y el formato `docs/map.yml` se definen en la especificación y en ADR-0012.
- Un adaptador Mintlify posterior puede leer o publicar. Los parches siguen aplicándose como cambio de Git en `docs/` hasta que un ADR nuevo diga otra cosa.
- Si la documentación real no está en `docs/`, el prefiltro no la verá.

## Reabrir si

La documentación canónica deja de ser `docs/` en el repositorio vigilado, o Mintlify pasa a ser el único lugar editable.
