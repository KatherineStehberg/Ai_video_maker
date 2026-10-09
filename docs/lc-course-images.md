# Imágenes de los cursos de Language Center Chile

Siete portadas originales PNG, guardadas en `data/assets/images/lc-chile-courses/`. Son las mismas imágenes asignadas a los cursos en WordPress.

## Usarlas en el editor

1. Actualiza a la rama que incluye estos archivos.
2. Abre AI Video Maker con `npm start`.
3. Abre el proyecto y su biblioteca de recursos visuales. Las imágenes aparecen con el nombre del curso y el sufijo `-cover.png`. Están en la biblioteca global para poder seleccionarlas tanto con **Language Center Chile** como con **Language Center Chile — Cursos**.
4. Asigna la imagen elegida a la escena de apertura, introducción de unidad o cierre.

Para scripts y automatizaciones, consulta `manifest.json`: cada entrada incluye el ID del curso en WordPress, la ruta portable para `scene.assetPath`, dimensiones y SHA-256. Usa `scene.assetKind = "image"`.

Estas portadas no se asignan automáticamente a escenas existentes. Son recursos de introducción; las imágenes didácticas internas y los clips con movimiento se incorporan por separado. El espacio vacío a la izquierda permite agregar títulos desde el editor.

## Remote Work: imágenes internas (9 octubre 2026)

Seis imágenes JPEG en `data/assets/images/lc-chile-courses/remote-work/` cubren las siete lecciones: el proyecto final reutiliza la ilustración de colaboración. El índice `remote-work/manifest.json` relaciona los módulos de los guiones, los títulos, los IDs verificados de lecciones WordPress y las huellas SHA-256. Inicio del curso: 9 diciembre 2026.

Las seis imágenes aparecen en la biblioteca de ambas marcas. Para un video nuevo de la cola de cursos, la primera escena usa la imagen de su lección; las siguientes conservan las ilustraciones con ejemplos escritos. La selección exige marca, título exacto y huella del archivo. No cambia la narración ni modifica proyectos ya renderizados o recursos elegidos en el editor; los trabajos existentes pueden seleccionar estas imágenes manualmente. Un reinicio no vuelve a producir trabajos terminados.

Esta integración aporta imágenes didácticas; no convierte una imagen en un clip generado con IA. Los clips Pexels, voces Edge y movimiento Wan están en el PR #2, todavía sin integrar. El PR #3 incluye estos recursos y la selección de apertura. Para activar lo incluido, incorpora la rama en tu instalación y reinicia el servidor. La cola requiere una voz inglesa SAPI/Piper y el equipo encendido; no se ha observado su estado actual desde este entorno.

Verificación: `node --test tests/course-illustrations.test.js tests/course-production-contract.test.js` comprueba las siete correspondencias, archivos, huellas, biblioteca y preservación de los quince guiones. `npm run courses:check` muestra el estado de la instalación que ejecuta el comando; sus resultados no representan otros equipos.
