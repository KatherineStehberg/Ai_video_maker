# AI Video Maker

Aplicación local con tres flujos: creación desde guiones (pipeline existente), análisis de videos con música (AVM-001) y **propuesta de edición + exportación MP4** a partir de ese análisis. El análisis y la exportación están verificados con FFmpeg, ffprobe y Chrome; la integración Gemini está implementada y probada con mocks, pendiente de prueba real autorizada.

El ciclo completo `video → análisis → propuesta → aprobación → MP4` funciona **sin clave Gemini y sin coste**, y desde el navegador: hay un editor web en `/editor.html`. Ver [`docs/API.md`](docs/API.md), [`COST_STRATEGY.md`](COST_STRATEGY.md), [`DEPLOY.md`](DEPLOY.md) y [`CHANGELOG.md`](CHANGELOG.md).

## Editor web (empieza por aquí)

```powershell
npm.cmd install
npm.cmd start
```

Abre **http://127.0.0.1:4321/editor.html**. El puerto se cambia con `PORT`.

La pantalla inicial ofrece dos caminos:

**1 · Crear video con un prompt o con tu guion.** Escribes tu idea —o pegas el guion ya escrito—, eliges formato y estilo, y el sistema genera el video, lo analiza y propone el montaje. Después sigue el mismo circuito: revisar, editar trozos, aprobar y exportar.

> El proveedor predeterminado es **`pipeline`**: monta el video en este equipo encadenando guion → escenas → visuales → voz local → subtítulos → FFmpeg. Su contenido **sí** corresponde a lo que escribiste. Coste cero. El proveedor **`mock`** sigue disponible para pruebas rápidas y la interfaz advierte siempre cuando se usa, porque produce material de prueba que no representa el prompt. Para conectar un proveedor externo, el contrato está en [`src/providers/video-generation/index.js`](src/providers/video-generation/index.js); las claves van sólo en `.env`, nunca en el frontend.

### Videos cortos y videos largos: el mismo flujo

**No hay un modo «reel» y otro modo «clase».** Es la misma pantalla y las mismas funciones; lo único que cambia es lo que escribes:

| Quieres… | Qué haces |
|---|---|
| Un reel de ~15 s | Escribes la idea en **«¿Qué video quieres crear?»** y eliges 15 s |
| Un video de ~1 min | Lo mismo, con duración 1 minuto — o «Automática» |
| Una clase de 10-12 min | Despliegas **«Ya tengo el guion escrito»** y lo pegas entero |
| Algo más largo | Igual: el límite técnico son ~65 000 palabras |

**La duración objetivo es opcional.** Por defecto es «Automática según el guion», y la duración sale del contenido narrado:

```
duración = (palabras ÷ palabras_por_minuto) × 60 + (escenas × 0.35 s de pausa)
```

`palabras_por_minuto` es 115 por defecto y se ajusta con `NARRATION_WPM` o con el campo del editor. La estimación se ve **antes de generar**, mientras escribes.

Si pides una duración y el guion no cuadra, la interfaz **avisa** y produce el guion completo. **Nunca se recorta texto en silencio ni se inventa relleno.**

**Límites técnicos reales** (el `GET /api/video-generation/config` los publica): prompt 20 000 caracteres, guion 400 000, 600 escenas, 2 000 caracteres por escena, duración objetivo 3–7 200 s, cuerpo HTTP 8 MB. Cuando algo no cabe, la petición se rechaza con el número exacto.

### Proyectos largos: progreso, reanudar y regenerar una escena

Un proyecto largo **no se carga entero en memoria**: cada escena se renderiza a su propio clip MP4 en disco, con una huella que evita rehacerlo si no cambió, y FFmpeg los concatena al final sin recodificar. Medido en un proyecto de 105 escenas: **pico de 59 MB de RSS**.

- **Progreso real.** La interfaz muestra `Escena 34 de 105 · Generando la voz`. Si una etapa tarda, el número se queda quieto: no hay animación que finja avance. Los estados son `preparando-guion`, `creando-escenas`, `buscando-visuales`, `generando-voz`, `creando-subtitulos`, `renderizando-segmentos`, `concatenando`, `listo` y `error-recuperable`.
- **Reanudar.** Si algo falla dejando trabajo en disco, el proyecto se marca `error-recuperable` y aparece **«Reanudar este proyecto»**. Lo ya producido se conserva y sólo se rehace lo que falta. No se reanuda solo a propósito: con un proveedor de pago, reanudar sin permiso podría cobrar.
- **Regenerar una escena.** Cambias una escena y se rehace sólo esa; las demás se reutilizan. Medido: 42.6 s frente a 96.5 s del render completo.

Detalle completo, con las cifras de una ejecución real, en [`docs/reports/AVM-LONG-FORM.md`](docs/reports/AVM-LONG-FORM.md).

**2 · Editar un video existente.** Subes un MP4 tuyo y el editor detecta cortes, ritmo y beats, y propone el montaje.

El editor cubre el flujo entero sin `curl` ni scripts: seleccionar un MP4, ver nombre, tamaño, duración, FPS, resolución, códec y si tiene audio; analizar con barra de progreso real; revisar cortes, frames, beats, BPM, eventos de audio, rampas y sincronía; ver una timeline con los cortes, el ritmo y los segmentos propuestos; crear la propuesta eligiendo formato (16:9, 9:16, 1:1), modo de sincronización, rampas y duración objetivo; aprobarla; exportar el MP4; y descargar el resultado junto al JSON del análisis y el CSV de cortes. Hay dos reproductores HTML5, para el original y para el exportado.

**La exportación está bloqueada** mientras no haya propuesta, no esté aprobada, el análisis haya fallado o el archivo no sea válido. La interfaz dice siempre cuál de esas condiciones falta, y el botón vuelve a bloquearse mientras FFmpeg trabaja para impedir una segunda exportación simultánea.

El **panel «Trozos del montaje»** permite quitar partes y cambiar su velocidad. Editar algo invalida siempre la aprobación y descarta la exportación anterior: lo aprobado y lo medido ya no describirían ese montaje.

Las otras dos páginas siguen disponibles y sin cambios: `/analysis.html` (análisis detallado, con la interpretación opcional de Gemini) y `/` (estudio de creación desde guiones).

### Personalizar la interfaz

Tres archivos, sin frameworks ni paso de compilación. Edita y recarga el navegador.

| Quiero cambiar… | Dónde |
|---|---|
| Colores | `src/ui/editor.css`, bloque `1. COLORES` dentro de `:root` |
| Tipografía y tamaños de texto | `src/ui/editor.css`, bloque `2. TIPOGRAFÍA` |
| Espaciado, redondeo y sombras | `src/ui/editor.css`, bloque `3. ESPACIOS, BORDES Y SOMBRAS` |
| Alto del reproductor | `--player-height`, bloque `4. DIMENSIONES` |
| Ancho del panel lateral | `--panel-ancho`, mismo bloque |
| Logo | `src/ui/editor.html`, sección `[CABECERA]` (`.logo-mark`) y el `<link rel="icon">` |
| Textos y etiquetas | `src/ui/editor.html`, comentarios `TEXTOS:` |
| Botones | `src/ui/editor.css`, sección `BOTONES` (`.boton-primario`, `.boton-aprobar`, `.boton-accion`) |
| Tarjetas | `src/ui/editor.css`, sección `TARJETAS` (`.tarjeta`) |

El HTML está dividido en secciones marcadas con comentarios en mayúsculas (`[CABECERA]`, `[PANEL]`, `[ESTADO]`, `[VIDEOS]`, `[RESUMEN]`, `[TIMELINE]`, `[SEGMENTOS]`, `[DETALLE]`). La lógica está separada por responsabilidad en `src/ui/editor/`: `api.js` habla con el backend, `state.js` decide qué se puede hacer, `format.js` convierte datos en texto, y `timeline.js`, `segments.js`, `player.js` y `messages.js` sólo dibujan. `main.js` se limita a coordinar.

## Instalación y arranque

Requiere Node.js >=18.17 (probado con 22.21.1), npm, FFmpeg y ffprobe. Desde la carpeta del repositorio:

```powershell
npm.cmd install
npm.cmd run doctor
npm.cmd test
npm.cmd start
```

En Linux/macOS usa `npm` en lugar de `npm.cmd`. Los paquetes opcionales `ffmpeg-static` y `ffprobe-static` proporcionan los binarios. Si la descarga falla, instala FFmpeg y configura `FFMPEG_PATH` y `FFPROBE_PATH` en `.env` o en el entorno del backend. El doctor informa disponibilidad; sus estimaciones de hardware no demuestran que un proveedor funcione.

Abre **http://127.0.0.1:4321/analysis.html**. Mantén `HOST=127.0.0.1`; no expongas el servidor ni lo uses con un proxy público. La página `/` pertenece al flujo anterior y todavía referencia `app.js` y `styles.css` ausentes en la base; el análisis tiene sus propios assets.

## Configuración Gemini opcional

Crea `.env` local a partir de `.env.example` sólo si no existe. Edita la clave allí con tu editor, o inyéctala mediante variables de entorno del proceso del servidor. Restringe el acceso al archivo a tu usuario. No la pegues en el chat, frontend ni comandos que queden en historial. `.env` está excluido de Git y no se sirve por HTTP. Reinicia el servidor después de cambiar la configuración.

```dotenv
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
GEMINI_VIDEO_FPS=1
```

La clave sólo se usa en el header del backend a Google. La UI recibe únicamente disponibilidad, modelo y muestreo. Sin clave, funciona la detección local; faltan interpretación semántica visual/musical y propuestas Gemini. No hay respuestas simuladas en producción.

Modelo y parámetros consultados en documentación oficial el 13-09-2026: [catálogo de modelos](https://ai.google.dev/gemini-api/docs/models), [guía de video](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding), [referencia VideoMetadata](https://ai.google.dev/api/generate-content#VideoMetadata). Se usa REST `v1beta/models/{model}:generateContent`, `inlineData`, `videoMetadata.fps`, `mediaProcessing: STATIC` y salida JSON con esquema. El modelo es configurable y su disponibilidad depende de la cuenta.

**Discrepancia documental:** la guía aún muestra `videoMetadata.fps`; la referencia lo marca obsoleto en favor de `processing_options`, sin esquema de reemplazo visible en la referencia consultada. Se conserva el contrato documentado en la guía, sin afirmar que fue validado en vivo. La referencia limita el FPS solicitado a `(0, 24]`. El default de esta aplicación es 1 FPS. Un original de 30 FPS se decodifica localmente para detectar cambios, pero Gemini no observa necesariamente sus 30 frames por segundo. No se infiere cobertura efectiva a partir del parámetro solicitado.

## Uso

1. Selecciona un video local (hasta 2 GiB y 4 horas). Se copia en streaming al backend; nunca se modifica el archivo seleccionado.
2. Opcionalmente activa Gemini. La interfaz muestra que video y audio se enviarán a Google, que puede haber cargos y requiere confirmación para ese archivo. También se valida consentimiento en el backend.
3. Sigue el progreso de subida y procesamiento. Se lee duración, FPS promedio y nominal, resolución y pistas con ffprobe. Se analiza la primera pista de audio, si existe.
4. Reproduce la copia de previsualización H.264/AAC, pulsa timestamps para revisar cortes y descarga JSON (análisis completo) o CSV (tabla de cortes, con columnas `frame` y `frame_exact`).
5. Revisa «Ritmo y sincronía» (tempo inferido, beats, relación de los cortes con la rejilla) y «Rampas de velocidad sugeridas». Ambas secciones declaran explícitamente cuándo no hay evidencia suficiente en lugar de rellenar cifras.

Los resultados, original copiado y previsualización permanecen en `data/analyses/<uuid>/`, excluido de Git. La página recupera el último análisis usando su ID en localStorage. Un trabajo interrumpido por reinicio se informa como tal; no se reanuda ni vuelve a cobrar automáticamente. No hay borrado automático de originales ni render de cortes. Puedes archivar manualmente estos directorios cuando no los necesites.

## Propuesta de edición y exportación MP4

A partir de un análisis completo se genera una propuesta de edición y, tras aprobarla, se exporta un MP4 nuevo. Todo es local: estos endpoints no importan el cliente de Gemini ni hacen peticiones de red, y hay un test que lo comprueba sobre el código fuente.

```powershell
node scripts/edit-demo.mjs
```

La demostración crea un MP4 corto de prueba, lo analiza, propone la edición, la aprueba, exporta y ejecuta `ffprobe` sobre el resultado, comprobando que el original no cambió. El detalle de los endpoints está en [`docs/API.md`](docs/API.md) y los JSON reales en [`docs/examples/`](docs/examples/).

**Transformación del tiempo.** Cada segmento toma del original el intervalo `[sourceStart, sourceEnd)` de duración `D` y lo emite con duración `D_out = D × setptsFactor`, es decir `speed = 1 / setptsFactor`. En FFmpeg: `trim` + `setpts=(PTS-STARTPTS)*setptsFactor` para el vídeo y `atrim` + `atempo=speed` para el audio. `setptsFactor` es el valor canónico y `speed` se deriva de él, de modo que la invariante se cumple de forma exacta y no sólo dentro de una tolerancia. La duración estimada es la suma aritmética de todos los `D_out`; después de exportar se compara con la duración **medida con ffprobe** y la diferencia queda registrada en `export.duration.deltaSeconds`.

**Estados de sincronía.** `datos-insuficientes` (sin rejilla rítmica, los segmentos quedan a velocidad 1), `propuesto` (rampas calculadas, nada renderizado) y `validado`, que **sólo** se alcanza cuando la medición del archivo confirma la predicción. Si no coincide, el estado se queda en `propuesto` con la desviación anotada.

**Seguridad de la exportación.** El original se abre en sólo lectura y nunca se sobrescribe; la salida vive en `output/video-edits/<id>/` junto a su `metadata.json`. Exportar exige aprobación humana explícita (`POST /api/video-edits/:id/approve` con `{"confirm": true}`) salvo que la propuesta se haya creado con `approvalRequired: false`. Los segmentos solapados, desordenados, fuera del material o con velocidades fuera del rango de `atempo` se rechazan con un mensaje concreto antes de invocar FFmpeg. No hay publicación en redes sociales en ninguna ruta.

### El problema de sincronía que NO está resuelto

Alinear los cortes a los beats estirando el vídeo obliga a estirar también el audio para no perder la sincronía audiovisual dentro de cada segmento. Pero estirar el audio **cambia el tempo de la música**, así que los beats del MP4 exportado ya no caen donde los midió el análisis del original. Es una contradicción inherente a la operación, no un fallo de implementación: no se puede a la vez cambiar la duración de un plano y conservar intacta la música que suena debajo.

La aplicación elige conservar la sincronía audiovisual (`audioMode: "stretch"`, con `atempo`) y **lo advierte de forma explícita** en `warnings` en lugar de simular que la alineación rítmica sobrevive a la exportación. `atempo` además hace time-stretch sin corregir formantes, lo que en voz puede introducir artefactos audibles. Resolverlo bien exigiría tratar la música como pista independiente del metraje —montar el vídeo contra una banda sonora fija en vez de estirar ambas—, que es un rediseño del flujo, no un ajuste.

## Algoritmos y límites

- **Cambios visuales:** FFmpeg `scene > 0.3`, evaluado en frames decodificados a ancho 320. Se conserva `pts_time`, no un número de frame convertido por FPS promedio. Detecta cambios bruscos; fundidos, movimiento fino y escenas similares pueden omitirse.
- **Onsets:** detector JavaScript de incrementos de energía con ventanas de 10 ms, referencia adaptativa de 500 ms y separación mínima de 120 ms. FFmpeg sólo extrae PCM mono de 16 kHz. Voz, ruido y percusión pueden producir candidatos; música sostenida puede no hacerlo. El campo `evidence.rms` es la norma L2 de la ventana (no está dividida por el número de muestras): es comparable entre ventanas, pero no es un RMS normalizado y su escala no debe interpretarse como amplitud.
- **Frames:** cada evento lleva `timestamp` en segundos y `frame` entero derivado de `round((t − start_time del stream) × FPS promedio)`. `frameExact` es `true` sólo cuando `metadata.frameRateMode` es `cfr`, es decir cuando el FPS promedio y el nominal coinciden dentro del 0,1 %. Con VFR o modo desconocido el número es una conversión aproximada y la interfaz lo marca con «~». La medida primaria sigue siendo `pts_time`; el frame es derivado.
- **Rejilla rítmica (beats):** se infiere un único periodo isócrono a partir de los onsets, buscando entre 50 y 200 BPM con paso de 2 ms y refinado de 0,2 ms. Cada periodo candidato se puntúa como `fuerza vectorial × respaldo`: la fuerza vectorial mide la concentración de fase de los onsets y el respaldo es la fracción de líneas de la rejilla que tienen un onset a menos de la tolerancia (70 ms o 12 % del periodo). El respaldo es lo que evita el error de octava: una rejilla al doble de tempo concentra igual de bien la fase, pero deja la mitad de sus líneas sin ninguna evidencia. Se exige un mínimo de 4 onsets, 2,5 s de recorrido y puntuación 0,5; si no se cumplen, `tempo` es `null`, `beats` queda vacío y se registra el motivo. **No es un seguidor de beats entrenado:** no separa percusión, no detecta compás ni downbeat y no sigue cambios de tempo dentro de la pieza. Los umbrales no están calibrados contra un corpus anotado.
- **Sincronía cortes↔beats:** para cada corte visual se mide su desvío con signo respecto a la línea de rejilla más cercana y se informa la proporción dentro de tolerancia, el desvío absoluto mediano y el medio con signo. La clasificación (`sincronizado` ≥ 60 %, `parcial` ≥ 30 %, `no-sincronizado`) es descriptiva. Con menos de 3 cortes visuales devuelve `datos-insuficientes` en lugar de una cifra. El reparto `beatPositionsMod4` es una observación del histograma sobre 4 tiempos, no una afirmación de que el material esté en 4/4.
- **Rampas de velocidad:** propuestas calculadas, no ediciones aplicadas. Cada segmento entre cortes visuales consecutivos se compara con el múltiplo entero de beats más cercano; si la diferencia supera 40 ms y el cambio de velocidad queda entre 0,75× y 1,34×, se propone la rampa con `speedFactor` (velocidad de reproducción) y `setptsFactor` (multiplicador directo para el filtro `setpts` de FFmpeg). Sin rejilla rítmica no se propone ninguna. Ningún render se ha ejecutado ni validado a partir de estas propuestas en esta fase.
- **Interpretación:** derivados de 60 segundos, ancho 640, video y primera pista de audio. Se transcodifica un segmento por vez a disco, se comprueba límite de 8 MiB y sólo ese segmento se codifica en memoria. No se carga el original completo en RAM. Los segmentos no comparten contexto y pueden perder eventos en sus límites.
- **Fusión:** una propuesta Gemini a <=250 ms de un evento local se ajusta a ese timestamp y conserva el timestamp del modelo y su diferencia. Las demás siguen siendo aproximadas. No se deduce precisión real del número de decimales.
- **Confianza:** `null`/«Sin calibrar»; los scores visuales y RMS son evidencia del detector, no probabilidades. La previsualización sirve para revisión, no para edición exacta de frames.
- Un análisis/subida a la vez. Original más previsualización requieren espacio en disco; no hay garantía de rendimiento para videos de horas, 4K, VFR, HDR, rotación o timestamps discontinuos. Se limita cada proceso local y cada petición Gemini con timeout. No hay cancelación ni reintentos automáticos en esta fase.
- JSON registra tiempos, modelo solicitado, versión devuelta, FPS solicitado, segmentos, estado y `usageMetadata` disponible, incluso respuestas inválidas. Los errores HTTP no exponen el cuerpo del proveedor ni la clave. No se calcula precio monetario; un timeout puede haber consumido cuota.

## Verificación reproducible

`npm.cmd test` genera fixtures sintéticos en `.tmp/analysis-test/` y ejecuta tests reales de FFmpeg/ffprobe, API HTTP, exactitud temporal, conversión a frames, inferencia de tempo, sincronía, rampas, exportación, integridad del original y contrato Gemini con mocks explícitos.

`tests/edits.test.js` cubre la propuesta y la exportación: validez del esquema, orden y ausencia de solapamiento, rampas, duración estimada, rechazo de propuestas no aprobadas, original sin audio, formato vertical 9:16, dos **exportaciones MP4 reales** verificadas con ffprobe y el flujo HTTP completo. Sobre el fixture de rampas (6 s, cortes a 1,65 s y 3,03 s, rejilla de 120 BPM) la medición reproducible es: salida 1920×1080 H.264 CFR a 30 FPS, duración medida 6,000 s frente a 6,0007 s estimados (delta −0,7 ms), `syncStatus` `validado` y SHA-256 del original idéntico antes y después.

Sobre el fixture sintético de 30 FPS (4 s, corte visual en 2,000 s, clics a 1 Hz) la medición reproducible es: `frameRateMode` `cfr`, corte visual en el frame 60 con error temporal 0, onsets en los frames 15/45/75/105 con error máximo de 10 ms y tempo inferido 60,18 BPM (fuerza vectorial 1,00, respaldo 1,00) sin saltar a la octava de 120 BPM. La sincronía se reporta como `datos-insuficientes` porque un solo corte visual no permite describir un patrón. El resultado se escribe en `.tmp/analysis-test/e2e-result.json`. No hace llamadas a Google y no necesita clave. Los tests conservan sus análisis de prueba en `data/analyses/`.

Prueba opcional de navegador, después de `npm.cmd test`:

```powershell
npm.cmd install --no-save --package-lock=false --prefix .tmp/browser-tools playwright-core
node scripts/browser-smoke.mjs
```

### Prueba de guion largo

```powershell
node scripts/long-form-smoke.mjs            # planifica el guion largo, renderiza una muestra
node scripts/long-form-smoke.mjs --full     # renderiza el proyecto largo entero (lento)
node scripts/long-form-smoke.mjs --palabras 2500
```

Todo local y sin coste: voz SAPI, fondos generados con FFmpeg, sin Pexels, sin Gemini y sin ninguna API de pago. Informa, con cifras medidas: palabras, escenas, duración estimada, **duración real medida con ffprobe**, estado final, pico de memoria, si el proyecto es reanudable, y una verificación de que el guion llegó entero sin truncar. Además **calibra la voz** de este equipo, comparando la duración estimada con la real, y dice qué `NARRATION_WPM` usar.

Medición del 2026-09-20 sobre un guion de 15 706 caracteres y 2 702 palabras: 105 escenas, 7 secciones, plantilla `video-curso` elegida automáticamente, 23 min 48 s estimados, planificación en 9 ms, guion íntegro verificado, pico de RSS **59 MB**. La muestra de 6 escenas produjo un MP4 de 3,75 MB con audio y subtítulos, 56,40 s medidos con ffprobe frente a 80,89 s previstos (la voz de esta máquina narra a ~167 wpm, no a los 115 supuestos: ver limitación 1 en el informe). Regenerar una sola escena costó 42,6 s frente a 96,5 s del render completo.

`tests/long-form.test.js` cubre en 20 pruebas: guion de más de 2 000 caracteres aceptado sin truncar, video de ~1 minuto, guion de 10-12 minutos, segmentación que nunca parte una oración, duración automática, objetivo incompatible que avisa sin recortar, estados y progreso contado, reanudación y regeneración de una escena, ausencia de claves en respuestas y frontend, contrato del Orquestador y no regresión del flujo corto.

Hay dos smoke tests de navegador. `scripts/editor-smoke.mjs` recorre el **flujo completo del editor web** (subir → analizar → propuesta → aprobar → exportar → descargar) y comprueba, entre otras cosas, que exportar esté bloqueado antes de aprobar, que el botón se bloquee durante la exportación, que los dos reproductores decodifiquen, que el MP4 descargado no esté vacío, que el original no cambie y que la página no produzca **ningún** error ni respuesta HTTP ≥ 400. `scripts/browser-smoke.mjs` cubre la página `/analysis.html`.

```powershell
node scripts/editor-smoke.mjs
node scripts/browser-smoke.mjs
```

Usa Chrome instalado en su ruta habitual Windows, o establece `CHROME_PATH` para otro entorno. Genera captura, descargas y reporte en `.tmp/analysis-test/`. Esta dependencia es sólo para pruebas, no para arrancar la aplicación y **requiere Node.js 20 o superior** (Playwright no arranca en Node 18, aunque el resto del proyecto sí funciona ahí). Verifica subida, decodificación y búsqueda en la previsualización, columna de frames, sección de ritmo, descargas y el contrato de consentimiento con configuración simulada, sin llamar a Google.

Consulta [ticket AVM-001](docs/tickets/AVM-001.md) e [informe de pruebas y pendientes](docs/reports/AVM-001.md).
