# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Las fechas son de desarrollo local; nada de esto se ha publicado todavía.

## [Sin publicar] — rama `feat/personal-video-studio`

### Añadido — Biblioteca de imágenes y música en el editor (2026-09-22)

Los recursos se eligen desde el editor, sin tener que subir un archivo cada vez.

#### Imágenes gratuitas (Pexels)

- Herramienta **Recursos**: buscador por tema, resultados en tarjetas con
  miniatura y autor, vista previa antes de elegir, y botones para reemplazar la
  imagen o mantener la actual. Estado de carga y mensajes claros cuando no hay
  resultados o no hay conexión.
- **La clave nunca sale del backend.** El navegador manda un término de
  búsqueda o un identificador; nunca una URL de descarga. El servidor vuelve a
  pedir la foto a Pexels por su id, comprueba que el archivo venga de
  `images.pexels.com` y sólo entonces lo descarga.
- Cada imagen se **cachea en local** (`data/assets/images/_library/pexels/`)
  con una ficha al lado que guarda proveedor, id remoto, URL de descarga,
  autor, URL de atribución, licencia, fecha y término buscado. El video sigue
  funcionando sin conexión.
- La **atribución** se muestra en el panel y se guarda con la escena. El crédito
  se lee siempre de la ficha en disco, nunca de lo que mande el navegador.
- Sin `PEXELS_API_KEY` la interfaz dice que la biblioteca remota no está
  disponible y deja a mano los archivos propios y los fondos locales.
- La búsqueda viaja con el **idioma del proyecto** (`locale`). Sin él, Pexels
  leía las consultas como inglés: «naturaleza espiritual» devolvía una obra en
  construcción en Espíritu Santo.

#### Música

- Herramienta **Audio**: biblioteca local con buscador por ambiente, estilo o
  duración; tarjetas con nombre, duración, formato, tamaño, género, licencia y
  fuente; vista previa con reproductor; volumen, silenciar y quitar.
- **Sólo se ofrece música con licencia declarada.** Cada pista necesita su ficha
  `<archivo>.json` con licencia y fuente; sin ella no aparece y no se puede
  usar, ni siquiera indicando la ruta a mano.
- `scripts/generar-musica-local.mjs` crea cuatro pistas ambientales **generadas
  con FFmpeg a partir de tonos sintéticos**, sin samples ni obras de terceros,
  publicadas como CC0. Para música mejor, basta con añadir archivos propios con
  su ficha.
- Estructura preparada para un proveedor remoto (contrato documentado en
  `media-library.js`). **No hay ninguno conectado**: no se descarga música de
  servicios externos sin verificar su licencia.
- La pista de música aparece en la línea de tiempo con su **forma de onda real**
  y se marca cuando está silenciada.

#### Corregido de paso

- **Los deslizadores con decimales mostraban un valor falso.** `entrada()`
  asignaba `value` antes que `min`, `max` y `step`, así que un volumen de 0,3 se
  dibujaba en 0 y un contorno de 1,15 en 1. Afectaba a música, voz y subtítulos.
- **Una escena excluida ocupaba tiempo en la línea de tiempo** aunque el render
  la saltaba, y desplazaba la vista previa y el audio respecto al MP4.
- Con música ya son seis pistas: se ajustó su altura para que quepan todas en
  1366×768 sin cortar la última.

### Añadido — Editor visual de proyectos (2026-09-21)

Pantalla nueva para editar un video escena a escena, sin tocar JSON. Se abre
sólo desde «Editar» en un proyecto guardado: **la pantalla de inicio no cambia**.

`/project-editor.html?id=<idProyecto>`

- **Distribución**: barra superior, ocho herramientas en columna, panel
  contextual, vista previa central con controles de reproducción y línea de
  tiempo multipista fija abajo. Cabe entera en 1366×768 sin scroll de página.
- **Herramientas**: Escenas, Guion, Texto destacado, Recursos, Transiciones,
  Audio, Subtítulos y Marca. Cada una abre su propio panel; nunca se muestran
  todos los formularios a la vez.
- **Línea de tiempo** con pistas de texto destacado, subtítulos, narración,
  visual, música y cortes. Cada pista aparece sólo si tiene contenido real.
  Regla, cabezal, zoom, scroll y selección de clips. **No hay arrastre**:
  mover un clip todavía no se puede guardar, así que no se ofrece.
- **Forma de onda real** (`src/project-editor/waveform.js`): FFmpeg decodifica
  el audio a PCM y se reduce a picos. Media hora de narración da 600 picos en
  ~5 s. Sin archivo de audio se dibuja un bloque rayado y se dice que no hay
  onda; nunca se inventa una.
- **Vista previa** que compone imagen, rótulo, subtítulo y zonas seguras con la
  métrica del backend. Se etiqueta como «aproximada»; cuando existe un MP4 al
  día se puede ver el definitivo.
- **Guardado explícito** con estado «Guardado» / «Cambios sin guardar», aviso
  antes de cerrar, deshacer y rehacer, y control de revisión que rechaza
  guardar si el proyecto cambió en otra pestaña. Editar invalida la aprobación
  del guion y marca el MP4 anterior como no vigente.
- **API nueva** `/api/project-editor/*`, en su propio espacio de nombres. Los
  endpoints de `/api/studio`, `/api/analysis`, `/api/video-edits` y
  `/api/video-generation` siguen intactos.
- **Capa de almacenamiento** (`src/project-editor/storage.js`): interfaz de
  cinco métodos sobre los JSON de `data/projects/`. Sustituirla por Supabase
  más adelante no obliga a tocar el editor. **No se ha conectado Supabase.**

#### Corregido de paso

- **`excluida` no hacía nada.** El campo existía pero el render, los subtítulos
  y la pista de voz seguían incluyendo la escena. Ahora `activeScenes()` es el
  único criterio y lo respetan los tres.
- **El volumen de la narración no se aplicaba.** El montaje fijaba `volume=1.0`.
  Se añade `voice.gain`, que es ganancia de mezcla: cambia el volumen sin tener
  que regenerar la voz.
- **`assetProvider` se perdía al recargar.** `makeScene()` no lo conservaba, así
  que tras reabrir no se podía distinguir una imagen del tema de un fondo de
  marca de relleno.

#### No incluido, y declarado como tal en la interfaz

Publicar en redes, arrastrar clips, dividir, duplicar y reordenar escenas, pista
de efectos de sonido y transiciones de deslizamiento o barrido (el render sólo
distingue «sin transición» y «fundido»).

### Corregido y añadido — Subtítulos y texto destacado (2026-09-21)

Dos cosas que se confundían entre sí quedan separadas: el **subtítulo**, que
lleva toda la narración en todas las escenas, y el **texto destacado**, que es
un rótulo corto en unas pocas.

#### Subtitulado completo

- **Corregido: el final de una escena podía quedarse sin subtítulo.**
  `cuesForScene()` forzaba un mínimo de 0,7 s por cue; en una escena corta con
  mucho texto esos mínimos sumaban más que la escena y los últimos cues se
  recortaban contra el final hasta durar cero. Ahora el reparto se calcula sobre
  el peso **acumulado**, así que los cues son contiguos, ninguno dura cero y el
  último cierra exactamente al final de la escena.
- `verifyCaptionCoverage()`: comprueba **escena por escena** que nada narrado se
  queda sin subtítulo, y devuelve la cobertura real.
- Un `caption` vacío o en blanco ya no silencia el subtítulo: manda la
  narración. Para quitar los subtítulos hay que apagarlos en el proyecto.
- **Corregido: la casilla «Subtítulos quemados» del editor no hacía nada.**
  `leerFormulario()` nunca la leía, así que el video salía subtitulado aunque se
  desactivara. Ahora viaja en la petición.

#### Subtítulos más grandes y configurables

- `src/core/captions-style.js` (nuevo): toda la geometría y el estilo en un solo
  sitio. Tamaño por formato interpolando entre dos anclas medidas:
  **9:16 → 64 px**, **16:9 → 48 px**, **1:1 → 58 px**, **4:5 → 61 px**.
  Antes salía `alto / 34`: 32 px en 16:9, menos de la mitad de lo legible.
- **Zonas seguras** por formato (18 % inferior en 9:16): el subtítulo ya no cae
  bajo los controles de TikTok ni de Instagram. Ancho máximo 85 %, dos líneas
  como mucho, corte por palabras.
- **Controles globales**: tamaño, tipografía, color, fondo, opacidad, contorno,
  posición y alineación, en el Estudio y en el editor.
- **Presets**: Redes sociales, Curso, Limpio y Alto contraste. Son
  multiplicadores, así que siguen adaptándose a cada formato.
- El `.ass` se genera con `PlayRes` = tamaño real del video y traduce posición y
  alineación a los valores de ASS; con fondo de caja usa `BorderStyle 3`.

#### Texto destacado sobre algunas imágenes

- `src/core/on-screen-text.js` (nuevo) y cinco campos por escena:
  `showOnScreenText`, `onScreenTitle`, `onScreenPosition`, `onScreenStyle` y
  `onScreenAnimation`. Los proyectos guardados antes de esto se reabren igual
  que se veían.
- **Corregido: el rótulo salía en TODAS las escenas.** El Estudio escribía
  «1. Título», «2. Título»… sobre cada imagen, y el generador titulaba cada
  escena con su propia narración, duplicando el guion sobre el video. Ahora se
  **propone** sólo en portada, aperturas de sección, datos con cifras y cierre,
  con un tope del 35 % de las escenas y nunca dos seguidas.
- **Corregido: trozos de diálogo se colaban como rótulos.** Un guion narrativo
  producía rótulos como «-Por ejemplo», «Me dijo» o «-Isan, entiendo que tenías
  el don de ver enfermedades, pero». `esRotuloValido()` descarta diálogos,
  verbos de habla, frases cortadas a mitad y cualquier título que haya habido
  que recortar: un titular de verdad ya es corto.
- Máximo 8 palabras, y el rótulo nunca copia la narración.
- El rótulo se coloca **fuera de la banda de subtítulos**: los dos conviven en
  la misma escena sin pisarse, en los cuatro formatos.
- Animaciones de entrada: `fade`, `slide-up`, `pop` y `none`.
- En cada tarjeta de escena: **«Agregar texto destacado sobre la imagen»**, con
  texto, posición, tamaño, color, fondo, animación y **vista previa**.
  Desactivarlo deja la escena con imagen, voz y subtítulos, y **no borra** el
  texto escrito.

#### Pruebas

- `tests/captions.test.js` (nuevo, 32 pruebas): tamaños por formato, zonas
  seguras, subtitulado completo, escenas con y sin rótulo, convivencia sin
  solape y persistencia al guardar y reabrir.
- `scripts/captions-smoke.mjs` (nuevo): navegador real, las dos interfaces.

### Añadido — Videos largos por el mismo flujo (2026-09-20)

Un reel de 15 segundos y una clase de 12 minutos usan ahora **la misma pantalla,
el mismo flujo y las mismas funciones**. No hay un botón de «corto» y otro de
«largo»: lo único que cambia es si mandas una idea o un guion ya escrito.

- **Guion propio (`script`)**: nueva entrada, hasta **400 000 caracteres**
  (~65 000 palabras). Manda sobre el prompt y **no se reescribe, no se resume y
  no se recorta**: sólo se trocea en escenas.
- `src/generation/segmenter.js`: segmentación por **título → párrafo → oración**,
  y nunca dentro de una oración. Una frase que no cabe ocupa su propia escena y
  se declara en `advertencias`. `sinPerdidaDeTexto()` verifica que ninguna
  palabra del guion desaparece.
- **Duración derivada del contenido**: `(palabras ÷ wpm) × 60 + escenas × 0.35 s`.
  La velocidad de narración es configurable con `NARRATION_WPM` o desde el
  editor. La duración objetivo es **opcional**; «Automática según el guion» es
  el valor por defecto.
- `POST /api/video-generation/plan`: estimación pura (palabras, escenas,
  duración) **sin producir nada**, con el mismo segmentador que la producción.
  La interfaz la muestra mientras se escribe.
- **Objetivo incompatible ⇒ aviso, no recorte.** Si el guion no cabe en la
  duración pedida se avisa y se produce el guion completo.
- `src/generation/states.js`: estados `preparando-guion`, `creando-escenas`,
  `buscando-visuales`, `generando-voz`, `creando-subtitulos`,
  `renderizando-segmentos`, `concatenando`, `listo`, `error-recuperable`. El
  porcentaje se **cuenta** en escenas terminadas; no se simula avance.
- `POST /api/video-generation/jobs/:id/resume`: reanuda un proyecto
  interrumpido reutilizando los WAV y los clips ya producidos.
- `POST /api/video-generation/jobs/:id/scenes/:n`: regenera **una sola escena**;
  las demás se reutilizan por huella. Medido sobre 105 escenas: 675 s frente a
  1 843 s del flujo completo, con 104 de 104 escenas conservadas.
- `src/generation/orchestrator-contract.js`: contrato de entrada del
  **Orquestador KSL**, con `POST /api/video-generation/orchestrator` y modo
  `dryRun`. Acepta `projectId`, `brandId`, `title`, `prompt`, `script`,
  `sourceReference`, `format`, `targetDurationSeconds`, `platform`, `style`,
  `voice`, `music`, `subtitles`, `logo` y metadatos de curso. **El repositorio
  del Orquestador no se ha tocado**, `sourceReference` no se resuelve y no se
  conecta con Drive ni se guarda ninguna credencial.
- **Marca por proyecto**: `brandId` y `logo` (`path`, `position`, `scale`,
  `opacity`) viajan con la petición. Ningún logo concreto está incrustado en el
  código y `data/brands/personal.json` se conserva.
- `scripts/long-form-smoke.mjs`: prueba reproducible con guion de 2 500+
  palabras. Informa palabras, escenas, duración estimada, duración **real**
  medida con ffprobe, estado, pico de memoria, reanudabilidad e integridad del
  guion, y **calibra** la velocidad real de la voz local.
- `tests/long-form.test.js`: 22 pruebas nuevas. Toda la suite pasa en **Node 18
  y Node 22** (79 pruebas).

**Verificado de punta a punta** (`node scripts/long-form-smoke.mjs --full`): un
guion de 15 706 caracteres y 2 667 palabras narradas produjo 105 escenas y un
MP4 de 46,4 MB con **998,97 s (16 min 39 s) medidos con ffprobe**, con audio y
subtítulos, conservando las 2 667 palabras. Pico de RSS **60 MB**.

### Cambiado — Límites

Los topes que bloqueaban un guion largo eran **seis**, no uno. Ninguno recorta ya
texto en silencio: cuando algo no cabe, la petición se rechaza entera con un
mensaje que dice el número exacto.

| Límite | Antes | Ahora |
|---|---|---|
| `PROMPT_MAX` | 2 000 car. | 20 000 |
| `maxlength` del prompt en el HTML | 2 000 (truncaba al pegar) | sin tope |
| Guion completo | *no existía* | 400 000 car. |
| Escenas por proyecto | 20 | 600 |
| Texto por escena | 600 car., **recortado con `.slice()`** | 2 000, se rechaza |
| Duración por escena | 0,5–30 s | 0,5–120 s |
| Duración objetivo | 3–900 s | 3–7 200 s |
| Cuerpo HTTP de generación | 256 KB | 8 MB |

- La duración por defecto de `normalizeSpec` pasa de **15 s fijos** a
  **automática**: la marca el guion. La interfaz siempre envía una explícita.
- `elegirTemplate` tiene en cuenta la extensión del guion: una clase elige
  `video-curso` (escenas largas, sin efectos), no un template de reel.
- `GET /api/video-generation/config` publica los límites técnicos reales, los
  estados y la velocidad de narración, para que la interfaz no se los invente.

### Corregido

- `runPipeline` no propagaba `index` ni `total` de las etapas de visuales, voz y
  render, así que el contador de escenas de la interfaz se quedaba en `0/N`.
  Ahora el progreso mostrado es el realmente contado.
- Al conservar el paso que informa el renderer se coló su `done`, que el renderer
  emite **al terminar cada formato** y que `STEP_TO_STATUS` de `core/jobs.js`
  traduce a `COMPLETED`: un proyecto multiformato se habría marcado terminado
  tras el primer formato, con los demás y los metadatos aún pendientes, y un
  reinicio en esa ventana habría escapado al rescate de `restoreJobs()`. Se
  aísla en `pasoDeRender()`, con prueba de regresión.
- El progreso podía retroceder al final del montaje (`concatenando` →
  `renderizando-segmentos`, y el contador de una etapa que arranca volviendo a
  cero). Cada etapa guarda ahora su marca más alta: el porcentaje nunca baja y
  nunca se afirman más escenas de las contadas. Hay una prueba que lo verifica
  sobre un render real.
- El README afirmaba que «hoy sólo está implementado el proveedor mock». Es
  falso desde que `pipeline` es el predeterminado; corregido.

### Añadido — Prompt a video real (2026-09-19)

- **Proveedor `pipeline`, ahora el predeterminado**: encadena los módulos que ya
  existían (script-generator, scene-planner, providers/image, providers/tts,
  subtitles, renderer, FFmpeg) para producir un video cuyo contenido
  corresponde al prompt: texto en pantalla, narración con voz local y
  subtítulos sincronizados. Coste cero y sin salir del equipo.
- `src/generation/script.js`: redacción del guion. Usa el LLM configurado si lo
  hay; si no, una **plantilla local** que compone frases a partir de los beats
  del template e inserta el tema extraído del prompt. Se declara como
  `plantilla-local`, nunca como redacción de IA.
- `POST /api/video-generation/draft`: guion y escenas **antes** de producir,
  con desglose de coste por pieza. No renderiza nada.
- Interfaz: tarjetas de escena editables (narración, texto en pantalla,
  instrucción visual, duración), botones «Generar borrador», «Regenerar
  escena» y «Crear video», y el coste estimado a la vista. «Crear video» está
  bloqueado hasta que haya un borrador revisado.
- El mock queda como fallback de desarrollo y ya no es el predeterminado.

### Corregido

- El título en pantalla usaba un tamaño de fuente fijo (`W/16`) y los títulos
  largos se salían del encuadre por ambos lados. Ahora el tamaño se adapta al
  largo del texto.
- El título aparecía **dos veces**: el renderer lo dibujaba arriba y el fondo
  generado lo repetía en el centro. El fondo se deja limpio cuando la escena ya
  tiene título.

### Añadido — Generación de video con IA (2026-09-18)

- **Segundo flujo principal**: pantalla inicial con dos opciones, «Crear video
  con un prompt» y «Editar un video existente». El flujo de subida existente no
  cambia.
- `POST /api/video-generation/jobs` y `GET /api/video-generation/jobs/:id`, con
  estados `queued → generating → generated → analyzing → editing → completed`
  (o `failed`). Al completarse deja hechos el análisis y la propuesta de edición,
  reutilizando los módulos existentes en lugar de duplicarlos.
- `src/providers/video-generation/`: registro de proveedores desacoplado.
  **Sólo el proveedor `mock` funciona**: genera un video de prueba con FFmpeg,
  sin IA, sin coste y sin contactar ningún servicio. Las ranuras `api` y `local`
  están declaradas pero no implementadas y fallan con un mensaje accionable.
  El contrato para añadir un proveedor real está documentado en el propio módulo.
- `analyzeExistingFile()` en `src/analysis/routes.js`: permite analizar un
  archivo ya en disco reutilizando exactamente el mismo `execute` que la subida.
- Interfaz: formulario de prompt (duración, formato, estilo y campos opcionales
  de música, público y plataforma), tarjeta con el prompt usado y sus
  parámetros, y el aviso de que el material es de prueba siempre visible.
- `scripts/generation-smoke.mjs`: smoke de navegador del flujo completo
  prompt → generación → análisis → edición → aprobación → exportación.

### Corregido

- El proveedor mock producía planos de colores demasiado parecidos (la paleta
  corporativa es monocroma) y el detector de escenas no encontraba **ningún
  corte**, con lo que el material de prueba no servía para probar nada. Ahora
  alterna luminancia entre planos consecutivos; hay un test que lo verifica.
- Editar un solo trozo marcaba **todos** como «Ajustado por ti» y desplazaba
  sus duraciones: el input muestra dos decimales y reenviaba ese valor
  redondeado. Ahora se conserva la velocidad exacta cuando no se ha tocado.
- Advertencia de mock duplicada en la interfaz (la emitían el proveedor y el
  trabajo); ahora se emite una sola vez.

### Cambiado — Rediseño del editor y segmentos editables (2026-09-18)

- **Rediseño visual completo** del editor, pensado para uso no técnico:
  indicador de 5 pasos en la cabecera, tarjetas numeradas, botones grandes
  diferenciados por color, tarjeta de resumen con las cifras en lenguaje llano
  y descargas agrupadas. La jerga (puntuaciones, fuerza vectorial, frames) se
  movió a un bloque «Detalle técnico» plegado.
- **Panel de segmentos editable**: quitar trozos del montaje y cambiar su
  velocidad. Requiere el endpoint nuevo `PATCH /api/video-edits/:id`, que
  recalcula la línea de salida y **siempre invalida la aprobación** y descarta
  el informe de exportación anterior.
- **CSS reorganizado para edición manual**: todas las variables de color,
  tipografía, espacios y dimensiones agrupadas en `:root`, con nombres en
  español y comentarios que indican dónde tocar cada cosa. `--player-height`
  controla el alto del reproductor; `--panel-ancho`, el panel lateral.
- HTML dividido en secciones marcadas (`[CABECERA]`, `[PANEL]`, `[TIMELINE]`,
  `[SEGMENTOS]`…) con comentarios de edición para logo, textos y botones.
- Responsive ajustado a 1366 px, el ancho de escritorio objetivo.
- `src/ui/editor/segments.js`: módulo de vista del panel editable, con
  `validateSelection` y `hasChanges` testeables sin navegador.

### Corregido

- El panel de segmentos mostraba «Deja al menos un trozo incluido» nada más
  aparecer, porque inicializaba los botones con una selección vacía en vez de
  leer la real. El smoke test ahora falla si vuelve a ocurrir.

### Añadido — Editor web (2026-09-18)

- **Frontend del editor** en `/editor.html`, que cubre el flujo completo desde
  el navegador sin `curl` ni scripts. Fondo claro, azul `#003366`, azul
  eléctrico para acciones, tarjetas redondeadas, panel lateral de configuración
  y timeline central. Responsive verificado a 420 px, sin scroll horizontal.
- **Arquitectura modular sin dependencias** en `src/ui/editor/`:
  `api.js` (cliente con `fetch` inyectable), `state.js` (máquina de estados
  pura), `format.js` (derivaciones de la vista), `timeline.js`, `player.js`,
  `messages.js` y `main.js` (orquestación). Los tres primeros no tocan el DOM y
  se testean en Node.
- **Diez estados visibles** (listo, cargando, analizando, análisis completado,
  creando propuesta, aprobación pendiente, aprobado, exportando, exportado,
  error) con una única regla de habilitación de la exportación y el motivo del
  bloqueo siempre a la vista.
- **Sondeo del análisis** sin solapar peticiones, cancelable al cambiar de
  archivo, y bloqueo del botón durante la exportación para impedir dos
  exportaciones simultáneas.
- **Advertencias de sincronía visibles**: el aviso de `atempo` se muestra tal
  cual lo envía el backend; la interfaz nunca afirma que los beats originales se
  conserven.
- `scripts/editor-smoke.mjs`: smoke test del flujo completo en Chrome real.
- `tests/ui.test.js`: 7 tests que cubren los 14 casos pedidos.
- `DEPLOY.md`: configuración preparada y bloqueadores reales para el deploy.

### Corregido

- `video { display: block }` anulaba el atributo `hidden` de los reproductores,
  que aparecían como cajas negras vacías. Restablecido con `[hidden]`.
- La página pedía `/favicon.ico` y recibía un 404; ahora lleva un favicon SVG
  embebido. El smoke test falla si aparece cualquier respuesta HTTP ≥ 400.
- Concordancia de plural en el mensaje de sincronía («Sólo 1 corte visual»).

### Añadido — Propuesta de edición y exportación (2026-09-18)

- **Módulo de edición** (`src/edits/`), independiente del análisis:
  - `schema.js`: esquema de la propuesta, contrato documentado de transformación
    temporal y validación de segmentos (orden, solapamiento, límites de `atempo`,
    coherencia `speed = 1/setptsFactor`, contigüidad de la línea de salida).
  - `plan.js`: construye la propuesta a partir de un análisis ya medido. No
    ejecuta FFmpeg ni contacta servicios externos.
  - `export.js`: exportación real con FFmpeg (`trim`/`setpts` + `atrim`/`atempo`,
    `concat`, encuadre y CFR), con verificación posterior por `ffprobe`.
  - `routes.js`: `POST /api/video-edits`, `GET /api/video-edits/:id`,
    `POST /api/video-edits/:id/approve`, `POST /api/video-edits/:id/export`,
    `GET /api/video-edits/:id/file`.
- **Aprobación humana obligatoria** antes de exportar cuando `approvalRequired`
  es `true`; `403` en caso contrario.
- **Formatos 16:9, 9:16, 1:1 y 4:5**, con encuadre `pad` (por defecto, no
  descarta contenido) o `crop`.
- `syncStatus` pasa a `validado` **sólo** cuando la duración medida con `ffprobe`
  confirma la estimada; si no, se deja `propuesto` con la desviación registrada.
- `scripts/edit-demo.mjs`: demostración reproducible de extremo a extremo
  (fixture → análisis → propuesta → aprobación → exportación → `ffprobe`).
- Documentación: `docs/API.md`, `COST_STRATEGY.md`, `docs/examples/*.json`,
  este changelog.
- 10 tests nuevos en `tests/edits.test.js`, incluidas dos exportaciones reales.

### Añadido — Frames, beats y rampas (2026-09-18)

- **Módulo de ritmo** (`src/analysis/beats.js`): inferencia de rejilla isócrona
  por fuerza vectorial × respaldo (evita el error de octava), patrón de sincronía
  cortes↔beats y propuestas de rampas de velocidad.
- **Frames en todos los eventos**: `frame` derivado del FPS promedio y
  `frameExact`, más `metadata.frameRateMode` (`cfr`/`vfr`/`unknown`),
  `metadata.codec` y `metadata.nbFrames`.
- Interfaz: secciones «Ritmo y sincronía» y «Rampas de velocidad sugeridas»;
  columna de frames en la tabla de cortes y en el CSV exportado.
- 4 tests nuevos, incluido uno de escala (1 hora de material, 7200 onsets).

### Corregido

- `scorePeriod` y `buildBeats` eran O(líneas × onsets), inviable en material
  largo. Reescritos con dos punteros: 1 hora de audio pasa de no terminar a
  **198 ms**. La rejilla se trunca a 20 000 beats y se deja anotado.
- `speed` y `setptsFactor` se redondeaban por separado, de modo que la invariante
  `speed = 1/setptsFactor` sólo se cumplía dentro de una tolerancia.
  `setptsFactor` pasa a ser el valor canónico y `speed` se deriva de él.

### Sin cambios deliberados

- No se ha tocado el pipeline de creación desde guiones ni el estudio.
- No se ha implementado publicación en redes sociales.
- La integración con el Orquestador KSL sigue siendo sólo un contrato pendiente
  de documentar, sin código.
