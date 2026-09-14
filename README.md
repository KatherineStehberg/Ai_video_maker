# AI Video Maker

Aplicación local con dos flujos distintos: creación desde guiones (pipeline existente) y análisis de videos con música (AVM-001). El análisis local está verificado con FFmpeg y Chrome; la integración Gemini está implementada y probada con mocks, pendiente de prueba real autorizada.

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
4. Reproduce la copia de previsualización H.264/AAC, pulsa timestamps para revisar cortes y descarga JSON (análisis completo) o CSV (tabla de cortes).

Los resultados, original copiado y previsualización permanecen en `data/analyses/<uuid>/`, excluido de Git. La página recupera el último análisis usando su ID en localStorage. Un trabajo interrumpido por reinicio se informa como tal; no se reanuda ni vuelve a cobrar automáticamente. No hay borrado automático de originales ni render de cortes. Puedes archivar manualmente estos directorios cuando no los necesites.

## Algoritmos y límites

- **Cambios visuales:** FFmpeg `scene > 0.3`, evaluado en frames decodificados a ancho 320. Se conserva `pts_time`, no un número de frame convertido por FPS promedio. Detecta cambios bruscos; fundidos, movimiento fino y escenas similares pueden omitirse.
- **Onsets:** detector JavaScript de incrementos de energía RMS con ventanas de 10 ms, referencia adaptativa de 500 ms y separación mínima de 120 ms. FFmpeg sólo extrae PCM mono de 16 kHz. No hay seguimiento de tempo ni rejilla de beats: voz, ruido y percusión pueden producir candidatos; música sostenida puede no hacerlo.
- **Interpretación:** derivados de 60 segundos, ancho 640, video y primera pista de audio. Se transcodifica un segmento por vez a disco, se comprueba límite de 8 MiB y sólo ese segmento se codifica en memoria. No se carga el original completo en RAM. Los segmentos no comparten contexto y pueden perder eventos en sus límites.
- **Fusión:** una propuesta Gemini a <=250 ms de un evento local se ajusta a ese timestamp y conserva el timestamp del modelo y su diferencia. Las demás siguen siendo aproximadas. No se deduce precisión real del número de decimales.
- **Confianza:** `null`/«Sin calibrar»; los scores visuales y RMS son evidencia del detector, no probabilidades. La previsualización sirve para revisión, no para edición exacta de frames.
- Un análisis/subida a la vez. Original más previsualización requieren espacio en disco; no hay garantía de rendimiento para videos de horas, 4K, VFR, HDR, rotación o timestamps discontinuos. Se limita cada proceso local y cada petición Gemini con timeout. No hay cancelación ni reintentos automáticos en esta fase.
- JSON registra tiempos, modelo solicitado, versión devuelta, FPS solicitado, segmentos, estado y `usageMetadata` disponible, incluso respuestas inválidas. Los errores HTTP no exponen el cuerpo del proveedor ni la clave. No se calcula precio monetario; un timeout puede haber consumido cuota.

## Verificación reproducible

`npm.cmd test` genera fixtures sintéticos en `.tmp/analysis-test/` y ejecuta tests reales de FFmpeg/ffprobe, API HTTP, exactitud temporal, exportación, integridad del original y contrato Gemini con mocks explícitos. No hace llamadas a Google y no necesita clave. Los tests conservan sus análisis de prueba en `data/analyses/`.

Prueba opcional de navegador, después de `npm.cmd test`:

```powershell
npm.cmd install --no-save --package-lock=false --prefix .tmp/browser-tools playwright-core
node scripts/browser-smoke.mjs
```

Usa Chrome instalado en su ruta habitual Windows, o establece `CHROME_PATH` para otro entorno. Genera captura, descargas y reporte en `.tmp/analysis-test/`. Esta dependencia es sólo para pruebas, no para arrancar la aplicación.

Consulta [ticket AVM-001](docs/tickets/AVM-001.md) e [informe de pruebas y pendientes](docs/reports/AVM-001.md).
