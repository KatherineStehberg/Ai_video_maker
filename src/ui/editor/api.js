/**
 * Cliente de la API local. Sin DOM salvo la subida con XHR (que se inyecta),
 * de modo que el resto se puede testear en Node pasando un `fetchImpl`.
 *
 * Los endpoints reales son /api/analysis y /api/video-edits. No existe
 * /api/video-jobs; si alguna documentación lo menciona, está desactualizada.
 */

const ENDPOINTS = {
  analysisConfig: '/api/analysis/config',
  analysis: '/api/analysis',
  edits: '/api/video-edits',
  generationConfig: '/api/video-generation/config',
  generationJobs: '/api/video-generation/jobs',
};

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

/** Lee la respuesta y convierte cualquier fallo en un ApiError con mensaje del backend. */
async function unwrap(response) {
  let body = null;
  try { body = await response.json(); } catch { /* respuesta sin cuerpo JSON */ }
  if (!response.ok) {
    throw new ApiError(body?.error || `Error HTTP ${response.status}`, response.status);
  }
  return body;
}

export function createApi({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  const call = (path, init) => fetchImpl(baseUrl + path, init).then(unwrap);

  return {
    endpoints: ENDPOINTS,

    /** Disponibilidad de Gemini. Nunca devuelve la clave: sólo `hasKey`. */
    analysisConfig: () => call(ENDPOINTS.analysisConfig),

    getAnalysis: (id) => call(`${ENDPOINTS.analysis}/${encodeURIComponent(id)}`),

    analysisJsonUrl: (id) => `${baseUrl}${ENDPOINTS.analysis}/${encodeURIComponent(id)}/export`,
    analysisCsvUrl: (id) => `${baseUrl}${ENDPOINTS.analysis}/${encodeURIComponent(id)}/export?format=csv`,
    previewUrl: (id) => `${baseUrl}${ENDPOINTS.analysis}/${encodeURIComponent(id)}/preview`,

    createProposal: (body) => call(ENDPOINTS.edits, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),

    getProposal: (id) => call(`${ENDPOINTS.edits}/${encodeURIComponent(id)}`),

    /**
     * Guarda los segmentos editados. El backend recalcula la línea de salida,
     * invalida la aprobación y descarta el informe de exportación anterior.
     */
    updateSegments: (id, segments) => call(`${ENDPOINTS.edits}/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ segments }),
    }),

    approveProposal: (id, by) => call(`${ENDPOINTS.edits}/${encodeURIComponent(id)}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, by }),
    }),

    exportProposal: (id, fit = 'pad') => call(`${ENDPOINTS.edits}/${encodeURIComponent(id)}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fit }),
    }),

    exportedFileUrl: (id) => `${baseUrl}${ENDPOINTS.edits}/${encodeURIComponent(id)}/file`,

    // ---- Generación de video con IA ------------------------------------
    /** Proveedores, formatos y estilos. Nunca devuelve claves: sólo `configured`. */
    generationConfig: () => call(ENDPOINTS.generationConfig),

    createGeneration: (body) => call(ENDPOINTS.generationJobs, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),

    getGeneration: (id) => call(`${ENDPOINTS.generationJobs}/${encodeURIComponent(id)}`),
  };
}

/**
 * Sube el video con XHR para poder informar del progreso real de la subida.
 * `XHR` se inyecta para poder probarlo sin navegador.
 */
export function uploadVideo(file, { onProgress, XHR = globalThis.XMLHttpRequest, baseUrl = '' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XHR();
    xhr.open('POST', `${baseUrl}${ENDPOINTS.analysis}`);
    xhr.setRequestHeader('x-analysis-upload', '1');   // exigido por el backend
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
    }
    xhr.onerror = () => reject(new ApiError('Error de conexión durante la subida', 0));
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
      if (xhr.status !== 202) return reject(new ApiError(body?.error || `Error HTTP ${xhr.status}`, xhr.status));
      resolve(body);
    };
    xhr.send(file);
  });
}

/**
 * Sondeo con control de duplicados: `stop()` cancela y el temporizador nunca
 * encadena dos peticiones a la vez porque espera a que la anterior resuelva.
 */
export function poll(fetchOnce, { intervalMs = 900, isDone, onTick, onError } = {}) {
  let cancelled = false, timer = null, inFlight = false;
  const stop = () => { cancelled = true; if (timer) clearTimeout(timer); timer = null; };

  const done = new Promise((resolve, reject) => {
    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const value = await fetchOnce();
        inFlight = false;
        if (cancelled) return;
        if (onTick) onTick(value);
        if (isDone(value)) { stop(); return resolve(value); }
        timer = setTimeout(tick, intervalMs);
      } catch (e) {
        inFlight = false;
        if (cancelled) return;
        if (onError) onError(e);
        stop(); reject(e);
      }
    };
    tick();
  });

  return { done, stop, get running() { return !cancelled; } };
}
