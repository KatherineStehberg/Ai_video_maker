# Remote Work Foundations - RPM-2026-002

Preparado en C:\Users\jjoseph\Documents\Ai_video_maker-joseph, rama joseph/edicion-cursos. Se reutilizo y respaldo el borrador existente, conservando el guion completo y sus siete escenas. Cola automatica COURSE_PRODUCTION_ENABLED=0.

## Acceso y archivos
- Editor: http://127.0.0.1:4321/project-editor.html?id=vid_course_RPM-2026-002
- Video: http://127.0.0.1:4321/file?path=output%2Ffinal%2Fremote-work-foundations_vid_course_RPM-2026-002_16x9.mp4
- Proyecto: data/projects/vid_course_RPM-2026-002.json.
- MP4: output/final/remote-work-foundations_vid_course_RPM-2026-002_16x9.mp4.
- Fuentes HTML, specs y clips: data/assets/images/lc-chile-courses/prepared-RPM-2026-002/.
- Audio, subtitulos y evidencias: output/drafts/vid_course_RPM-2026-002/.
- Respaldo inicial: preparation/original-project.json. Audio previo a la correccion: preparation/audio-before-timing-fix/, dentro del directorio de trabajo anterior.

## Contenido audiovisual
Siete composiciones especificas: primer dia remoto, vocabulario, work as/in/for, presentacion de Valentina Torres, preguntas de onboarding, practica de preposiciones y perfil profesional. Marca LC blanca y azul, sin rojo. Ejemplos y pantallas ficticios rotulados.
Se aplico lc-course-animations con GSAP local y timeline determinista. Portada Remote Work, ilustracion foundations-internal.jpg y metraje Pexels ya descargado reutilizados, sin nuevas llamadas de pago ni modelos. Fuentes y licencia del metraje: informe JOSEPH-FIRST-COURSE-20261017.md. Se conservaron cinco capturas QA por clip; hojas y finales inspeccionados.
La respuesta del ejercicio se revela a los 9.41 segundos de su escena, al comenzar la respuesta narrada, despues de la indicacion de pausa. El primer clip de ese ejercicio se conserva aparte.

## Correccion de SAPI y alcance
Se detecto un error real: SetOutputToWaveFile sin formato explicito producia PCM de 22050 Hz, mientras las marcas SpeakProgress estaban referidas a la base de 16000 Hz en esta instalacion. Algunas marcas excedian el WAV. El agrupador anterior las filtraba y la cobertura de texto no detectaba el desfase.
Ahora la sintesis temporizada exige PCM mono de 16000 Hz y despues normaliza a 48000 Hz. Se versiona la cache, se rechazan marcas fuera del audio y la verificacion comprueba el ultimo evento del guion. Una prueba real con SAPI comprueba formato y tiempos; no es un mock.
Se renovo la narracion y los subtitulos del segundo curso. El primer MP4 se conservo intacto: SHA-256 28de47a21712a8e4c625e068f26df6b42cdc4978e216b9094dc3dde5a64d2ff4. Su sincronizacion anterior tambien necesita renovacion; la lista lo indica como timing_review y conserva Editar proyecto, sin presentarlo como verificado. No se ha corregido ni sobrescrito ese MP4 en esta tarea.
Solo se muestra Ver video cuando la evidencia incluye speechTimingVerified, decodificacion, audio, movimiento y huellas vigentes. Esto corrige la conclusion demasiado amplia del informe anterior: cobertura de texto del 100 % no equivale a sincronizacion validada.

## Verificacion real del segundo video
- H.264 1920x1080, 24 fps, AAC, 201.084 segundos, 5,334,270 bytes.
- SHA-256: 12a9c571009354af79537b6b21fc83c6e2582e32e67cdd171461d8d018e17e34.
- Decodificacion completa FFmpeg con xerror: correcta. Audio en las siete escenas; volumen medio -19.6 dB, sin pausas detectadas mayores de 2.5 segundos.
- Guion completo intacto; cobertura de subtitulos 100 %. Todas las marcas de voz estan dentro de sus WAV y el evento final corresponde al cierre del texto.
- Movimiento en el MP4: 16, 13, 8, 8, 6, 8 y 13 cuadros diferentes en las muestras de cada escena. Se excluye la banda inferior de subtitulos y progreso; el ejercicio se muestrea durante la revelacion prevista.
- Chrome: reproduccion hasta ended, audio real con pico 0.5954, sin errores JavaScript. Proyecto reabierto con clips, voz, subtitulos y ajustes conservados.
- Evidencia: preparation/final-verification.json y preparation/browser-verification.json.
- 15 pruebas pertinentes aprobadas, incluidas la sintesis SAPI real, seleccion segura de curso, rechazo de marcas invalidas, seguridad HTTP, persistencia y estado timing_review.

## Herramientas y respaldo
Las herramientas anteriores ahora aceptan RPM-2026-002 como argumento, conservando RPM-2026-001 como valor por defecto. Reutilizan el codigo de preparacion, construccion, render, montaje, verificacion y navegador, sin asumir seis escenas. El plan didactico versionado vive en content/courses/visual-plans/RPM-2026-002.json. Un identificador desconocido se rechaza.
Ejemplos: node scripts/verify-first-course.mjs RPM-2026-002; node scripts/prepared-course-smoke.mjs RPM-2026-002. No volver a ejecutar ensamblaje sobre una exportacion existente; el comando se detiene para conservarla.
Para respaldar el curso, copiar su JSON de data/projects, data/assets/images/lc-chile-courses completo (incluye recursos compartidos), output/drafts/vid_course_RPM-2026-002 y su MP4 de output/final, manteniendo rutas relativas. Los medios, proyectos, caches y credenciales permanecen fuera de Git. El codigo y esta documentacion se publican en joseph/edicion-cursos.

## Pendientes
Revision humana de pronunciacion, ritmo y didactica del segundo curso. Renovar los subtitulos del primer video conservando su version anterior. Los cursos restantes no se produjeron; Wan y voces externas no son requisitos para este montaje. No se modifico .env ni se hizo merge a principal o despliegue.
