# API local de AI Video Maker

Todos los endpoints escuchan sólo en `127.0.0.1` y rechazan peticiones cuyo `Host`
no sea `localhost` o `127.0.0.1`. El puerto se configura con `PORT` (por defecto 4321).
Ninguna respuesta incluye `GEMINI_API_KEY` ni ningún otro secreto.

Ejemplos completos y reales en [`docs/examples/`](examples/), generados por
`node scripts/edit-demo.mjs`.

El editor web (`/editor.html`) consume exactamente estos endpoints mediante
`src/ui/editor/api.js`; no duplica lógica de FFmpeg ni de análisis.

> **Nota sobre nombres de rutas.** No existen `POST /api/video-jobs` ni
> `GET /api/video-jobs/:id`. El análisis vive en `/api/analysis`. Si alguna
> documentación o encargo menciona `/api/video-jobs`, está desactualizado.

---

## Análisis de video

### `GET /api/analysis/config`

Devuelve disponibilidad, nunca la clave.

```json
{ "hasKey": false, "model": "gemini-3.8-flash", "requestedFps": 1, "segmentSeconds": 60, "maxBytes": 2147483648 }
```

### `POST /api/analysis`

Sube un MP4 en streaming y arranca el análisis. Requiere la cabecera
`x-analysis-upload: 1`. Con `?gemini=true` exige además `x-gemini-consent: yes`
y que exista clave en el backend. Responde `202` con el trabajo inicial.

### `GET /api/analysis/:id`

Estado y resultado. Campos relevantes: `status`, `progress`, `stage`, `metadata`
(`duration`, `fps`, `nominalFps`, `frameRateMode`, `codec`, `width`, `height`, `audio[]`),
`local` (`scenes`, `onsets`, `beats`, `tempo`, `sync`, `ramps`) y `cuts`.
Cada evento lleva `timestamp` en segundos y `frame` entero, más `frameExact`.

### `GET /api/analysis/:id/preview` · `GET /api/analysis/:id/export[?format=csv]`

Copia de previsualización con soporte de `Range`, y exportación del análisis
en JSON o CSV.

---

## Generación de video con IA

Flujo alternativo a la subida: un prompt produce un video que **se encadena
automáticamente** con el mismo análisis y la misma edición. La aprobación humana
y la exportación siguen siendo pasos aparte, con idénticas garantías.

### `GET /api/video-generation/config`

Proveedores disponibles, formatos, estilos y límites. De cada proveedor publica
`configured` y qué variables de entorno necesitaría, **nunca sus valores**.

### `POST /api/video-generation/draft`

Redacta el guion y las escenas **sin producir nada**: no renderiza, no sintetiza
voz y no descarga imágenes. Es instantáneo y no puede gastar créditos salvo que
haya un LLM de pago configurado, cosa que la respuesta declara en `costo`.

Acepta el mismo cuerpo que `jobs`. Devuelve `escenas[]` (con `text`,
`onScreenTitle`, `visualPrompt`, `duration` y `role`), `templateId`, `source`
(`plantilla-local` o `llm`) y `costo`, con el desglose por pieza.

### `POST /api/video-generation/jobs`

```json
{
  "prompt": "Video vertical promocional sobre...",
  "duration": 15,
  "format": "9:16",
  "style": "cinematográfico",
  "platform": "TikTok"
}
```

`prompt` es obligatorio (máx. 2000 caracteres). `duration` entre 3 y 120 s,
`format` uno de `9:16`, `16:9`, `1:1`, y `style` uno de los que lista la config.
`music`, `tempo`, `audience` y `platform` son opcionales y se pasan al proveedor
sin interpretarlos. Responde `202` con el trabajo en estado `queued`.

### `GET /api/video-generation/jobs/:id`

Estados: `queued` → `generating` → `generated` → `analyzing` → `editing` →
`completed`, o `failed` en cualquier punto. Al llegar a `completed` el trabajo
trae `analysisId` y `editId`, que se consultan con los endpoints normales de
análisis y de edición.

Un trabajo interrumpido por un reinicio del servidor se marca `failed` y **no se
reanuda solo**: con un proveedor de pago, reanudar podría volver a cobrar.

Al cuerpo se le puede añadir `escenas[]` (las que la usuaria revisó en el
borrador) y `templateId`. Si vienen, mandan sobre cualquier redacción
automática: el proveedor no vuelve a inventar el guion.

### Proveedores

`pipeline` es el predeterminado: monta el video en local encadenando guion →
escenas → visuales → voz (TTS local) → subtítulos → FFmpeg. Su contenido
corresponde al prompt y no cuesta nada.

`mock` sigue disponible para pruebas rápidas: construye un video de prueba con FFmpeg en local, sin
IA y sin coste. Las ranuras `api` (servicio externo) y `local` (modelo en este
equipo) están declaradas pero **no implementadas**, y fallan con un mensaje que
dice qué falta. El contrato para añadir uno real está documentado en
`src/providers/video-generation/index.js`.

---

## Propuesta de edición

### `POST /api/video-edits`

Crea una propuesta **a partir de un análisis ya completo**. No vuelve a analizar,
no ejecuta FFmpeg y no contacta ningún servicio externo: es aritmética sobre los
cortes, la rejilla rítmica y las rampas ya medidas.

**Request** ([ejemplo](examples/video-edit-request.json)):

```json
{
  "videoJobId": "c8f1…",
  "format": "9:16",
  "targetDuration": null,
  "syncMode": "beats",
  "enableSpeedRamps": true,
  "approvalRequired": true
}
```

| Campo | Valores | Por defecto | Significado |
|---|---|---|---|
| `videoJobId` | UUID de análisis | — | Análisis de origen; debe estar `complete` |
| `format` | `16:9`, `9:16`, `1:1`, `4:5` | `9:16` | Encuadre de salida |
| `targetDuration` | `null` o segundos > 0 | `null` | Reescala uniforme hacia esa duración |
| `syncMode` | `beats`, `cuts` | `beats` | `cuts` respeta el metraje sin alinear |
| `enableSpeedRamps` | booleano | `true` | Aplica las rampas calculadas contra la rejilla |
| `approvalRequired` | booleano | `true` | Si es `true`, exportar exige aprobación explícita |

**Response `201`** ([ejemplo completo](examples/video-edit-proposal.json)):

```json
{
  "id": "733addcc-90d1-4500-9ada-6769ffa94ca2",
  "videoJobId": "…",
  "sourceVideo": "data/analyses/…/original",
  "format": "9:16",
  "dimensions": { "width": 1080, "height": 1920 },
  "syncStatus": "propuesto",
  "approvalRequired": true,
  "approval": { "status": "pendiente", "at": null, "by": null },
  "segments": [
    { "sourceStart": 0, "sourceEnd": 1.66667, "speed": 1.1111, "setptsFactor": 0.899998,
      "reason": "beat-aligned", "start": 0, "end": 1.5 }
  ],
  "ramps": [ "…rampas aplicadas, con su evidencia rítmica…" ],
  "estimatedDuration": 6.000669,
  "audioMode": "stretch",
  "analysis": { "fps": 30, "frameRateMode": "cfr", "cuts": [], "beats": [], "tempo": {}, "sync": {} },
  "warnings": [ "…" ],
  "timeTransform": "D_out = (sourceEnd - sourceStart) * setptsFactor; speed = 1 / setptsFactor; …"
}
```

`syncStatus` recorre tres valores y **nunca** se declara validado sin medición:

| Valor | Cuándo |
|---|---|
| `datos-insuficientes` | No se infirió rejilla rítmica; los segmentos quedan a velocidad 1 |
| `propuesto` | Hay rejilla y las rampas están calculadas, pero nada se ha renderizado |
| `validado` | Se exportó y la **duración medida con ffprobe** coincide con la estimada |

Errores: `404` análisis inexistente, `409` análisis incompleto, `400` parámetros
inválidos (formato no soportado, `syncMode` desconocido, `targetDuration` ≤ 0).

### `GET /api/video-edits/:id`

Devuelve la propuesta guardada, incluido `export` si ya se exportó.

### `PATCH /api/video-edits/:id`

Edita los segmentos del montaje desde el panel editable del editor. Se envían
los segmentos que se quieren **conservar**, identificados por su índice actual
(en orden ascendente y sin repetir); los índices omitidos se eliminan.

```json
{ "segments": [ { "index": 0, "speed": 1.25 }, { "index": 2, "speed": 1 } ] }
```

El backend recalcula la línea de salida, revalida la propuesta y, **siempre**:

- devuelve la aprobación a `pendiente` (editar invalida lo aprobado);
- borra `export`, porque el informe anterior ya no describe esta propuesta;
- devuelve `syncStatus` de `validado` a `propuesto` si lo estaba.

Errores `400`: lista vacía, índice fuera de rango, índices desordenados o
repetidos, o velocidad fuera de `0.5`–`2.0` (límite del filtro `atempo`).

### `POST /api/video-edits/:id/approve`

Aprobación humana explícita. Exige `{"confirm": true}`; `by` es opcional.
Revalida la propuesta antes de aprobarla.

```json
{ "confirm": true, "by": "katherine" }
```

Sin `confirm: true` responde `400`.

### `POST /api/video-edits/:id/export`

Exporta el MP4 con FFmpeg. Body opcional: `{"fit": "pad"}` (por defecto) o
`{"fit": "crop"}`. `pad` encaja el fotograma completo y rellena con barras, sin
descartar nada de lo medido; `crop` llena el encuadre recortando bordes.

Responde `403` si la propuesta requiere aprobación y no la tiene, y `409` si ya
hay otra exportación en curso.

**Response `200`** ([ejemplo](examples/video-edit-export-response.json)):

```json
{
  "id": "733addcc-…",
  "syncStatus": "validado",
  "export": {
    "file": "output/video-edits/733addcc-…/733addcc-…_9x16.mp4",
    "bytes": 34971,
    "requested": { "format": "9:16", "width": 1080, "height": 1920, "fps": 30 },
    "measured": { "duration": 6, "fps": 30, "width": 1080, "height": 1920,
                  "codec": "h264", "frameRateMode": "cfr", "audioTracks": 1 },
    "duration": { "estimated": 6.00066921622, "measured": 6,
                  "deltaSeconds": -0.00066921622, "withinTolerance": true },
    "audio": { "mode": "stretch", "timeStretched": true },
    "sourceUntouched": true
  },
  "warnings": [ "…" ]
}
```

Junto al MP4 se escribe `metadata.json` en el mismo directorio, con segmentos,
rampas, análisis de origen, transformación temporal y el informe de exportación.

### `GET /api/video-edits/:id/file`

Descarga el MP4 exportado (`409` si todavía no se ha exportado).

---

## Consumo desde el frontend

`src/ui/editor/api.js` expone un cliente con inyección de `fetch`, lo que
permite probarlo sin navegador (`tests/ui.test.js`). Resumen del uso real:

| Paso de la interfaz | Llamada |
|---|---|
| Comprobar modo local | `GET /api/analysis/config` (sólo `hasKey`, nunca la clave) |
| Subir el MP4 | `POST /api/analysis` con `x-analysis-upload: 1`, vía XHR para el progreso |
| Seguir el análisis | `GET /api/analysis/:id` en sondeo cada 900 ms |
| Reproducir el original | `GET /api/analysis/:id/preview` |
| Descargas del análisis | `GET /api/analysis/:id/export` y `?format=csv` |
| Crear propuesta | `POST /api/video-edits` |
| Editar los trozos | `PATCH /api/video-edits/:id` |
| Aprobar | `POST /api/video-edits/:id/approve` con `{"confirm": true}` |
| Exportar | `POST /api/video-edits/:id/export` |
| Reproducir y descargar | `GET /api/video-edits/:id/file` |

El sondeo nunca lanza dos peticiones simultáneas y se cancela al cambiar de
archivo. La exportación es una única petición síncrona: mientras dura, la
interfaz muestra el tiempo transcurrido y bloquea el botón.

## Garantías de seguridad de la exportación

- El original se abre en **sólo lectura** y nunca se sobrescribe; la salida vive
  en `output/video-edits/<id>/`. Los tests comprueban el SHA-256 del original
  antes y después.
- La exportación **no importa el módulo de Gemini ni hace peticiones de red**;
  hay un test que lo verifica sobre el código fuente.
- Ninguna propuesta se exporta sin aprobación humana cuando `approvalRequired`
  es `true`.
- Segmentos solapados, desordenados, fuera del material o con velocidades fuera
  del rango de `atempo` se rechazan con un mensaje concreto antes de invocar FFmpeg.
- No hay publicación en redes sociales en ninguna ruta.
