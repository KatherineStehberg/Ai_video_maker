import { mockProvider } from './mock.js';
import { pipelineProvider } from './pipeline.js';
import '../../config.js';

/**
 * Registro de proveedores de generación de video, desacoplado del resto.
 *
 * Hoy SÓLO el proveedor `mock` funciona: construye un video de prueba con
 * FFmpeg en local. Los demás son ranuras declaradas pero NO implementadas; al
 * invocarlas fallan con un mensaje que dice exactamente qué falta. No se simula
 * ninguna conexión con un servicio real.
 *
 * ---------------------------------------------------------------------------
 * CÓMO AÑADIR UN PROVEEDOR REAL
 * ---------------------------------------------------------------------------
 * 1. Crea `src/providers/video-generation/<nombre>.js` exportando un objeto con
 *    este contrato:
 *
 *      export const miProveedor = {
 *        id: 'mi-proveedor',
 *        label: 'Texto para la interfaz',
 *        mock: false,
 *        requires: ['MI_API_KEY'],              // variables de entorno
 *        configured: () => Boolean(process.env.MI_API_KEY),
 *        async generate(spec, { workDir, onProgress }) {
 *          // spec: { prompt, duration, format, style, music, tempo, audience, platform }
 *          // Descarga/renderiza el resultado DENTRO de workDir y devuelve:
 *          return { file: <ruta absoluta al mp4>, provider: 'mi-proveedor',
 *                   mock: false, model: '<modelo>', notes: [], usage: {...} };
 *        },
 *      };
 *
 * 2. Regístralo en PROVIDERS, más abajo.
 * 3. Declara su clave en `.env.example` y documéntala en el README.
 *
 * REGLAS QUE NO SE NEGOCIAN:
 *   · La clave vive SÓLO en el backend (process.env). Nunca se envía al
 *     frontend ni aparece en la respuesta de la API, en logs ni en errores.
 *   · `generate` escribe dentro de `workDir` y no toca nada fuera.
 *   · Si el proveedor es de pago, no reintentes en silencio: un reintento
 *     automático puede duplicar el gasto (misma regla que en Gemini).
 *   · Devuelve `mock: false` sólo si el video lo produjo de verdad ese servicio.
 * ---------------------------------------------------------------------------
 */

/** Crea una ranura declarada pero no implementada, con un error accionable. */
function ranuraPendiente({ id, label, requires, comoImplementar }) {
  return {
    id, label, mock: false, requires,
    configured: () => false,
    async generate() {
      throw new Error(
        `El proveedor "${id}" no está implementado todavía. ${comoImplementar} ` +
        `Mientras tanto, usa el proveedor "mock". Ver src/providers/video-generation/index.js.`
      );
    },
  };
}

export const PROVIDERS = {
  // Montaje local real: guion -> escenas -> visuales -> voz -> subtitulos -> FFmpeg.
  // Es el predeterminado porque produce un video cuyo contenido corresponde al
  // prompt, sin coste y sin salir del equipo.
  pipeline: pipelineProvider,

  // Mock de desarrollo: planos de color. Sirve para probar el flujo rapido en
  // los tests; NO debe presentarse como resultado final.
  mock: mockProvider,

  // Servicio externo de video generativo (HTTP). Sin implementación real.
  api: ranuraPendiente({
    id: 'api',
    label: 'Servicio externo de video generativo (no configurado)',
    requires: ['VIDEO_GEN_API_URL', 'VIDEO_GEN_API_KEY'],
    comoImplementar: 'Crea src/providers/video-generation/api.js siguiendo el contrato documentado en este archivo y regístralo aquí.',
  }),

  // Modelo de generación ejecutándose en este equipo. Sin implementación real.
  local: ranuraPendiente({
    id: 'local',
    label: 'Modelo generativo local (no configurado)',
    requires: ['VIDEO_GEN_LOCAL_BIN'],
    comoImplementar: 'Crea src/providers/video-generation/local.js que invoque el binario del modelo y devuelva el MP4 resultante.',
  }),
};

/**
 * Proveedor por defecto: el montaje local real, salvo que el entorno diga otro.
 *
 * Se lee en cada llamada, no al cargar el modulo: con una constante, cualquier
 * codigo que ajuste process.env despues de los imports (los tests y los smokes
 * lo hacen) quedaba ignorado en silencio.
 */
export const defaultProvider = () => process.env.VIDEO_GEN_PROVIDER || 'pipeline';

export function getProvider(name = defaultProvider()) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Proveedor de generación desconocido: ${name}. Disponibles: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}

/**
 * Vista pública para la interfaz. Expone disponibilidad y qué variables harían
 * falta, pero NUNCA su valor: aquí no puede filtrarse ninguna clave.
 */
export function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, label: p.label, mock: Boolean(p.mock),
    configured: p.configured(), requires: p.requires,
  }));
}
