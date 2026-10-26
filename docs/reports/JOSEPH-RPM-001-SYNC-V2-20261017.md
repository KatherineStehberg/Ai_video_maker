# RPM-2026-001 - correccion de sincronizacion v2

## Resultado
Se aplico la solucion SAPI de 7ac3f90, con formato explicito PCM mono 16000 Hz, normalizacion y marcas de palabras dentro del WAV. Se regeneraron todas las narraciones y subtitulos del guion completo, sin cambiar su texto. La cola permanece COURSE_PRODUCTION_ENABLED=0.
El proyecto activo se actualizo solo despues de verificar el candidato en almacenamiento y servidor separados. Ahora figura review_ready y Ver video apunta a la version nueva.

## Rutas locales
Raiz: C:\Users\jjoseph\Documents\Ai_video_maker-joseph.
- Editor: http://127.0.0.1:4321/project-editor.html?id=vid_course_RPM-2026-001
- MP4 nuevo: http://127.0.0.1:4321/file?path=output%2Frevisions%2FRPM-2026-001-sapi-sync-v2%2Fmedia%2Ffinal%2Fasynchronous-communication-team-chat-etiquette_vid_course_RPM-2026-001_16x9.mp4
- Proyecto activo: data/projects/vid_course_RPM-2026-001.json.
- MP4 nuevo: output/revisions/RPM-2026-001-sapi-sync-v2/media/final/asynchronous-communication-team-chat-etiquette_vid_course_RPM-2026-001_16x9.mp4.
- Proyecto anterior: output/revisions/RPM-2026-001-sapi-sync-v2/backup/project-before.json.
- Copia del MP4 anterior: output/revisions/RPM-2026-001-sapi-sync-v2/backup/video-before.mp4. El original tambien permanece en output/final/asynchronous-communication-team-chat-etiquette_vid_course_RPM-2026-001_16x9.mp4.
- Proyecto candidato conservado: output/revisions/RPM-2026-001-sapi-sync-v2/projects/vid_course_RPM-2026-001.json.
- Audio, SRT y evidencias nuevos: output/revisions/RPM-2026-001-sapi-sync-v2/media/drafts/vid_course_RPM-2026-001/.
- Animaciones y fuentes reutilizadas sin modificaciones: data/assets/images/lc-chile-courses/prepared-RPM-2026-001/.
Los archivos audiovisuales anteriores en output/drafts/vid_course_RPM-2026-001 no se sobrescribieron. Para respaldar esta entrega conservar el JSON activo, todo output/revisions/RPM-2026-001-sapi-sync-v2 y data/assets/images/lc-chile-courses completo, manteniendo rutas relativas.

## Duraciones y animaciones
Duraciones nuevas por escena: 27.610, 30.300, 31.145, 30.240, 30.515 y 35.990 segundos. Cambios frente a la version anterior: entre 4.667 y 6.042 milisegundos. Todos los clips existentes cubren las nuevas duraciones; se verificaron sus longitudes y no fue necesario modificar ni volver a renderizar las animaciones. El montaje y los subtitulos se exportaron de nuevo.

## Verificacion de palabras y sincronia
396 eventos SAPI comprobados. Los offsets cubren todas las letras y numeros del texto; tiempos ordenados, posiciones validas y todos los eventos dentro de cada WAV. Se verifico tambien el ultimo evento de cada escena.
Se compararon ventanas de audio del WAV fuente y el MP4 mediante correlacion normalizada, y se comprobaron las palabras y los cues correspondientes:
- beginning: palabra "a", tiempo global 0.585 s, desfase detectado 0.0 ms, correlacion 0.999809.
- middle: palabra "it", tiempo global 93.140 s, desfase detectado 0.0 ms, correlacion 0.999733.
- end: palabra "the", tiempo global 183.015 s, desfase detectado 0.0 ms, correlacion 0.999883.
Resolucion de busqueda: 1 ms; no se detecto desfase en estas tres ventanas. Son mediciones del audio real, no estimaciones por longitud de texto ni mocks.
Chrome genero mp4-sync-beginning.png, mp4-sync-middle.png y mp4-sync-end.png; capturas inspeccionadas sin recortes o solapamientos. El video se reprodujo hasta ended, con pico de audio 0.5963 y sin errores JavaScript; el editor conservo las seis escenas, clips, voz, subtitulos y ajustes al reabrir.

## MP4 y evidencia
H.264 1920x1080, 24 fps, AAC, 185.792 segundos, 4838666 bytes. Decodificacion completa con FFmpeg xerror correcta, audio en las seis escenas, volumen medio -19.6 dB y cobertura de subtitulos del 100 %.
Movimiento real confirmado excluyendo la banda inferior de subtitulos: 16, 13, 8, 13, 11, 11 cuadros distintos en las muestras.
SHA-256 nuevo: 1d70da5265bfa83ec46ce89dfb6a729a9894ff2d485bcac54d3120988de38735.
SHA-256 anterior y de su copia: 28de47a21712a8e4c625e068f26df6b42cdc4978e216b9094dc3dde5a64d2ff4.
Evidencia en output/revisions/RPM-2026-001-sapi-sync-v2/media/drafts/vid_course_RPM-2026-001/preparation: sync-verification.json, final-verification.json, browser-verification.json, capturas y narration-evidence.json. El servidor temporal 4322 se cerro despues de publicar el candidato; el servidor principal 4321 sigue funcionando.

## Proteccion del segundo curso y estados
Se registraron y compararon las huellas de 191 archivos de RPM-2026-002, incluyendo proyecto, recursos, audios, SRT, evidencias y MP4. Ninguno cambio. Su estado sigue review_ready. Los otros cursos no se produjeron y la cola sigue pausada.
protected.json y published.json dentro de la revision registran las comparaciones y el cambio de proyecto. La publicacion local se detiene si el proyecto activo, el MP4 previo o algun archivo protegido del segundo curso cambia durante la preparacion.

## Codigo y pruebas
Las herramientas de preparacion y verificacion ahora respetan AIVM_PROJECTS_DIR y AIVM_OUTPUT_DIR tambien para respaldos y evidencias. La revision se construyo aislada antes de activar el JSON final. scripts/check-course-sync.mjs comprueba todas las palabras y la correlacion de tres ventanas. --require-sync impide verificar la revision sin evidencia vigente; scripts/revise-course-sync.mjs exige ademas QA de navegador, respaldos integros y proteccion del segundo curso antes de activar el proyecto.
15 pruebas aprobadas: cobertura y rechazo de eventos, SAPI real, cues, seleccion de curso, cola, seguridad HTTP y persistencia. Comando: node scripts/ejecutar-pruebas.mjs tests/word-marks.test.js tests/sapi-timing.test.js tests/speech-cues.test.js tests/course-target.test.js tests/course-editing.test.js tests/course-production.test.js tests/course-production-http.test.js.
Solo codigo y documentacion se publican en joseph/edicion-cursos. No se incluyen medios, proyectos, respaldos, caches ni credenciales. No se hizo merge ni despliegue. Pendiente unicamente la revision humana final de pronunciacion y didactica; la sincronizacion tecnica solicitada esta comprobada.
