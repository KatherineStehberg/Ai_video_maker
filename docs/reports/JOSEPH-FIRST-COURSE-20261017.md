> Correccion posterior: se detectaron marcas SAPI fuera de la duracion del WAV. La cobertura de texto indicada aqui no valida la sincronizacion del primer video. Su MP4 permanece intacto y ahora se indica timing_review. Ver JOSEPH-REMOTE-WORK-FOUNDATIONS-20261017.md para la correccion y la evidencia nueva del segundo curso.

# Primer curso audiovisual para Joseph ? 2026-10-17

## Entrega local
Raiz: C:\Users\jjoseph\Documents\Ai_video_maker-joseph.
Rama: joseph/edicion-cursos. Cola automatica: COURSE_PRODUCTION_ENABLED=0, sin cambios a .env.
Curso: RPM-2026-001, Asynchronous Communication & Team Chat Etiquette. Guion original completo, seis escenas.

- Editor: http://127.0.0.1:4321/project-editor.html?id=vid_course_RPM-2026-001
- MP4: http://127.0.0.1:4321/file?path=output%2Ffinal%2Fasynchronous-communication-team-chat-etiquette_vid_course_RPM-2026-001_16x9.mp4
- Proyecto: data/projects/vid_course_RPM-2026-001.json
- MP4: output/final/asynchronous-communication-team-chat-etiquette_vid_course_RPM-2026-001_16x9.mp4
- Fuentes editables y clips GSAP: data/assets/images/lc-chile-courses/prepared-RPM-2026-001/ (scene-1.html a scene-6.html, specs, render-manifest.json, render-*/animation.mp4, qa.json y capturas).
- Audio separado, SRT y evidencia: output/drafts/vid_course_RPM-2026-001/.
- Respaldo del proyecto inicial: output/drafts/vid_course_RPM-2026-001/preparation/original-project.json.

## Recuperacion e integracion
Se inspeccionaron las tres carpetas conocidas. Las otras dos copias no aportaron medios ni renders audiovisuales anteriores; no se eliminaron ni modificaron. Los archivos audiovisuales del computador original no estaban disponibles alli.
Se conservaron las mejoras de la lista y todos los commits que aparecieron durante el trabajo.
- PR #4, c2729ef: skill lc-course-animations integrada mediante cherry-pick 13172a6. Se leyeron AGENTS.md, SKILL.md, design e integration; CLAUDE.md no existe. Se uso GSAP incluido, sin CDN, timeline determinista, controles de pausa/reinicio y capturas QA.
- PR #2: commits 01b199b y abb3c4c integrados como 0018d2f y 9d18e48. Conflicto resuelto en un comentario del registro de proveedores, conservando la implementacion.
- PR #3: las portadas, ilustraciones y manifests se extrajeron a data/assets/images/lc-chile-courses sin sobrescribir archivos. Sus binarios no se agregan a los nuevos commits.
- Compatibilidad real: FFmpeg, FFprobe, Chrome y Windows SAPI operativos. Voz usada: Microsoft Zira Desktop, ingles, rate -1. Pexels API no configurada; Edge y Wan no operativos porque no hay Python real ni motores/modelos instalados. No se descargaron modelos ni se consumieron APIs de pago.

## Montaje y procedencia
El inicio combina portada Remote Work, seis segundos de metraje real y la demostracion de chat. Las escenas restantes usan explicaciones y demostraciones animadas sobre las cinco partes del mensaje, tono, bloqueos, siglas y practica final. Las ilustraciones recuperadas se integran donde ayudan al tema.
La interfaz mostrada es una demostracion ficticia claramente rotulada, no una captura de una cuenta o conversacion real. Tipografia LC provisional; no se afirma disponer del logo oficial.
No se usa zoom como sustituto del movimiento: hay entradas de elementos, escritura progresiva, comparaciones y enfasis secuencial. Blanco y azul #003366; cortes discretos y fundidos cortos en el metraje.
Clip: MART PRODUCTION, Pexels 7706630, https://www.pexels.com/video/person-working-on-a-laptop-7706630/. Descarga manual gratuita, sin API. Licencia: https://www.pexels.com/license/. Archivo original conservado: data/assets/images/lc-chile-courses/remote-work/typing-7706630.mp4. Atribucion y fuente registradas tambien en sidecars del montaje.
GSAP mantiene su aviso/licencia en los HTML. Se corrigio la conversion de rango de color del renderer para FFmpeg 9 (yuv420p en rango TV), preservando el primer render parcial fallido en un directorio separado.

## Audio, subtitulos y persistencia
SAPI captura eventos SpeakProgress con posiciones reales en el WAV. Los cues conservan todo el texto y usan estos tiempos; si se edita la narracion o un subtitulo propio, no se reutilizan tiempos incompatibles. Se preservan los tiempos al guardar/reabrir y al regenerar una escena SAPI previamente temporizada.
El audio se normalizo; la duracion real de cada escena corresponde a su WAV. No se inventan voces, recursos ni una aprobacion humana.
El enlace Ver video se habilita por evidencia real de decodificacion, audio y movimiento. Huellas de proyecto, MP4, clips, audios y SRT lo invalidan si cambia la entrega. La cola permanece pausada. El diagnostico se consulta por separado, con estados pendientes, pausados y errores distinguibles.
El primer curso aparece como listo para revision final; no significa aprobado para publicacion. Los otros 14 no se produjeron. Durante la tarea aparecio un borrador local del segundo curso, que se conservo intacto.

## Evidencia real
- H.264, 1920x1080, 24 fps, AAC; 185.792 s; 4,789,664 bytes.
- SHA-256 del MP4: 28de47a21712a8e4c625e068f26df6b42cdc4978e216b9094dc3dde5a64d2ff4.
- Decodificacion completa con FFmpeg y xerror: correcta. Volumen medio final -19.6 dB; audio presente y medido en las seis escenas, sin pausas detectadas mayores de 2.5 segundos.
- Cobertura de subtitulos: 100 %, guion completo intacto. Tiempos obtenidos de la voz sintetizada, sin modelo de transcripcion.
- Movimiento en el MP4 final: 16, 13, 8, 13, 11 y 11 hashes visuales distintos en muestras de las seis escenas. Se excluye la banda inferior de subtitulos/progreso para evitar falsos positivos.
- Cinco capturas QA por animacion inspeccionadas en hojas de contacto; finales revisados a tamano completo. Sin recortes ni solapamientos encontrados; banda inferior reservada para subtitulos.
- Chrome: reproduccion hasta ended; pico de audio real 0.5956; editor y lista sin errores JavaScript. Rutas y ajustes persistentes al recargar. Captura del MP4 con subtitulos inspeccionada.
- Evidencia JSON: preparation/final-verification.json y preparation/browser-verification.json dentro del directorio de trabajo del proyecto.

## Pruebas
3 pruebas de la skill aprobadas. Suite pertinente: 28 aprobadas, 9 omitidas explicitamente por ausencia de Python, 0 fallos. Las omitidas cubren integraciones opcionales Edge/Wan y no se presentan como pruebas reales de esos servicios. Se probaron clips con FFmpeg, contrato, seguridad HTTP, cola pausada, edicion persistente y cues temporizados.
Comandos: node --test .agents/skills/lc-course-animations/scripts/build.test.cjs; node scripts/ejecutar-pruebas.mjs tests/speech-cues.test.js tests/course-editing.test.js tests/course-production.test.js tests/course-production-contract.test.js tests/course-production-http.test.js tests/edge-voices.test.js tests/moving-clips.test.js tests/wan-motion.test.js; node scripts/verify-first-course.mjs; node scripts/prepared-course-smoke.mjs.
El script previo course-editing-smoke.mjs comprueba borradores sin MP4; para esta entrega ya preparada se usa prepared-course-smoke.mjs.

## Respaldo y ajustes
Con el servidor detenido, copiar conservando la estructura relativa: el JSON de data/projects, data/assets/images/lc-chile-courses completo, output/drafts/vid_course_RPM-2026-001 completo y el MP4 de output/final. Esto conserva originales, fuentes HTML/GSAP, manifests, pistas, SRT y evidencias. El codigo y la skill estan en Git. No basta clonar GitHub para recuperar los medios locales.
No copiar node_modules: se reinstala. Los medios, proyectos, caches y credenciales siguen excluidos de Git. Guardar secretos separadamente mediante un respaldo privado; no incluirlos en un commit ni en el informe.
Joseph puede abrir y ajustar el proyecto. Tras un cambio audiovisual y una nueva exportacion, ejecutar la verificacion para renovar el enlace de revision: node scripts/verify-first-course.mjs. No regenerar todo con el script de preparacion sobre un proyecto ya editado; ese script se detiene si detecta cambios en el guion. El ensamblaje inicial se niega a sobrescribir un MP4 existente.
Pendiente: revision humana final de pronunciacion (incluidas siglas), ritmo y valor didactico. La calidad de una voz local sintetica no equivale a una locucion profesional. No se publico en WordPress, no se desplego y no se modifico la rama principal.
