/**
 * AUDIO DE LA VISTA PREVIA
 *
 * Antes no habia: el boton Play solo avanzaba un reloj de JavaScript, y ni la
 * voz ni la musica se cargaban nunca. La vista previa era muda por diseño,
 * aunque el MP4 exportado si tenia sonido.
 *
 * COMO SUENA AHORA
 *   Vista aproximada  la voz de la escena en curso (su WAV propio) y, si la
 *                     hay, la musica en bucle. Se usa el WAV de cada escena y
 *                     no la pista montada porque esta solo se rehace al
 *                     exportar: tras excluir una escena quedaria desfasada.
 *   MP4 exportado     el propio <video>, con su pista de audio.
 *
 * El volumen de ESCUCHA (el del reproductor) es de quien escucha y no se
 * guarda. La ganancia de la NARRACION (`voice.gain`) si es del proyecto y se
 * aplica igual que en el render, tambien por encima del 100 %, con Web Audio.
 *
 * Nada suena solo: el audio arranca unicamente al pulsar Play.
 *
 * Las funciones puras de arriba no tocan el DOM y se prueban en Node.
 */

/** Diferencia tolerada entre el reloj del editor y el audio antes de corregir. */
export const TOLERANCIA_SEG = 0.3;

/**
 * Que tiene que sonar en el instante `t`: la escena, el archivo y en que
 * segundo de ese archivo. `null` si en ese instante no hay voz.
 */
export function vozEn(escenas, t) {
  for (const e of escenas || []) {
    if (e.excluida) continue;
    if (t >= e.start && t < e.end) {
      if (!e.narracion?.url) return { index: e.index, url: null, offset: 0, start: e.start };
      return { index: e.index, url: e.narracion.url, offset: Math.max(0, t - e.start), start: e.start };
    }
  }
  return null;
}

/** Ganancia efectiva de la narracion, con los mismos limites que el render. */
export function gananciaVoz(proyecto) {
  if (proyecto?.voice?.enabled === false) return 0;
  const g = Number(proyecto?.voice?.gain ?? 1);
  return Number.isFinite(g) ? Math.min(2, Math.max(0, g)) : 1;
}

/**
 * Aviso de audio para la barra del reproductor, calculado sobre el proyecto
 * VISIBLE (con los cambios sin guardar), para que silenciar la voz se refleje
 * al instante y no solo tras guardar.
 */
export function avisoAudio(proyecto, derivado) {
  const a = derivado?.audio;
  if (!a) return null;
  const conVoz = a.narracion?.escenasConVoz || 0;
  const musica = Boolean(proyecto?.music?.path && proyecto?.music?.enabled !== false);
  if (!conVoz && !musica) return { tono: 'aviso', texto: 'Sin audio' , detalle: 'Este proyecto no tiene narración generada ni música.' };
  if (conVoz && proyecto?.voice?.enabled === false) return { tono: 'aviso', texto: 'Voz silenciada', detalle: 'La narración está silenciada: el video se exportará sin voz.' };
  if (conVoz && gananciaVoz(proyecto) <= 0) return { tono: 'aviso', texto: 'Voz al 0 %', detalle: 'El volumen de la narración está al 0 %: se exportará en silencio.' };
  if (a.aviso) return { tono: 'aviso', texto: 'Voz incompleta', detalle: a.aviso };
  return null;
}

/**
 * Controlador del audio. Recibe los elementos y el reloj; no decide cuando
 * reproducir: eso lo hace main.js al pulsar Play.
 *
 *   voz     <audio> para la narracion de la escena en curso
 *   musica  <audio> para la musica, en bucle
 *   video   <video> del MP4 exportado
 */
export function crearAudio({ voz, musica, video }) {
  let ctx = null;
  let nodoVoz = null;
  let escucha = 1;          // volumen del reproductor, 0..1
  let ganancia = 1;         // voice.gain del proyecto, 0..2
  let volMusica = 0.12;
  let sonando = false;

  // Web Audio solo se crea al primer Play: los navegadores no dejan arrancar
  // un AudioContext sin un gesto de la persona, y asi ademas no se consume
  // nada mientras nadie escucha.
  function prepararGrafo() {
    if (ctx || typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      nodoVoz = ctx.createGain();
      ctx.createMediaElementSource(voz).connect(nodoVoz);
      nodoVoz.connect(ctx.destination);
    } catch { ctx = null; nodoVoz = null; }
  }

  function aplicarVolumenes() {
    const g = ganancia * escucha;
    if (nodoVoz) { nodoVoz.gain.value = g; voz.volume = 1; }
    else voz.volume = Math.min(1, g);          // sin Web Audio no se puede pasar de 1
    musica.volume = Math.min(1, volMusica * escucha);
    video.volume = escucha;
    // NUNCA se fuerza `muted`. Silenciar es volumen 0 y se ve en la interfaz.
    voz.muted = false; musica.muted = false; video.muted = false;
  }

  function cargar(el, url) {
    if (!url) { if (el.getAttribute('src')) { el.pause(); el.removeAttribute('src'); el.load(); } return false; }
    if (el.getAttribute('src') !== url) { el.src = url; }
    return true;
  }

  const seguro = p => p?.catch?.(() => {});

  /** Carga la voz de una escena y la pone a sonar en el segundo indicado. */
  function colocar(objetivo) {
    if (!objetivo?.url) { voz.pause(); return; }
    cargar(voz, objetivo.url);
    const poner = () => {
      try { voz.currentTime = objetivo.offset; } catch { /* sin metadatos todavia */ }
      if (sonando && !(voz.duration && objetivo.offset >= voz.duration - 0.05)) seguro(voz.play());
    };
    if (voz.readyState >= 1) poner(); else voz.addEventListener('loadedmetadata', poner, { once: true });
  }

  return {
    /** Datos del analizador para pruebas: si está sonando algo de verdad. */
    get contexto() { return ctx; },
    get nodoVoz() { return nodoVoz; },

    configurar({ proyecto, derivado }) {
      ganancia = gananciaVoz(proyecto);
      // La musica se toma del proyecto VISIBLE (con cambios sin guardar):
      // elegir una pista tiene que sonar ya en la vista previa.
      const ruta = proyecto?.music?.path || null;
      volMusica = Number(proyecto?.music?.volume ?? derivado?.audio?.musica?.volumen ?? 0.12);
      const musicaActiva = Boolean(ruta && proyecto?.music?.enabled !== false);
      cargar(musica, musicaActiva ? `/file?path=${encodeURIComponent(ruta)}` : null);
      aplicarVolumenes();
    },

    volumenEscucha(v) { escucha = Math.min(1, Math.max(0, Number(v) || 0)); aplicarVolumenes(); },

    /** Arranca el sonido. Solo se llama desde el boton Play. */
    async empezar({ modo, escenas, t }) {
      sonando = true;
      prepararGrafo();
      if (ctx?.state === 'suspended') await seguro(ctx.resume());
      aplicarVolumenes();
      if (modo === 'mp4') {
        voz.pause(); musica.pause();
        if (Math.abs(video.currentTime - t) > TOLERANCIA_SEG) video.currentTime = t;
        await seguro(video.play());
        return;
      }
      video.pause();
      // Al pulsar Play se coloca la voz en el segundo exacto, aunque sea la
      // misma escena que antes: Play siempre empieza donde esta el cabezal.
      colocar(vozEn(escenas, t));
      if (musica.getAttribute('src')) {
        musica.loop = true;
        if (musica.duration) musica.currentTime = t % musica.duration;
        seguro(musica.play());
      }
    },

    parar() {
      sonando = false;
      voz.pause(); musica.pause(); video.pause();
    },

    /**
     * Se llama en cada tic del reloj con el tiempo PROVISIONAL del editor.
     *
     * Mientras la voz de la escena suena, EL AUDIO MANDA: devuelve su tiempo
     * y el editor lo adopta. Si fuese al reves (el reloj mandando y la voz
     * reposicionandose para seguirlo), cada pequeno retraso del audio
     * provocaba un salto y la voz se oia entrecortada.
     *
     * Devuelve null cuando no hay voz sonando (escena sin voz, o la pausa al
     * final de la escena): entonces el reloj del editor sigue por su cuenta.
     */
    sincronizar({ escenas, t }) {
      if (!sonando) return null;
      const objetivo = vozEn(escenas, t);
      if (!objetivo?.url) { if (!voz.paused) voz.pause(); return null; }

      if (voz.getAttribute('src') !== objetivo.url) {
        // Cambio de escena: se carga su voz y se empieza donde toca.
        colocar(objetivo);
        return null;
      }
      if (!voz.paused && !voz.ended) return objetivo.start + voz.currentTime;
      // Callada en la misma escena: o ya dijo todo (pausa final) o aun carga.
      if (voz.ended || (voz.duration && objetivo.offset >= voz.duration - 0.05)) return null;
      if (voz.paused) seguro(voz.play());
      return null;
    },

    /** Tiempo del <video> cuando manda el MP4. */
    tiempoVideo() { return video.paused ? null : video.currentTime; },
  };
}
