/** Reproductores HTML5 del original (previsualización) y del MP4 exportado. */

export function createPlayer(video, { emptyEl } = {}) {
  return {
    load(url) {
      if (!url) return this.clear();
      if (video.getAttribute('src') !== url) video.src = url;
      video.hidden = false;
      if (emptyEl) emptyEl.hidden = true;
    },
    clear() {
      video.removeAttribute('src');
      video.load?.();
      video.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
    },
    /** Sitúa la cabeza lectora en un instante y pausa, para inspeccionar un corte. */
    seek(seconds) {
      if (video.hidden || !video.getAttribute('src')) return;
      video.currentTime = seconds;
      video.pause();
    },
  };
}
