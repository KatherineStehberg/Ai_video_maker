# Instalación Windows para Joseph Vargas

Preparación verificada el 13 de octubre de 2026. Repositorio original:
https://github.com/KatherineStehberg/Ai_video_maker
Rama de trabajo: `feat/personal-video-studio`. No usar `main` para esta entrega.

## Requisitos comprobados

- Windows x64. Pruebas realizadas en Windows 10, build 19045.
- Node.js **22.21.1**, npm **10.9.4**. `package.json` admite Node >=18.17,
  pero las pruebas de navegador requieren Node >=20; usa Node 22 para reproducir esta entrega.
- Git y Visual Studio Code con terminal PowerShell.
- FFmpeg **6.1.1** (`ffmpeg-static` 5.3.0) y ffprobe **4.0.2**
  (`ffprobe-static` 3.1.0), comprobados con exportación H.264/AAC.
- Voz local SAPI de Windows o Piper. Aquí se comprobaron Microsoft Helena
  Desktop (es-ES), Sabina Desktop (es-MX) y Zira Desktop (en-US).
- Se probó con 8 GB de RAM y CPU de 4 hilos; usar perfil `fast` y espacio libre
  suficiente para originales, cachés y exportaciones. Los cursos largos tardan.

## Clonar, configurar y abrir

Joseph debe tener acceso al repositorio original; autenticar GitHub cuando Git lo solicite.
Ejecutar en PowerShell desde una carpeta de trabajo:

```powershell
git clone --branch feat/personal-video-studio --single-branch https://github.com/KatherineStehberg/Ai_video_maker.git
Set-Location Ai_video_maker
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
code .
npm.cmd run doctor
npm.cmd test
npm.cmd start
```

Abrir **http://127.0.0.1:4321/editor.html** para creación/análisis y
**http://127.0.0.1:4321/** para el estudio. Desde proyectos recientes, pulsar
Editar para entrar en `/project-editor.html?id=<id>`. El servidor debe seguir
abierto en la terminal; Ctrl+C lo detiene. No hay compilación frontend ni
scripts de lint/build definidos: se sirven HTML, CSS y módulos JavaScript.

Si `code` no está en PATH, abrir VS Code desde Inicio y usar Archivo > Abrir carpeta.
Para sesiones posteriores basta `Set-Location` a la carpeta y `npm.cmd start`.
Actualizar con `git pull --ff-only` en esta rama, y después `npm.cmd ci`.
Guardar o confirmar cambios propios antes de actualizar; si Git informa divergencia,
no forzar ni borrar trabajo.

Clonar el original es la opción preferida. Un fork solo sirve como alternativa
si Joseph necesita publicar desde su cuenta y tiene permiso para bifurcar el
repositorio: crear el fork en GitHub y sustituir la URL del clone por su URL real.
Un fork no concede acceso a un repositorio privado al que no tenga permiso.

## FFmpeg y configuración local

`npm.cmd ci` instala las dependencias opcionales y descarga sus binarios; necesita
red durante la instalación. `npm.cmd run doctor` muestra las rutas efectivas.
Si faltan, instalar FFmpeg para Windows desde una distribución confiable y colocar
ambos ejecutables, por ejemplo, en `C:\ffmpeg\bin`. Configurar en `.env` solo
rutas que existan:

```dotenv
HOST=127.0.0.1
PORT=4321
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe
TTS_PROVIDER=sapi
LLM_PROVIDER=none
IMAGE_PROVIDER=local
SUBTITLE_PROVIDER=estimated
VIDEO_GEN_PROVIDER=pipeline
RENDER_PROFILE=fast
```

Si funcionan los binarios npm, dejar comentadas `FFMPEG_PATH` y `FFPROBE_PATH`.
Comprobar los ejecutables personalizados con `& 'C:\ffmpeg\bin\ffmpeg.exe' -version`
y su equivalente ffprobe. Una ruta inválida produce aviso y el programa intenta
los binarios alternativos; corregir la ruta en lugar de depender del aviso.
Reiniciar el servidor después de editar `.env`. Nunca subir ese archivo ni claves.

## Qué funciona sin claves

El guion manual, fondos gráficos locales, imágenes y clips propios, montaje,
voz SAPI instalada, subtítulos estimados, rótulos, mezcla y exportación MP4 no
necesitan APIs. La voz se debe seleccionar y activar: un proyecto del estudio
se crea con narración desactivada. Verificar que voz y ganancia no estén en cero.
Las pistas de música y efectos requieren archivos locales y sus fichas de licencia.
Se pueden generar recursos de inicio sin red:

```powershell
node scripts/generar-musica-local.mjs
node scripts/generar-sfx-local.mjs
```

`pipeline` monta el guion con visuales y voz; **no es un modelo de video generativo**.
`mock` genera material sintético de prueba. Los proveedores de video generativo
`api` y `local` están declarados pero **no implementados**; añadir una clave no
los habilita. Los clips de video propios sí se conservan en movimiento al exportar.

Opcionales, documentados en `.env.example`:

- Pexels: `PEXELS_API_KEY`, para buscar imágenes. Requiere red y cuenta.
- Gemini: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_VIDEO_FPS`, para análisis
  semántico opcional; requiere consentimiento y puede generar cargos. El modelo
  debe estar habilitado en la cuenta; no se validó una llamada real en esta entrega.
- LLM: `LLM_PROVIDER=ollama` con `OLLAMA_URL`/`OLLAMA_MODEL`, o
  `openai-compatible` con `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`.
  Disponibilidad/configuración del doctor no demuestra una llamada exitosa.
- Piper: `PIPER_PATH` y `PIPER_MODEL`; copiar/instalar binario y modelo aparte.
- Whisper: `SUBTITLE_PROVIDER=whisper`, `WHISPER_BIN`, `WHISPER_MODEL`;
  requiere ejecutable/modelo aparte. El modo `estimated` no transcribe audio.

No copiar claves desde otro equipo: configurar las autorizadas para Joseph.
Los ejemplos de rutas y nombres de proveedores no son credenciales.

## Trasladar videos y cursos existentes

Git transporta código, documentación y guiones de `content/courses/`, pero no
los proyectos ni medios. Con ambos servidores detenidos, hacer una copia de
respaldo y transferir por disco externo o canal privado, conservando estructura:

- `data/projects/`: JSON con escenas y edición.
- `data/assets/`: imágenes, clips, música, efectos, fuentes, marcas y fichas JSON
  de licencia. Copiar también originales externos referenciados por los proyectos.
- `output/`: `drafts/` conserva voz, subtítulos y clips; `final/` conserva renders.
  Copiar ambos para continuar y reutilizar trabajo existente.
- `data/course-production/`: estado de cola y comprobaciones de los cursos.
- `data/video-generation/`, `data/jobs/`, `data/analyses/`, `data/video-edits/`
  y `data/studio-imports/` si existe: trabajos, originales importados y análisis.
- Marcas personalizadas en `data/brands/` y modelos locales en `models/` u otras
  carpetas indicadas por Piper/Whisper, si se utilizan.

No copiar `node_modules`, `.tmp`, logs o archivos de procesos. Recrear `.env`.
No mezclar una cola activa entre dos equipos. No sobrescribir proyectos que
Joseph ya haya editado: respaldar y comparar primero. Las rutas relativas al
repositorio se conservan; las rutas absolutas al equipo anterior deben corregirse
o volver a vincularse desde Recursos. Revisar también rutas de salida en el
estado de la cola antes de reanudar. Transferir permisos/licencias de los medios.

## Comprobación y problemas habituales

Crear un proyecto corto independiente, seleccionar voz, añadir un visual,
activar subtítulos, guardar, volver a abrir y exportar. Reproducir el MP4 con
sonido. Para una comprobación automatizada de edición y exportación con voz:

```powershell
$env:AIVM_PROJECTS_DIR="$PWD/.tmp/joseph-check/projects"
$env:AIVM_OUTPUT_DIR="$PWD/.tmp/joseph-check/output"
$env:AIVM_JOBS_DIR="$PWD/.tmp/joseph-check/jobs"
$env:COURSE_PRODUCTION_ENABLED='0'
node scripts/editor-export-smoke.mjs
node scripts/motion-smoke.mjs
```

Cerrar esa terminal al terminar: las variables anteriores son solo para pruebas.
Abrir otra terminal sin ellas para trabajar con los proyectos reales.

- PowerShell bloquea `npm.ps1`: usar `npm.cmd`; no hace falta cambiar la política global.
- `npm ci` falla por red: revisar conexión/proxy y repetir. Si omitió paquetes
  opcionales, configurar los binarios manuales y repetir doctor antes de exportar.
- Sin voces: instalar voces de escritorio compatibles con System.Speech en
  Configuración de Windows > Hora e idioma > Voz. Comprobar doctor; los cursos
  en inglés requieren una voz inglesa. Piper es la alternativa local.
- MP4 sin voz: activar narración, elegir voz disponible y revisar ganancia,
  mute y volumen del reproductor. `none` produce un video sin narración.
- Puerto ocupado: cerrar la instancia anterior o cambiar `PORT=4322` y usar esa URL.
- Recursos ausentes después de clonar: copiar las carpetas anteriores y revisar
  rutas absolutas; Git no descarga medios ni modelos.
- Render lento: usar `fast`, empezar con pocos segundos y dejar espacio en disco.
  No cerrar el servidor mientras exporta. No lanzar toda la cola como prueba.

El diagnóstico existente es `npm.cmd run doctor`; no instala software ni cambia
configuraciones globales. `npm.cmd run courses:check` inspecciona guiones y estado
sin producir cursos. Consultar el informe de esta entrega para resultados y límites.
