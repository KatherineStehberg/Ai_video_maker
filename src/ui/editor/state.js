/**
 * Máquina de estados del flujo de edición. Sin DOM y sin red: se puede
 * importar en Node para testearla. La interfaz deriva de aquí qué mostrar y
 * qué botones habilitar; ninguna vista decide por su cuenta.
 */

export const STATES = ['listo', 'cargando', 'analizando', 'analisis-completado',
  'creando-propuesta', 'aprobacion-pendiente', 'aprobado', 'exportando', 'exportado', 'error'];

export const STATE_LABELS = {
  listo: 'Listo',
  cargando: 'Cargando archivo',
  analizando: 'Analizando',
  'analisis-completado': 'Análisis completado',
  'creando-propuesta': 'Creando propuesta',
  'aprobacion-pendiente': 'Aprobación pendiente',
  aprobado: 'Aprobado',
  exportando: 'Exportando con FFmpeg',
  exportado: 'Exportado',
  error: 'Error',
};

export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;   // mismo límite que el backend

/**
 * Valida el archivo antes de gastar ancho de banda o tiempo del backend.
 * Devuelve {ok, error} en lugar de lanzar: la vista muestra el motivo.
 */
export function validateFile(file) {
  if (!file) return { ok: false, error: 'Selecciona un archivo de video.' };
  if (!file.size) return { ok: false, error: 'El archivo está vacío.' };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `El archivo pesa ${formatBytes(file.size)} y el límite es 2 GiB.` };
  }
  const name = String(file.name || '');
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  const byType = typeof file.type === 'string' && file.type.startsWith('video/');
  const byExtension = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'].includes(extension);
  if (!byType && !byExtension) {
    return { ok: false, error: 'Formato no admitido. Selecciona un MP4 u otro archivo de video.' };
  }
  return { ok: true, error: null };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Estado inicial. `file` es el descriptor del archivo elegido, no su contenido. */
export function initialState() {
  return {
    state: 'listo', message: null, error: null, progress: 0, stage: null,
    file: null, analysisId: null, analysis: null,
    proposal: null, exportResult: null, busy: false,
  };
}

/**
 * Aplica una transición. Devuelve SIEMPRE un objeto nuevo para que la vista
 * pueda comparar referencias; nunca muta el estado recibido.
 */
export function reduce(current, action) {
  const next = { ...current };
  switch (action.type) {
    case 'file-selected': {
      const check = validateFile(action.file);
      return { ...initialState(), file: action.file, state: check.ok ? 'listo' : 'error', error: check.ok ? null : check.error };
    }
    case 'upload-start':
      return { ...next, state: 'cargando', progress: 0, error: null, busy: true, analysis: null, proposal: null, exportResult: null };
    case 'upload-progress':
      return { ...next, state: 'cargando', progress: action.percent };
    case 'analysis-start':
      return { ...next, state: 'analizando', analysisId: action.id, progress: 0, busy: true };
    case 'analysis-progress':
      return { ...next, state: 'analizando', progress: action.progress ?? next.progress, stage: action.stage ?? next.stage };
    case 'analysis-complete':
      return { ...next, state: 'analisis-completado', analysis: action.analysis, progress: 100, stage: null, busy: false, error: null };
    case 'proposal-start':
      return { ...next, state: 'creando-propuesta', busy: true, error: null, exportResult: null };
    case 'proposal-ready': {
      const proposal = action.proposal;
      const approved = !proposal.approvalRequired || proposal.approval?.status === 'aprobada';
      return { ...next, state: approved ? 'aprobado' : 'aprobacion-pendiente', proposal, busy: false, error: null };
    }
    case 'approved':
      return { ...next, state: 'aprobado', proposal: action.proposal, busy: false, error: null };
    case 'export-start':
      return { ...next, state: 'exportando', busy: true, error: null };
    case 'export-complete':
      return { ...next, state: 'exportado', exportResult: action.result, busy: false, error: null,
        proposal: next.proposal ? { ...next.proposal, syncStatus: action.result.syncStatus ?? next.proposal.syncStatus } : next.proposal };
    case 'error':
      return { ...next, state: 'error', error: action.error, busy: false };
    case 'reset':
      return initialState();
    default:
      return next;
  }
}

/** ¿Se puede lanzar un análisis? Requiere archivo válido y nada en curso. */
export function canAnalyze(s) {
  return !s.busy && validateFile(s.file).ok;
}

/** ¿Se puede crear una propuesta? Requiere un análisis completo. */
export function canPropose(s) {
  return !s.busy && Boolean(s.analysisId) && s.analysis?.status === 'complete';
}

export function canApprove(s) {
  return !s.busy && Boolean(s.proposal) && s.proposal.approvalRequired === true
    && s.proposal.approval?.status !== 'aprobada';
}

/**
 * Regla única de habilitación de la exportación. Bloquea si no hay propuesta,
 * si no está aprobada, si el análisis falló, si el archivo no es válido o si
 * ya hay una exportación en curso (evita dos exportaciones simultáneas).
 */
export function canExport(s) {
  if (s.busy || s.state === 'exportando') return false;
  if (!s.proposal) return false;
  if (s.proposal.approvalRequired && s.proposal.approval?.status !== 'aprobada') return false;
  if (!s.analysis || s.analysis.status !== 'complete') return false;
  if (!validateFile(s.file).ok) return false;
  return true;
}

/** Motivo legible por el que la exportación está bloqueada, o null si no lo está. */
export function exportBlockedReason(s) {
  if (canExport(s)) return null;
  if (s.state === 'exportando') return 'Exportación en curso.';
  if (s.busy) return 'Hay una operación en curso.';
  if (!s.analysis || s.analysis.status !== 'complete') return 'Primero analiza un video.';
  if (!s.proposal) return 'Primero crea una propuesta de edición.';
  if (s.proposal.approvalRequired && s.proposal.approval?.status !== 'aprobada') return 'La propuesta debe aprobarse antes de exportar.';
  return 'No se puede exportar todavía.';
}
