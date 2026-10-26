# Edicion de cursos sin render previo

## Problema
La lista solo ofrecia acciones cuando la cola habia completado y verificado un MP4. Con COURSE_PRODUCTION_ENABLED=0 no avanzaba ningun curso y tampoco se ejecutaba preflight; environment permanecia null y la interfaz mostraba "Comprobando entorno..." indefinidamente.

## Cambio
- POST local /api/course-production/projects/:courseId prepara un borrador mediante makeProject, makeScene y saveProject, sin llamar al pipeline ni a la cola.
- Primero busca el proyecto asociado, su identidad de curso o un proyecto con el mismo titulo y guion. Reutiliza proyectos sin escribirlos. Ante asociacion rota, ambiguedad o colision de identificador, falla sin sobrescribir.
- Conserva guion completo, escenas y trazabilidad de las fuentes. Los recursos y audios faltantes permanecen vacios. No se generan imagenes, voces, subtitulos en disco ni MP4.
- "Editar proyecto" funciona antes del render. "Ver video" exige estado review_ready, verificacion previa, archivo local existente no vacio y revision exportada vigente. Preparar un borrador no cambia el estado pending ni concede aprobacion de revision.
- GET comprueba el entorno de forma independiente, con cache de 15 segundos; muestra cola pausada/activa y limitaciones o errores por separado. Nunca llama a tick.
- Las escrituras exigen acceso local, cabecera x-course-request y origen de la aplicacion.

## Resultado local
Servidor en http://127.0.0.1:4321, iniciado con COURSE_PRODUCTION_ENABLED=0.
Solo RPM-2026-001 tiene un proyecto local: vid_course_RPM-2026-001, seis escenas con texto identico al paquete preparado. URL: http://127.0.0.1:4321/project-editor.html?id=vid_course_RPM-2026-001.
Los 15 cursos permanecen pending; los otros 14 no tienen proyectos creados. Ninguno tiene MP4 ni enlace de video. El entorno reconoce la voz inglesa SAPI y no presenta errores de inicio.

## Validacion
- node --test --test-concurrency=1 tests/course-editing.test.js tests/course-production.test.js tests/course-production-contract.test.js tests/course-production-http.test.js: 11 pruebas aprobadas. La cola usa un backend simulado; no renderiza.
- node scripts/course-editing-smoke.mjs: Chrome comprueba el curso real y su guion completo. En un servidor y almacen separados bajo .tmp prueba narracion, duracion, estilo de subtitulos y busqueda de recursos; guarda, recarga y verifica persistencia. Sin errores JavaScript.
- El proyecto real no recibe ediciones de prueba. No hay recursos visuales disponibles que asignar: se comprueba la interfaz de subida y se conserva assetPath vacio; no se inventan medios ni atribuciones.
- El script de navegador requiere playwright-core instalado exclusivamente en .tmp/browser-tools y Chrome; no modifica package.json ni package-lock.json. En este equipo npm requirio NODE_USE_SYSTEM_CA=1 para confiar en los certificados del sistema.
- Solo se incluyen codigo, pruebas y documentacion. data/projects, estados, capturas, dependencias de navegador y medios quedan excluidos de Git.

## Uso y pendientes
Abrir la lista y elegir "Editar proyecto". Guardar los cambios con el boton del editor; no es necesario exportar. Incorporar recursos autorizados cuando esten disponibles. No se ha producido ni aprobado ningun video. Mantener la cola pausada mientras se edita; activar produccion sigue siendo una accion separada y no forma parte de esta tarea.
