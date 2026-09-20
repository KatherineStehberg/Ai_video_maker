# Estrategia de costes

Objetivo: que el uso normal de AI Video Maker cueste **cero créditos**, y que
cuando se gaste algo sea por una decisión explícita y acotada.

El principio que gobierna el diseño: **medir es local, interpretar es opcional.**
Todo lo que se puede medir con FFmpeg y aritmética se mide en este equipo. Gemini
sólo aporta descripción semántica, que es justo lo que no se puede medir.

---

## 1. Procesamiento local primero

Estas operaciones **nunca** consumen créditos, porque no salen del equipo:

| Dato | Cómo se obtiene | Coste |
|---|---|---|
| Duración, FPS, resolución, códec, pistas | `ffprobe` | 0 |
| CFR vs VFR | Comparación FPS promedio/nominal | 0 |
| Cortes y cambios de escena | Filtro `scene` de FFmpeg | 0 |
| Onsets de audio | Detector de energía en JavaScript sobre PCM | 0 |
| Tempo, rejilla de beats | Fuerza vectorial × respaldo, en JavaScript | 0 |
| Sincronía cortes↔beats | Aritmética | 0 |
| Rampas de velocidad | Aritmética sobre la rejilla | 0 |
| Propuesta de edición | Aritmética sobre lo ya medido | 0 |
| **Exportación del MP4** | **FFmpeg local** | **0** |

La segunda tanda del MVP (propuesta + exportación) se construyó entera sobre
datos ya medidos: `POST /api/video-edits` y `POST /api/video-edits/:id/export`
**no pueden** gastar créditos, porque ninguno de los dos importa el cliente de
Gemini. Hay un test automatizado que verifica esa ausencia en el código fuente.

## 2. Gemini sólo para interpretación

Gemini se usa únicamente para lo que la medición local no da: describir qué se ve
y qué se oye, y proponer cortes con una razón semántica. No se le pide medir FPS,
timestamps exactos ni beats, porque lo local ya lo hace mejor y gratis.

Consecuencia práctica: **si no configuras `GEMINI_API_KEY`, no pierdes ninguna
medición.** Pierdes la descripción. La aplicación sigue funcionando entera,
incluida la exportación.

## 3. Análisis por segmentos

Cuando Gemini sí se usa, el material se trocea en segmentos de 60 s que se
transcodifican a 640 px de ancho y ~450 kbps antes de enviarse. Esto acota el
gasto de tres formas:

- Se envía una derivada ligera, no el original: menos tokens de entrada.
- Cada segmento se comprueba contra un límite de 8 MiB antes de salir.
- El muestreo (`GEMINI_VIDEO_FPS`, por defecto 1) limita cuántos frames observa
  el modelo. Subirlo mejora la descripción y **sube el coste proporcionalmente**.

## 4. Caché: no repetir análisis idénticos

- El análisis completo se persiste en `data/analyses/<uuid>/analysis.json` junto
  a la copia del original y la previsualización. Volver a abrir la página recupera
  el resultado desde `localStorage` **sin reanalizar**.
- Un trabajo interrumpido por reinicio se marca `interrupted` y **no se reanuda
  automáticamente**, precisamente para no volver a pagar sin que lo pidas.
- Las propuestas de edición se guardan en `data/video-edits/<uuid>.json` y se
  reutilizan: puedes exportar varias veces, en varios formatos, desde la misma
  propuesta, sin tocar el análisis ni Gemini.
- Los segmentos enviados a Gemini se borran del disco en cuanto se responde
  (`finally { fs.rm }`), pero su `usageMetadata` queda registrado en el JSON para
  que puedas auditar el consumo real.

## 5. No reintentar en silencio

Un error de red o un timeout con Gemini **no se reintenta**. Un reintento
automático puede duplicar el gasto de un segmento que quizá sí se procesó al otro
lado. El error se informa y tú decides.

Por la misma razón, el consentimiento se pide por archivo: activar Gemini exige
marcar la casilla de envío externo, y el backend vuelve a exigir la cabecera
`x-gemini-consent`. No hay forma de gastar créditos por accidente al recargar.

## 6. Fallback local

Si Gemini falla, está mal configurado o no tiene clave, el trabajo **no se cae**:
`gemini.status` queda en `disabled` o `error` con su motivo, y el resultado
conserva íntegro el análisis local. La interfaz lo dice de forma explícita en vez
de mostrar un hueco o inventar una descripción.

Nunca se simulan respuestas de Gemini en producción. Los mocks existen sólo en los
tests, con valores marcados `MOCK`, y la suite completa se ejecuta **sin clave y
sin una sola llamada a Google**.

---

## Qué sí cuesta, aunque no sean créditos

Conviene tenerlo presente porque es el coste real del día a día:

- **Disco.** Cada análisis guarda una copia del original más una previsualización.
  Cada exportación guarda un MP4 nuevo. No hay borrado automático: archiva a mano
  `data/analyses/` y `output/video-edits/` cuando no los necesites.
- **CPU y tiempo.** La exportación decodifica el material completo para que los
  cortes sean exactos, en lugar de usar seeking aproximado. Es más lento y más
  correcto. En material largo, nótalo.

## Resumen operativo

| Quiero… | Configuración | Créditos |
|---|---|---|
| Analizar, proponer y exportar | Sin `GEMINI_API_KEY` | 0 |
| Añadir descripción semántica | Con clave, muestreo 1 FPS | Bajo, por segmento de 60 s |
| Descripción más detallada | Con clave, `GEMINI_VIDEO_FPS` mayor | Sube proporcionalmente |
