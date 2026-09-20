# AVM-LONG-FORM · Videos largos por el mismo flujo que los cortos

**Rama:** `feat/personal-video-studio`
**Fecha:** 2026-09-20
**Alcance:** local-first, coste cero, sin deploy y sin tocar el Orquestador KSL.

---

## 1. El problema, y cuál era la causa exacta

El flujo aceptaba una idea corta y producía un video corto. Un guion de clase de
10-12 minutos no entraba. La causa no era una sola: eran **seis topes
independientes**, todos en el camino de generación.

| Dónde | Qué limitaba | Valor anterior | Valor ahora |
|---|---|---|---|
| `src/generation/jobs.js` | `PROMPT_MAX` | **2 000 caracteres** | 20 000 (y guion aparte con 400 000) |
| `src/ui/editor.html` | `<textarea id="prompt" maxlength="2000">` | **2 000, truncado por el navegador** | sin `maxlength` |
| `src/generation/jobs.js` | escenas por proyecto | **20** | 600 |
| `src/generation/jobs.js` | texto por escena | 600 car., **recortado con `.slice()`** | 2 000 car., se rechaza en vez de recortar |
| `src/generation/jobs.js` | duración por escena | 0.5–**30 s** | 0.5–120 s |
| `src/generation/jobs.js` | `DURATION_LIMITS.max` | **900 s** | 7 200 s |
| `src/generation/routes.js` | cuerpo HTTP | **256 KB** | 8 MB |

El más dañino era `text.slice(0, 600)` en `normalizeSpec`: **recortaba la
narración en silencio**, sin error y sin aviso. Eso ya no existe en ningún sitio;
hoy, cuando algo no cabe, la petición se rechaza entera con un mensaje que dice
el número exacto.

El segundo más dañino era `maxlength="2000"` en el HTML: el navegador truncaba al
pegar, antes de que el backend viera nada. Hay una prueba de navegador que ahora
falla si alguien vuelve a poner un `maxlength` en esos campos.

---

## 2. Un solo flujo, no dos

**No hay un botón de «1 minuto» y otro de «10 minutos».** Es el mismo flujo, la
misma pantalla y las mismas funciones. Lo único que cambia es lo que se escribe:

```
Prompt o guion → borrador → escenas editables → visuales → narración
                → música → subtítulos → preview → ajustes → exportación
```

Dos entradas con papeles distintos, y basta con una:

- **`prompt`** — la *idea*. De ella se redacta un guion (plantilla local, o el
  LLM configurado si lo hay).
- **`script`** — el *guion ya escrito*. Manda sobre el prompt, y **no se
  reescribe, no se resume y no se recorta**: sólo se trocea en escenas.

La duración objetivo es **opcional** en todos los casos. Por defecto es
«Automática según el guion».

---

## 3. Cómo se calcula la duración

La cuenta es deliberadamente explicable, para que se pueda contrastar a mano:

```
duración = (palabras narradas ÷ palabras_por_minuto) × 60
         + (número de escenas × pausa_entre_escenas)
```

- `palabras_por_minuto` por defecto: **115**, configurable con `NARRATION_WPM`
  o con el campo «palabras por minuto» del editor.
- `pausa_entre_escenas`: **0.35 s** (el montaje deja respirar entre clips; con
  80 escenas son 28 s, así que ignorarlo desviaría la estimación).

La estimación se muestra **antes de producir nada**, mientras se escribe el
guion (`POST /api/video-generation/plan`), y usa exactamente el mismo
segmentador que la producción: lo previsto y lo producido no pueden
contradecirse.

### Duración objetivo incompatible

Si se pide una duración y el guion no cuadra (más de un 15 %, con suelo de 5 s),
se **avisa** y se produce igual con el guion completo. Nunca se quita contenido
para que cuadre el reloj, y nunca se inventa relleno para alargarlo.

> El guion dura unos 23 min 48 s y pediste 1 min. No se ha recortado nada: sube
> la duración objetivo o acorta el guion.

Cuando hay objetivo, la voz se acelera con `atempo` dentro de lo que suena
natural (×0.7 a ×1.6) y, si no alcanza, se dice cuánto durará de verdad.

---

## 4. Segmentación: cómo se corta un guion

Jerarquía de corte, de más fuerte a más débil (`src/generation/segmenter.js`):

1. **Título** → siempre abre escena, y da el texto en pantalla.
2. **Párrafo** → siempre cierra la escena en curso.
3. **Oración** → las oraciones se agrupan hasta llenar la escena.
4. **Dentro de una oración → nunca.** Una oración que no cabe ocupa su propia
   escena, más larga de lo normal, y se declara en `advertencias`.

Se reconoce como título una línea corta que no termina en punto: `# Módulo 2`,
`OBJETIVOS`, `Objetivos de la clase:`. Se distingue de la narración marcada con
`##` (el formato interno del pipeline) precisamente por eso: `## Hoy veremos
cómo se forma el pretérito.` es narración, no título.

**Garantía de integridad.** `sinPerdidaDeTexto()` comprueba que ninguna palabra
del guion original desaparece: o se narra, o se muestra en pantalla. Se ejecuta
en las pruebas y en el smoke de guion largo.

---

## 5. Procesamiento por bloques y memoria

Nada de esto se construyó de cero: el renderer **ya** trabajaba por escena. Lo
que se hizo fue apoyarse en ello y exponerlo.

- Cada escena se renderiza a **su propio clip MP4 en disco** (`renderSceneClip`).
- Cada clip lleva una **huella SHA-256** de lo que lo define. Si no cambió, no se
  vuelve a renderizar.
- La voz se cachea igual, por `narrationKey`.
- Al final, FFmpeg concatena los clips **sin recodificar** (`concat` + `-c copy`).
- El proyecto se guarda en disco de forma atómica tras cada etapa.

**Consecuencia medida:** el pico de RSS de un proyecto de 105 escenas fue de
**59 MB**. El video nunca está entero en memoria.

---

## 6. Estados y progreso real

`src/generation/states.js` define los estados pedidos:

`preparando-guion` → `creando-escenas` → `buscando-visuales` → `generando-voz` →
`creando-subtitulos` → `renderizando-segmentos` → `concatenando` → `listo`,
más `error-recuperable`.

El porcentaje **se cuenta**, no se simula:

```
porcentaje = base_de_la_etapa + peso_de_la_etapa × (escenas_hechas ÷ escenas_totales)
```

La interfaz muestra `Escena 34 de 105 · Generando la voz`. Si una etapa tarda, el
número se queda quieto — que es lo que realmente está pasando. No hay ninguna
animación que finja avance.

---

## 7. Reanudar y regenerar una escena

**Reanudar** (`POST /api/video-generation/jobs/:id/resume`): el proyecto sigue en
disco con sus WAV y sus clips. Reanudar es volver a recorrer el pipeline sobre él;
lo terminado se salta solo por las huellas. Un fallo que dejó proyecto en disco se
marca `error-recuperable` y la interfaz ofrece el botón; un fallo anterior a eso
se marca `error` y dice que hay que empezar de nuevo.

**Regenerar una escena** (`POST /api/video-generation/jobs/:id/scenes/:n`): se
cambia esa escena, se invalida su huella y se vuelve a montar. Las demás se
reutilizan.

**Medido en este equipo:** render de 6 escenas **96.5 s**; regenerar una sola de
esas escenas **42.6 s**, con las otras 5 intactas.

---

## 8. Evidencia reproducible

`node scripts/long-form-smoke.mjs` (añadir `--full` para renderizar el proyecto
entero). Todo local: voz SAPI, fondos FFmpeg, sin Pexels, sin Gemini, sin API de
pago.

### Ejecución del 2026-09-20 — `--full`, proyecto completo renderizado

| Medida | Valor |
|---|---|
| Caracteres del guion | **15 706** (7,8× el viejo tope de 2 000) |
| Palabras del guion | 2 702 |
| Palabras narradas | **2 667** (las otras 35 son títulos: van en pantalla, no se narran) |
| **Escenas** | **105** |
| Secciones detectadas | 7 |
| Plantilla elegida | `video-curso` (automático, por extensión del guion) |
| Duración estimada (a 115 wpm) | 1 428.42 s — 23 min 48 s |
| Tiempo de planificación | 14 ms |
| **Guion completo, sin truncar** | **sí**, verificado con `sinPerdidaDeTexto` |
| Objetivo incompatible (60 s) | avisa; **105 escenas antes y después** |
| Escenas renderizadas | **105 de 105** |
| **Duración real (ffprobe)** | **998.97 s = 16 min 39 s** |
| Duración registrada en el proyecto | 998.97 s (sincronizada con la narración real) |
| MP4 producido | **46.4 MB**, 16:9, con audio |
| Subtítulos | `output/drafts/vid_muaa12ir25c6d8/captions.srt` |
| Palabras en el MP4 final | 2 667 — **las mismas que entraron** |
| Estado final | `completed` / `listo` |
| Tiempo de render | ~27 min (4 hilos de CPU) |
| **Pico de RSS** | **59 MB** con 105 escenas |
| Reanudable | sí (`projectId` persistido desde antes del render) |
| Regenerar 1 escena sobre las 105 | re-montaje completo en ~4 min, sin rehacer las otras 104 |

**Calibración de la voz medida sobre las 105 escenas:** 2 667 palabras en 998.97 s
dan **166 wpm reales**, frente a los 115 supuestos: un **43 % de desvío**. La
cifra coincide con la de la muestra de 6 escenas (167 wpm), así que es estable y
no un artefacto del tamaño. Ver la limitación 1.

El informe en JSON queda en `.tmp/long-form-smoke/informe.json` y el guion usado
en `.tmp/long-form-smoke/guion.txt`.

### Progreso observado (real, no simulado)

Medido sobre un proyecto de 4 escenas, comprobando que el porcentaje **nunca
retrocede** (hay una prueba automática que lo verifica):

```
creando-escenas         0/4    3.0%
buscando-visuales       1/4   10.3%   …   4/4   20.0%
generando-voz           1/4   26.8%   …   4/4   47.0%
renderizando-segmentos  1/4   62.0%   …   4/4   92.0%
concatenando            4/4  100.0%
listo                   4/4  100.0%
```

---

## 9. Contrato con el Orquestador KSL (preparado, no conectado)

`src/generation/orchestrator-contract.js`. **El repositorio del Orquestador no se
ha tocado.** Esto es sólo el lado receptor, para fijar y probar el contrato antes
de que exista el emisor.

`POST /api/video-generation/orchestrator` (con `dryRun: true` valida sin producir):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `projectId` | string | no |
| `brandId` | string | no (por defecto `personal`) |
| `title` | string | no |
| `prompt` | string | uno de los tres |
| `script` | string | uno de los tres |
| `sourceReference` | string u objeto | uno de los tres |
| `format` | `16:9` \| `9:16` \| `1:1` | no (por defecto `16:9`) |
| `targetDurationSeconds` | number | **no — es opcional** |
| `platform` | enum | no |
| `style` | enum | no |
| `voice` | `{provider, name, rate, enabled}` | no |
| `music` | `{path, volume, enabled}` | no |
| `subtitles` | `{enabled, burnIn, language}` | no |
| `logo` | `{path, position, scale, opacity}` | no |
| `course` | `{courseId, courseName, moduleId, moduleName, lessonNumber, tags[]}` | no |

`sourceReference` admite `{kind: 'drive', id, name, mimeType}` **y se guarda sin
resolverse**: `resolved: false` siempre. No se conecta con Drive, no se descarga
nada y no se guarda ninguna credencial en esta entrega.

---

## 10. Qué es opcional y qué funciona sin nada

Funciona **sin configurar nada**: guion (plantilla local), voz (SAPI de Windows),
visuales (fondos generados con FFmpeg), subtítulos (estimados), montaje (FFmpeg).
Coste cero.

Opcionales, y el proyecto sigue funcionando sin ellos:

- **Pexels** — si no hay `PEXELS_API_KEY` o no hay resultados, se cae a recursos
  locales y a fondos generados, claramente identificados como `placeholder`.
- **LLM** (Ollama, API compatible OpenAI, Gemini) — sólo afecta a la redacción
  desde prompt. Con un guion propio no interviene en absoluto.
- **Piper** — voz alternativa a SAPI.

La clave de Pexels **sólo se lee en el backend**. Hay una prueba que planta
valores centinela en el entorno y falla si aparecen en cualquier respuesta de la
API o en cualquier archivo de `src/ui/`. Las pruebas no llaman a ninguna API real.

---

## 11. Marca y logo

La marca es **configuración del proyecto**, no una constante del código. Se elige
por `brandId` (los JSON de `data/brands/`, incluido `personal.json`, que se
conserva). El logo viaja en el contrato como `{path, position, scale, opacity}` y,
si no se indica, se usa el de la marca. **No hay ningún logo concreto incrustado
en el código.**

---

## 12. Lo que sigue pendiente

Con honestidad, porque afecta al uso real:

1. **La estimación de duración se pasa por exceso en este equipo.** Con
   `NARRATION_WPM=115` se estimaron 23 min 48 s para un video que duró
   **16 min 39 s**: un **43 % de desvío**. La voz SAPI «Sabina» de esta máquina
   narra a **166 wpm**, no a 115 (misma cifra en la muestra de 6 escenas y en
   las 105, así que es estable). El valor es configurable con `NARRATION_WPM` o
   con el campo del editor, y el smoke **calcula la calibración** y dice qué
   número poner. **No se ha cambiado el valor por defecto** para no ajustarlo a
   una sola máquina y una sola voz: quien use Piper o una voz distinta tendrá
   otro número. La duración real siempre se mide con ffprobe; la estimación
   nunca se da por buena. Pendiente: calibrar automáticamente en el primer
   render y guardar el resultado por voz.
2. **El render completo es lento en esta CPU.** Las 105 escenas tardaron ~27
   minutos con 4 hilos; `npm run doctor` ya avisa de esa limitación. La caché
   por huella y la reanudación lo hacen soportable —regenerar una escena no
   vuelve a pagar las otras 104—, pero no lo hacen rápido.
3. **El análisis que sigue a la generación es el cuello de botella de un video
   largo, no el render.** El flujo encadena `generación → análisis → propuesta`,
   y el análisis de 16 min 39 s copia el original (46 MB) y transcodifica una
   previsualización (>53 MB): más de 100 MB en disco por proyecto y varios
   minutos de CPU, después de los ~27 del render. Para un video largo eso es
   trabajo que casi nunca se aprovecha, porque el montaje ya viene definido por
   las escenas del guion. Pendiente: saltarse el análisis —o limitarlo a
   `ffprobe`— cuando el video lo produjo el propio pipeline.
4. **La revisión escena a escena en la interfaz no está paginada.** 105 tarjetas
   se dibujan de una vez; se nota al desplazar.
5. **No hay reanudación automática tras reiniciar el servidor.** Se marca como
   recuperable y se ofrece el botón, pero no se retoma solo, a propósito: un
   proveedor de pago podría gastar créditos sin que nadie lo pida.
6. **`sourceReference` no se resuelve.** Drive queda fuera de esta entrega.
7. **Los subtítulos son estimados**, no transcritos. Whisper está declarado como
   opcional pero no se ha validado con guiones largos.
