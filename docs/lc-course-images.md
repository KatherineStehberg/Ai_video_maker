# Imágenes de los cursos de Language Center Chile

Siete portadas originales PNG, guardadas en `data/assets/images/lc-chile-courses/`. Son las mismas imágenes asignadas a los cursos en WordPress.

## Usarlas en el editor

1. Actualiza a la rama que incluye estos archivos.
2. Abre AI Video Maker con `npm start`.
3. Abre el proyecto y su biblioteca de recursos visuales. Las imágenes aparecen con el nombre del curso y el sufijo `-cover.png`. Están en la biblioteca global para poder seleccionarlas tanto con **Language Center Chile** como con **Language Center Chile — Cursos**.
4. Asigna la imagen elegida a la escena de apertura, introducción de unidad o cierre.

Para scripts y automatizaciones, consulta `manifest.json`: cada entrada incluye el ID del curso en WordPress, la ruta portable para `scene.assetPath`, dimensiones y SHA-256. Usa `scene.assetKind = "image"`.

Estas portadas no se asignan automáticamente a escenas existentes. Son recursos de introducción; las imágenes didácticas internas y los clips con movimiento se incorporan por separado. El espacio vacío a la izquierda permite agregar títulos desde el editor.
