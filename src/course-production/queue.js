import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = text => createHash('sha256').update(text).digest('hex');

export function validatePack(pack) {
  if (pack?.version !== '1.0.0' || !Array.isArray(pack.items) || !pack.items.length) throw new Error('Paquete de cursos inválido');
  const ids = new Set();
  for (const item of pack.items) {
    if (!/^[A-Z0-9-]+$/.test(item.id || '') || ids.has(item.id)) throw new Error('Identificador de guion inválido o repetido');
    ids.add(item.id);
    if (item.language !== 'en' || !item.script?.trim() || sha256(item.script) !== item.scriptSha256) throw new Error(`Guion o huella inválida: ${item.id}`);
    if (!Array.isArray(item.scenes) || item.scenes.map(s => s.text).join('\n\n') !== item.script) throw new Error(`Narración incompleta: ${item.id}`);
    if (!item.sources?.length || !item.course?.courseId) throw new Error(`Falta trazabilidad: ${item.id}`);
  }
  return pack;
}

/** Serial, durable queue. No HTTP, credentials, publication, or paid provider. */
export function createCourseQueue({ pack, stateFile, backend }) {
  validatePack(pack);
  let state = { version: 1, entries: {}, environment: null };
  if (fs.existsSync(stateFile)) {
    // Never overwrite unreadable state: it may contain already submitted jobs.
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.version !== 1 || !state.entries) throw new Error('Estado de producción incompatible');
  }
  let ticking = false;
  const save = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    state.updatedAt = new Date().toISOString();
    const tmp = `${stateFile}.partial`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  for (const item of pack.items) {
    const old = state.entries[item.id];
    if (!old) state.entries[item.id] = { status: 'pending', scriptSha256: item.scriptSha256, jobId: null };
    else if (old.scriptSha256 !== item.scriptSha256) {
      old.status = 'blocked'; old.error = 'El guion cambió después de registrar producción. Revisión técnica requerida; no se duplica el video.';
    }
  }
  save();
  const snapshot = () => ({
    ...state,
    entries: pack.items.map(item => ({ id: item.id, title: item.title, course: item.course, sources: item.sources,
      ...state.entries[item.id], publicationBlocked: true })),
  });
  async function tick() {
    if (ticking) return snapshot();
    ticking = true;
    try {
      const environment = await backend.preflight();
      state.environment = environment;
      // Read existing jobs even when a voice temporarily disappears.
      for (const item of pack.items) {
        const entry = state.entries[item.id];
        if (entry.status === 'submitting' && !entry.jobId) {
          const found = await backend.findJob(item.id, item.scriptSha256);
          if (found) { entry.jobId = found.id; entry.status = 'rendering'; }
          else { entry.status = 'blocked'; entry.error = 'Envío interrumpido sin confirmación. No se reenvía automáticamente para evitar duplicados.'; }
        }
        if (entry.status !== 'rendering') continue;
        const job = await backend.getJob(entry.jobId);
        if (!job) { entry.status = 'blocked'; entry.error = 'Trabajo registrado no encontrado. No se crea otro automáticamente.'; continue; }
        entry.progress = job.progreso || null;
        entry.projectId = job.projectId || null;
        if (job.status === 'completed') {
          const proof = await backend.verify(job, item);
          entry.status = proof.ok ? 'review_ready' : 'blocked';
          entry.error = proof.ok ? null : proof.reason;
          entry.proof = proof;
          entry.reviewUrl = proof.ok ? `/project-editor.html?id=${encodeURIComponent(job.projectId)}` : null;
          entry.videoUrl = proof.ok ? `/file?path=${encodeURIComponent(job.generation.file)}` : null;
          entry.warnings = job.warnings || [];
        } else if (job.status === 'failed') {
          if (environment.ok && job.projectId && job.provider?.id === 'pipeline' && (entry.retries || 0) < 2) {
            // Only this explicitly local/free queue resumes automatically.
            // Cache reuse preserves completed scenes. Never retry paid jobs.
            try {
              await backend.resumeJob(job.id);
              entry.retries = (entry.retries || 0) + 1;
              entry.error = null;
            } catch (error) {
              if (!backend.isBusy(error)) { entry.status = 'blocked'; entry.error = error.message; }
            }
          } else {
            entry.status = 'blocked'; entry.error = job.error || 'Producción interrumpida';
            entry.recoverable = Boolean(job.projectId);
          }
        }
      }
      save();
      if (!environment.ok || Object.values(state.entries).some(e => e.status === 'rendering')) return snapshot();
      const item = pack.items.find(i => state.entries[i.id].status === 'pending');
      if (!item) return snapshot();
      const entry = state.entries[item.id];
      // Persist intent BEFORE creating the job. Recover by the same source key.
      entry.status = 'submitting'; save();
      try {
        const job = await backend.submit(item, environment.voice);
        entry.jobId = job.id; entry.status = 'rendering'; entry.error = null;
      } catch (error) {
        // createJob rejects before side effects when another UI job is active.
        if (backend.isBusy(error)) entry.status = 'pending';
        else { entry.status = 'blocked'; entry.error = error.message; }
      }
      save();
      return snapshot();
    } finally { ticking = false; }
  }
  return { tick, snapshot };
}
