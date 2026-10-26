---
name: lc-course-animations
description: Crear animaciones didácticas modernas para cursos de Language Center Chile en HTML + GSAP y MP4 Full HD. Usar al pedir slides en movimiento, procesos por etapas, datos animados, comparaciones antes/después o recursos para WordPress MasterStudy; coordinar producción y evidencia desde KSL Orquestador y AI Video Maker.
---

# Animaciones didácticas LC

Crear movimiento que explique un objetivo de aprendizaje. Entregar HTML editable y MP4 reproducible; distinguir producción, publicación y prueba como alumno.

## Preparar

1. Leer contenido actual de la lección e instrucciones del repositorio. Identificar curso, nivel, idioma y objetivo; no adoptar temas de ejemplos ajenos.
2. Leer [marca y patrones](references/design.md). Elegir proceso, datos o transformación. Usar la plantilla para cuatro etapas; diseñar otra composición si cuatro tarjetas no explican el concepto.
3. Definir título, ejemplo y actividad final. Ajustar duración al tiempo de lectura; comenzar con 20–40 segundos. Reservar loops de 10 segundos para contenido breve.
4. Usar blanco predominante, azul #003366 y acentos moderados, sin rojo. Usar el logo oficial si está disponible; la plantilla tiene una marca tipográfica provisional LC. No convertir la paleta de Relevo en marca LC.
5. Buscar nuevas referencias si mejoran la pieza. Registrar fuentes y licencias de recursos descargados. Preferir SVG/CSS propios para diagramas precisos.
6. Ofrecer pausa y reinicio. Mantener una timeline GSAP determinista con `window.duration` en segundos y `window.renderAt(t)`. Animar posición, énfasis y relaciones; evitar destellos.

## Generar y exportar

La plantilla incluye GSAP 3.15.0 sin CDN. Conservar su aviso y [licencia](references/gsap-license.md). Requerir Node, Chrome/Chromium, FFmpeg y ffprobe. Instalar Playwright Core con `npm install --prefix <skill>/scripts`; en Windows usar `npm.cmd`.

Copiar `assets/example.json` a un archivo de trabajo. Editar `course,title,sub,names[4],hints[4],examples[4],question,tip,duration`. Usar `mode:"web"` y `lang:"es"` para interfaz en español. Ajustar las frases al nivel; el ejemplo Business English no es automáticamente adecuado para A2.

```bash
node <skill>/scripts/build.cjs spec.json output/lesson.html
node <skill>/scripts/render.cjs output/lesson.html output/qa --qa
node <skill>/scripts/render.cjs output/lesson.html output/render
```

Configurar CHROME_PATH, FFMPEG_PATH y FFPROBE_PATH sólo si faltan los binarios en rutas habituales. Usar directorios nuevos; no sobrescribir resultados.
El render produce 1920×1080, 24 fps, H.264/yuv420p, faststart y **sin audio**.
Para narración, generar una pista real con el sistema de voz existente, ajustar timing, mezclar con FFmpeg y escuchar el resultado. No afirmar que existe voz por tener subtítulos o una pista vacía.
Usar Remotion/Hyperframes si el proyecto ya los emplea o necesita secuencias más complejas; consultar documentación vigente antes de integrar.

## Verificar

- Inspeccionar las cinco capturas QA: inicio, pasos y actividad final. Corregir recortes, superposición, contraste y tiempo insuficiente.
- Confirmar movimiento; el renderer exige tres hashes diferentes entre las muestras.
- Abrir HTML y comprobar pausa, reinicio, loop y seek hacia atrás sin acumular efectos.
- Medir dimensiones, fps, duración, cuadros y códec con ffprobe; decodificar completo con FFmpeg. Conservar qa.json y SHA-256.
- Escuchar si existe narración; etiquetar “sin narración” si no existe.
- Entregar MP4, HTML y evidencia. No incluir node_modules, binarios, secretos ni videos pesados en commits de la skill.

## Publicar y coordinar

Leer [integración](references/integration.md). Publicar sólo dentro del alcance autorizado; leer y preservar contenido existente. Reutilizar medios ya subidos.
Usar la URL real de Medios y reproductor con controles; evitar pegar scripts GSAP dentro de TinyMCE, que puede sanear scripts/estilos.
Guardar, recargar y comprobar que persiste el video correcto. Probar como alumno si hay acceso. Si aparece matrícula, informar “insertado; prueba como alumno pendiente”, sin cambiar acceso del curso.
Registrar curso/lección, archivos, valores medidos, audio, URL/ID y estado real. Cerrar sólo etapas verificadas.
Mantener este paquete idéntico en ambos repositorios. La skill habilita agentes y CLI; copiarla no crea un botón, endpoint o worker automático.
