# Producción de cursos de Language Center Chile

Preparado para Katherine Stehberg, 4 octubre 2026.

## Uso

La versión actualizada inicia la cola con `npm start`. El editor incluye el enlace **Videos de cursos · revisión final**. También se puede abrir `http://127.0.0.1:4321/course-production.html`.

Incluye 15 guiones y 96 escenas: siete videos de Remote Work y ocho de Corporate English + AI. Los textos completos están en `docs/courses/lc-chile-recording-scripts-20261004.md`; el paquete de producción está en `content/courses/lc-chile-20261004.json`.

La cola produce un video a la vez con el pipeline local. Usa narración en inglés, formato 1920×1080, duración automática, subtítulos completos y fondo de marca blanco/azul. No solicita revisión previa de cada guion. La intervención de Katherine ocurre al abrir **Revisar edición**, comprobar el resultado y exportar la versión elegida con el editor existente. La cola no publica en WordPress.

## Requisitos operativos

El equipo debe mantenerse encendido y el servidor debe estar ejecutándose. Se requiere una voz inglesa SAPI de Windows o un modelo inglés Piper instalado, FFmpeg y ffprobe. Sin esos requisitos se informa el bloqueo y no se genera una clase silenciosa. `npm run courses:check` valida el paquete y muestra el diagnóstico. No descarga motores, modelos ni claves.

Si AI Video Maker ya estaba abierto antes de recibir esta actualización, hay que actualizar la rama `feat/personal-video-studio` y reiniciar `npm start`. El servicio que ya estaba en ejecución no incorpora código nuevo por sí mismo. No hay despliegue permanente ni servicio remoto activado por este cambio.

## Recuperación y revisión

El estado se conserva localmente en `data/course-production/state.json`, excluido de Git. Un reinicio conserva los identificadores de los trabajos. El envío se registra antes de iniciar producción y se recupera por la identidad del guion para evitar duplicados. Las interrupciones de un proyecto local permiten hasta dos reanudaciones automáticas usando el trabajo ya producido. Después se registra el error para intervención técnica; nunca se cobra ni se reintenta un proveedor de pago.

Antes de mostrar **Listo para revisión final**, se comprueba el MP4 con ffprobe, pista de audio, resolución, duración, archivos de narración de todas las escenas, subtítulos y coincidencia del texto completo. La calidad de la voz, la pronunciación y la sincronía requieren escuchar y mirar el video: la comprobación técnica no sustituye esa revisión.

El proveedor de video se fija a `pipeline`; los guiones y escenas explícitos evitan generación de texto mediante LLM. Las imágenes usan la cadena existente de recursos locales/Pexels/fondos FFmpeg, sin proveedor de imágenes de pago. Música desactivada por defecto. No se habilitan servicios de pago ni se cambian las restricciones de red de la aplicación. Para pausar la cola al iniciar: `COURSE_PRODUCTION_ENABLED=0`.

## Alcance editorial

Remote Work adapta siete guiones Gamma v0.1: referencias al LMS actual, actividades individuales y cierre sin promesas de revisión docente o certificación. Se corrigió una asignación contradictoria de responsables en Remote Collaboration y se eliminó una instrucción de compartir contraseñas. Los ejemplos ficticios se identifican como tales; un CV real nunca debe incluir experiencia simulada.

Corporate desarrolla ocho guiones nuevos desde el programa académico y workbook RPM-2026-016. Los ejemplos adicionales son simulaciones didácticas. Las actividades grupales se adaptaron a grabación individual y autoevaluación. No se declara que el curso o sus grabaciones estén terminados antes de producir y revisar los archivos.

Los guiones constituyen videos breves de explicación y práctica; las actividades del LMS aportan el trabajo del estudiante. Las duraciones indicadas en los borradores Gamma no se imponen ni se inventa contenido para alcanzarlas.

## Verificación

`npm.cmd run courses` (alias de `courses:check`) valida los textos y muestra el progreso guardado. Los cursos usan ilustraciones didácticas originales generadas localmente con FFmpeg, blanco y azul marino, sin búsquedas externas ni APIs. Cada MP4 debe decodificarse completamente y tener señal de audio por encima de -55 dB para ofrecerse a revisión. Un fallo al incrustar subtítulos detiene el render del curso.

En Windows, SAPI necesita ejecutarse con la cuenta habitual del equipo; el sandbox puede ocultar las voces instaladas. El servidor debe permanecer abierto y el equipo encendido. Los enlaces `127.0.0.1` funcionan solamente en este computador. Los MP4 se conservan en `output/final/` y el estado en `data/course-production/state.json`.

`npm run courses:test` prueba secuencia, persistencia, recuperación y bloqueo ante errores. `node --test tests/course-production-contract.test.js` verifica los 15 guiones y la selección de voz inglesa. `npm test` desactiva la cola de cursos para no mezclar renders de prueba con trabajo real.

## Video de portafolio — AI Video Maker (Upwork)

Añadido por solicitud de Katherine Stehberg el 19 de octubre de 2026.

- ID: PORTFOLIO-AVM-001.
- Título: AI Video Maker — Video Production & Editing Platform.
- Estado: PLANIFICADO / pendiente de captura real del editor y muestra final validada. No enviado al motor local ni renderizado desde esta actualización documental.
- Destino: portafolio Upwork de Katherine Stehberg; revisión antes de publicar.
- Formato: horizontal 16:9, 1920×1080; duración objetivo 60–90 segundos; narración en inglés y subtítulos completos.
- Objetivo: mostrar el trabajo de Katherine en gestión de proyecto y desarrollo full-stack mediante una demostración verificable.
- Orden: añadir después de los trabajos ya pendientes; no interrumpir ni reordenar los cursos.

### Secuencia de producción

1. Presentación breve del problema: organizar la producción de videos educativos y promocionales.
2. Captura real de un proyecto: escenas, guion y recursos visuales.
3. Demostración real de edición: subtítulos, texto destacado, pistas de audio y guardado.
4. Exportación MP4 y reproducción de una muestra terminada.
5. Cierre: Katherine Stehberg — Project Manager & Full-Stack Developer.

### Narración propuesta

AI Video Maker is a project I am developing to support educational and promotional video production. My role combines project management with hands-on full-stack development. I define requirements, prioritize features, and coordinate implementation and testing. In this demonstration, you can see how a project brings together scenes, narration, visuals, subtitles, and editing controls. The workflow supports saving changes and exporting an MP4 for review. This project is still in development, with ongoing usability testing and workflow improvements. It reflects how I connect business needs, clear communication, and practical technology implementation.

### Material y revisión

Usar grabaciones auténticas del editor y un MP4 propio cuya reproducción, audio y subtítulos estén revisados. Capturar la exportación únicamente si funciona en la versión instalada. No sustituir la demostración del producto por pantallas ficticias ni prometer funciones pendientes. Ocultar correos, claves, rutas personales y datos de clientes. Utilizar recursos con permisos de exhibición. Verificar que la narración coincida con las funciones realmente mostradas. Revisión final de Katherine antes de publicación. Este registro amplía la planificación; no cambia el paquete automático de 15 guiones de cursos ni el estado local de ejecución.
