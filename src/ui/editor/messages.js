/** Mensajes de estado, errores y advertencias. Una sola forma de hablarle al usuario. */
import { STATE_LABELS } from './state.js';

export function createMessages({ statusEl, stateEl, errorEl, warningsEl }) {
  return {
    /** Píldora de estado + línea de detalle. */
    setState(state, detail) {
      stateEl.textContent = STATE_LABELS[state] || state;
      stateEl.dataset.state = state;
      if (detail !== undefined) statusEl.textContent = detail || '';
    },

    setStatus(text) { statusEl.textContent = text || ''; },

    /** Un error siempre es visible y nunca se mezcla con el estado normal. */
    setError(message) {
      errorEl.hidden = !message;
      errorEl.textContent = message || '';
    },

    clearError() { errorEl.hidden = true; errorEl.textContent = ''; },

    /**
     * Advertencias del backend, tal cual. No se resumen ni se suavizan: si el
     * backend avisa de que el audio se estiró, eso se lee entero.
     */
    setWarnings(list) {
      warningsEl.replaceChildren();
      warningsEl.hidden = !list?.length;
      if (!list?.length) return;
      const title = document.createElement('h3');
      title.textContent = `Advertencias (${list.length})`;
      const ul = document.createElement('ul');
      for (const w of list) {
        const li = document.createElement('li');
        li.textContent = w;
        ul.append(li);
      }
      warningsEl.append(title, ul);
    },
  };
}
