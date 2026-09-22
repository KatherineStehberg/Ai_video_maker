/**
 * Cliente del editor. Todo lo que habla con el backend vive aqui.
 *
 * Las escrituras llevan `x-editor-request: 1`, que es lo que el servidor exige
 * para que una pagina de otro origen no pueda dispararlas desde el navegador.
 */

const BASE = '/api/project-editor';

export class ApiError extends Error {
  constructor(mensaje, status) { super(mensaje); this.name = 'ApiError'; this.status = status; }
}

async function pedir(ruta, { method = 'GET', body = null } = {}) {
  const cabeceras = {};
  if (method !== 'GET') { cabeceras['content-type'] = 'application/json'; cabeceras['x-editor-request'] = '1'; }

  let res;
  try {
    res = await fetch(BASE + ruta, { method, headers: cabeceras, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    // Un fetch que ni sale de la maquina suele ser el servidor caido: decirlo
    // asi ahorra buscar el fallo en el proyecto.
    throw new ApiError(`No se pudo contactar con el servidor local (${e.message}). ¿Sigue corriendo "npm start"?`, 0);
  }

  const texto = await res.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* respuesta no JSON */ }
  if (!res.ok) throw new ApiError(datos?.error || `Error ${res.status}`, res.status);
  return datos;
}

export const api = {
  config: () => pedir('/config'),
  proyectos: () => pedir('/projects'),
  proyecto: id => pedir(`/projects/${encodeURIComponent(id)}`),
  guardar: (id, cuerpo) => pedir(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: cuerpo }),
  trabajo: id => pedir(`/projects/${encodeURIComponent(id)}/job`),
  regenerar: (id, cuerpo) => pedir(`/projects/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: cuerpo }),
  exportar: id => pedir(`/projects/${encodeURIComponent(id)}/export`, { method: 'POST', body: {} }),
  // Biblioteca de recursos. Solo terminos de busqueda e identificadores: la
  // descarga la decide y la hace el backend.
  buscarImagenes: (q, aspecto, pagina = 1, idioma = 'es') =>
    pedir(`/library/images?q=${encodeURIComponent(q)}&aspecto=${encodeURIComponent(aspecto || '9:16')}&pagina=${pagina}&idioma=${encodeURIComponent(idioma)}`),
  importarImagen: (id, consulta) => pedir('/library/images/import', { method: 'POST', body: { id, consulta } }),
  musica: (q = '', maxDuracion = '') =>
    pedir(`/library/music?q=${encodeURIComponent(q)}&maxDuracion=${encodeURIComponent(maxDuracion)}`),
  efectos: (q = '', categoria = '') =>
    pedir(`/library/sfx?q=${encodeURIComponent(q)}&categoria=${encodeURIComponent(categoria)}`),
  onda: (id, pista, muestras = 600) =>
    pedir(`/projects/${encodeURIComponent(id)}/waveform?pista=${encodeURIComponent(pista)}&muestras=${muestras}`),
};

/**
 * Sondea un trabajo largo hasta que termina.
 * No solapa peticiones: espera a la respuesta antes de pedir la siguiente.
 */
export function sondear(id, { intervaloMs = 900, onTick } = {}) {
  let vivo = true;
  const done = (async () => {
    for (;;) {
      if (!vivo) return null;
      const r = await api.trabajo(id);
      onTick?.(r);
      const estado = r?.job?.status;
      if (estado !== 'running') return r;
      await new Promise(res => setTimeout(res, intervaloMs));
    }
  })();
  return { done, parar() { vivo = false; } };
}
