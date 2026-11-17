/**
 * Genera pistas instrumentales ORIGINALES sintetizadas muestra a muestra.
 *
 * generar-musica-local.mjs sólo suma tonos sostenidos; aquí cada instrumento se
 * modela (cuerdas de piano con armónicos que se apagan, membranas de tambor
 * con caída de tono, ruido filtrado para el shaker, láminas de marimba) y se
 * compone una pieza con progresión de acordes, acompañamiento y melodía.
 * Las melodías salen de un generador con semilla fija: son originales y la
 * pista sale idéntica en cada ejecución. No hay samples ni obras de terceros,
 * así que se publican como CC0.
 *
 * Uso:
 *   node scripts/generar-musica-instrumentos.mjs            # genera lo que falte
 *   node scripts/generar-musica-instrumentos.mjs --forzar   # regenera todo
 *
 * data/assets/ está en .gitignore: los MP3 se regeneran con este script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegRun } from '../src/lib/ffmpeg.js';
import { PATHS, ensureDir } from '../src/lib/paths.js';

const SR = 44100;
const TAU = Math.PI * 2;
const midi = m => 440 * 2 ** ((m - 69) / 12);

const LICENCIA = {
  licencia: 'CC0 1.0 (dominio público)',
  licenciaUrl: 'https://creativecommons.org/publicdomain/zero/1.0/deed.es',
  fuente: 'Compuesta y sintetizada localmente por AI Video Maker (scripts/generar-musica-instrumentos.mjs): instrumentos modelados por código y melodías originales generadas con semilla fija. Sin samples ni obras de terceros.',
  autor: 'AI Video Maker (síntesis procedural)',
  atribucion: null,
  requiereAtribucion: false,
};

/** Aleatorio reproducible (mulberry32). */
function azar(semilla) {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Mezcla {
  constructor(segundos) {
    this.n = Math.ceil(segundos * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  /** Escribe una voz ya calculada en la posición t (s), con paneo -1..1. */
  poner(t, muestras, pan = 0) {
    const i0 = Math.round(t * SR);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let k = 0; k < muestras.length; k++) {
      const i = i0 + k;
      if (i < 0) continue;
      if (i >= this.n) break;
      this.L[i] += muestras[k] * gl;
      this.R[i] += muestras[k] * gr;
    }
  }
  wav(destino) {
    let pico = 1e-9;
    for (let i = 0; i < this.n; i++) pico = Math.max(pico, Math.abs(this.L[i]), Math.abs(this.R[i]));
    const g = 0.89 / pico;
    const buf = Buffer.alloc(44 + this.n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + this.n * 4, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(this.n * 4, 40);
    for (let i = 0; i < this.n; i++) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, this.L[i] * g)) * 32767), 44 + i * 4);
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, this.R[i] * g)) * 32767), 46 + i * 4);
    }
    fs.writeFileSync(destino, buf);
  }
}

// ───────────────────────── Instrumentos ─────────────────────────

const cachePiano = new Map();
/** Nota de piano: dos cuerdas algo desafinadas, armónicos inarmónicos que se apagan antes cuanto más agudos. */
function piano(m, vel, dur = 4) {
  const clave = `${m}|${dur}`;
  let base = cachePiano.get(clave);
  if (!base) {
    const f = midi(m), N = Math.round(dur * SR), B = 0.00035;
    base = new Float32Array(N);
    const brillo = Math.min(1.3, (262 / f) ** 0.35);
    for (let n = 1; n <= 12; n++) {
      const fn = f * n * Math.sqrt(1 + B * n * n);
      if (fn > SR / 2.3) break;
      const a = 1 / n ** 1.7 * (n === 1 ? 1 : brillo);
      const d1 = (0.9 + 0.55 * n) * Math.sqrt(f / 262), d2 = d1 * 0.25;
      for (const det of [1, 1.0011]) {
        const w = TAU * fn * det / SR;
        for (let k = 0; k < N; k++) {
          const t = k / SR;
          // Caída en dos tramos: golpe que se apaga rápido y resonancia larga.
          base[k] += a * (0.7 * Math.exp(-d1 * t) + 0.3 * Math.exp(-d2 * t)) * Math.sin(w * k);
        }
      }
    }
    const ataque = 0.003 * SR, rel = 0.25 * SR;
    for (let k = 0; k < N; k++) {
      if (k < ataque) base[k] *= k / ataque;
      if (k > N - rel) base[k] *= (N - k) / rel;
    }
    cachePiano.set(clave, base);
  }
  return base.map(v => v * vel);
}

/** Membrana: seno cuyo tono cae de f0 a f1, más un golpe de ruido filtrado. */
function membrana({ f0, f1, caida, decay, ruido = 0, ruidoDecay = 40, pasoAlto = 0.6, dur = 0.6 }, vel, r) {
  const N = Math.round(dur * SR), out = new Float32Array(N);
  let fase = 0, yb = 0, xa = 0;
  for (let k = 0; k < N; k++) {
    const t = k / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / caida);
    fase += TAU * f / SR;
    let s = Math.sin(fase) * Math.exp(-decay * t);
    if (ruido) {
      const x = r() * 2 - 1;
      yb = pasoAlto * (yb + x - xa); xa = x; // paso alto de un polo
      s += ruido * yb * Math.exp(-ruidoDecay * t);
    }
    out[k] = s * vel * Math.min(1, k / 20);
  }
  return out;
}

const djembeGrave = (v, r) => membrana({ f0: 120, f1: 72, caida: 0.03, decay: 9, ruido: 0.15, ruidoDecay: 60, dur: 0.5 }, v, r);
const djembeTono = (v, r) => membrana({ f0: 360, f1: 310, caida: 0.01, decay: 16, ruido: 0.35, ruidoDecay: 45, dur: 0.35 }, v, r);
const djembeSlap = (v, r) => membrana({ f0: 560, f1: 480, caida: 0.005, decay: 32, ruido: 0.55, ruidoDecay: 55, pasoAlto: 0.7, dur: 0.25 }, v, r);
const dundun = (v, r) => membrana({ f0: 78, f1: 52, caida: 0.06, decay: 5, ruido: 0.1, ruidoDecay: 50, dur: 0.9 }, v, r);

/** Campana de hierro (tipo agogó): parciales inarmónicos breves. */
function campana(f, vel) {
  const N = Math.round(0.4 * SR), out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = k / SR;
    out[k] = vel * Math.min(1, k / 30) * (
      Math.sin(TAU * f * t) * Math.exp(-14 * t) +
      0.5 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-22 * t) +
      0.25 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-35 * t));
  }
  return out;
}

/** Shaker: ruido agudo con envolvente corta. */
function shaker(vel, r) {
  const N = Math.round(0.09 * SR), out = new Float32Array(N);
  let y = 0, xa = 0, y2 = 0, xa2 = 0;
  for (let k = 0; k < N; k++) {
    const t = k / SR, x = r() * 2 - 1;
    y = 0.92 * (y + x - xa); xa = x;
    y2 = 0.92 * (y2 + y - xa2); xa2 = y;
    const env = Math.min(1, t / 0.012) * Math.exp(-45 * t);
    out[k] = y2 * env * vel;
  }
  return out;
}

/** Lámina de marimba: fundamental cálida y parcial 4× que se apaga en seguida. */
function marimba(m, vel) {
  const f = midi(m), N = Math.round(1.2 * SR), out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = k / SR;
    out[k] = vel * Math.min(1, k / 40) * (
      Math.sin(TAU * f * t) * Math.exp(-4.5 * t) +
      0.35 * Math.sin(TAU * f * 3.93 * t) * Math.exp(-16 * t) +
      0.12 * Math.sin(TAU * f * 9.2 * t) * Math.exp(-40 * t));
  }
  return out;
}

/** Bajo pulsado redondo. */
function bajo(m, vel, dur) {
  const f = midi(m), N = Math.round((dur + 0.15) * SR), out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = k / SR;
    const env = Math.min(1, k / 80) * Math.exp(-2.2 * t) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.15) : 1);
    out[k] = vel * env * (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * 2 * f * t) + 0.1 * Math.sin(TAU * 3 * f * t));
  }
  return out;
}

// ───────────────────────── Composiciones ─────────────────────────

/** Piano armónico: acordes de séptima y novena arpegiados, melodía lenta encima. */
function componerPiano(segundos) {
  const r = azar(20261108);
  const mez = new Mezcla(segundos + 6);
  const negra = 60 / 70, compas = negra * 4;
  const A = [ // Cmaj9 · Am9 · Fmaj9 · Gsus4→G
    { bajo: 36, acorde: [55, 59, 62, 64], escala: [64, 67, 71, 72, 74, 76] },
    { bajo: 33, acorde: [52, 55, 59, 60], escala: [64, 67, 69, 71, 72, 76] },
    { bajo: 29, acorde: [57, 60, 64, 67], escala: [64, 65, 67, 69, 72, 76] },
    { bajo: 31, acorde: [55, 60, 62, 67], escala: [62, 67, 71, 72, 74, 79] },
  ];
  const Bp = [ // Am9 · Fmaj9 · Cmaj9/E · Gsus
    A[1], A[2], { bajo: 40, acorde: [55, 59, 62, 64], escala: [64, 67, 71, 72, 76, 79] }, A[3],
  ];
  const compases = Math.floor(segundos / compas);
  let nota = 72;
  const humano = () => (r() - 0.5) * 0.016;
  for (let c = 0; c < compases; c++) {
    const parte = Math.floor(c / 8) % 4; // A A' B A
    const ch = (parte === 2 ? Bp : A)[c % 4];
    const t0 = c * compas;
    const final = c >= compases - 2;
    // Mano izquierda: bajo en octava y arpegio en corcheas.
    mez.poner(t0 + humano(), piano(ch.bajo, 0.55, 5), -0.25);
    mez.poner(t0 + humano(), piano(ch.bajo + 12, 0.28, 5), -0.2);
    if (final) {
      ch.acorde.forEach((m, i) => mez.poner(t0 + i * 0.06, piano(m, 0.32, 6), -0.1 + i * 0.1));
      continue;
    }
    const orden = [0, 1, 2, 3, 2, 1, 2, 1];
    for (let e = 1; e < 8; e++) {
      const m = ch.acorde[orden[e]];
      mez.poner(t0 + e * negra / 2 + humano(), piano(m, 0.17 + 0.05 * (e % 2 === 0) + r() * 0.03, 3), -0.15 + orden[e] * 0.08);
    }
    // Mano derecha: entra en el compás 4 y descansa en el último tramo.
    if (c < 4 || c >= compases - 6 && c % 2) continue;
    const ritmos = [[0, 2, 3], [0, 1.5, 2, 3], [0, 3], [0, 1, 2], [0.5, 2, 3.5]];
    const ritmo = ritmos[Math.floor(r() * ritmos.length)];
    ritmo.forEach((pulso, i) => {
      // Paso pequeño desde la nota anterior; en el pulso fuerte, nota del acorde.
      const opciones = pulso === 0 ? ch.acorde.map(x => x + 12) : ch.escala;
      const cercanas = opciones.filter(x => Math.abs(x - nota) <= 5);
      nota = (cercanas.length ? cercanas : opciones)[Math.floor(r() * (cercanas.length || opciones.length))];
      const dur = (ritmo[i + 1] ?? 4) - pulso;
      mez.poner(t0 + pulso * negra + humano(), piano(nota, 0.36 + r() * 0.06, Math.max(2, dur * negra + 1.5)), 0.2);
    });
  }
  return mez;
}

/** Tambores africanos festivos: djembé, dundún, campana, shaker, marimba y bajo. */
function componerTambores(segundos) {
  const r = azar(1108);
  const mez = new Mezcla(segundos + 3);
  const negra = 60 / 112, s16 = negra / 4, compas = negra * 4;
  const compases = Math.floor(segundos / compas);
  const jit = () => (r() - 0.5) * 0.008;
  // Patrones de 16 semicorcheas. B grave, T tono, S slap.
  const djembe = 'B..TT.S.B.TTS.T.';
  const djembeRelleno = 'S.SSTTS.SSTTSSSS';
  const campanaPat = [0, 3, 6, 10, 12];
  const dundunPat = [0, 6, 10];
  // I · IV · V · I en Do, dos compases por acorde en el estribillo.
  const acordes = [
    { raiz: 36, notas: [60, 64, 67, 72, 76] },
    { raiz: 41, notas: [60, 65, 69, 72, 77] },
    { raiz: 43, notas: [62, 67, 71, 74, 79] },
    { raiz: 36, notas: [60, 64, 67, 72, 76] },
  ];
  const penta = [60, 62, 64, 67, 69, 72, 74, 76, 79];
  // Dos motivos rítmicos originales (pregunta y respuesta) que se reutilizan con notas nuevas.
  const motivos = [[0, 3, 6, 8, 10], [0, 2, 4, 7, 10, 12], [2, 4, 6, 9, 12, 14], [0, 4, 6, 8, 11]];
  let frase = null;

  for (let c = 0; c < compases; c++) {
    const t0 = c * compas;
    const ac = acordes[Math.floor(c / 2) % 4];
    const pausa = c >= compases - 12 && c < compases - 8; // respiro antes del final
    const conBajo = c >= 4 && !pausa;
    const conMelodia = c >= 8 && c < compases - 2;
    const relleno = c % 8 === 7;

    for (let p = 0; p < 16; p++) {
      const t = t0 + p * s16 + jit();
      // Shaker en todas las semicorcheas, acento a contratiempo.
      mez.poner(t, shaker(p % 4 === 2 ? 0.13 : 0.05 + r() * 0.02, r), 0.45);
      if (campanaPat.includes(p) && c >= 2) mez.poner(t, campana(p === 0 ? 880 : 1175, 0.22), -0.4);
      if (pausa) continue;
      const golpe = (relleno && p >= 8 ? djembeRelleno : djembe)[p];
      if (golpe === 'B') mez.poner(t, djembeGrave(0.9, r), 0.1);
      if (golpe === 'T') mez.poner(t, djembeTono(0.45 + r() * 0.1, r), 0.15);
      if (golpe === 'S') mez.poner(t, djembeSlap(0.5 + r() * 0.1, r), 0.2);
      if (dundunPat.includes(p)) mez.poner(t, dundun(p === 0 ? 1 : 0.75, r), -0.1);
    }

    if (conBajo) {
      [[0, 0, 1.4], [3, 7, 1], [6, 12, 0.8], [8, 0, 1.2], [11, 7, 0.9], [14, 10, 0.5]].forEach(([p, int, d]) => {
        if (int === 10 && c % 2 === 0) return;
        const m = ac.raiz + (int === 10 ? 12 : int);
        mez.poner(t0 + p * s16 + jit(), bajo(m, 0.55, d * s16 * 2), 0);
      });
    }

    if (conMelodia) {
      // Frase nueva cada dos compases: el segundo compás responde al primero.
      if (c % 2 === 0) frase = motivos[Math.floor(r() * motivos.length)];
      const respuesta = c % 2 === 1;
      let nota = respuesta ? ac.notas[2] : ac.notas[0];
      frase.forEach((p, i) => {
        const opciones = i === 0 ? ac.notas : penta;
        const cerca = opciones.filter(x => Math.abs(x - nota) <= 4 && x !== nota);
        nota = (cerca.length ? cerca : opciones)[Math.floor(r() * (cerca.length || opciones.length))];
        if (respuesta && i === frase.length - 1) nota = ac.notas[0] + 12 > 79 ? ac.notas[0] : ac.notas[0] + 12;
        const t = t0 + p * s16 + jit();
        mez.poner(t, marimba(nota, 0.42), -0.25);
        mez.poner(t + s16 * 0.02, marimba(nota - 12, 0.16), 0.25); // octava grave, más ancho
      });
    }
  }
  return mez;
}

export const PISTAS = [
  {
    archivo: 'piano-armonico.mp3', titulo: 'Piano armónico', genero: 'Piano', ambiente: 'cálido y reflexivo',
    etiquetas: ['piano', 'armónico', 'calma', 'emotivo', 'elegante', 'fondo'],
    duracion: 120, componer: componerPiano,
    post: 'aecho=0.8:0.72:180|420|780:0.3|0.2|0.12,highpass=f=40',
  },
  {
    archivo: 'tambores-africanos-alegres.mp3', titulo: 'Tambores africanos alegres', genero: 'Percusión africana', ambiente: 'festivo y alegre',
    etiquetas: ['tambores', 'africano', 'djembé', 'alegre', 'festivo', 'marimba', 'energía'],
    duracion: 90, componer: componerTambores,
    post: 'aecho=0.8:0.5:45|95:0.18|0.1,highpass=f=35,lowpass=f=9000',
  },
];

export async function generarInstrumentos({ dir = PATHS.assetsMusic, forzar = false } = {}) {
  ensureDir(dir);
  const hechas = [];
  for (const p of PISTAS) {
    const destino = path.join(dir, p.archivo);
    const ficha = `${destino}.json`;
    if (!forzar && fs.existsSync(destino) && fs.existsSync(ficha)) { hechas.push({ archivo: p.archivo, nueva: false }); continue; }
    const wav = `${destino}.tmp.wav`;
    p.componer(p.duracion).wav(wav);
    try {
      await ffmpegRun(['-y', '-i', wav, '-af',
        `${p.post},afade=t=in:st=0:d=1.5,afade=t=out:st=${p.duracion - 4}:d=4,loudnorm=I=-16:TP=-1.5:LRA=11`,
        '-t', String(p.duracion), '-ar', '44100', '-b:a', '192k', destino]);
    } finally { fs.rmSync(wav, { force: true }); }
    fs.writeFileSync(ficha, JSON.stringify({
      titulo: p.titulo, genero: p.genero, ambiente: p.ambiente, etiquetas: p.etiquetas,
      ...LICENCIA, generadaEn: new Date().toISOString(),
    }, null, 2), 'utf8');
    hechas.push({ archivo: p.archivo, nueva: true });
  }
  return hechas;
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (esPrincipal) {
  const r = await generarInstrumentos({ forzar: process.argv.includes('--forzar') });
  for (const x of r) console.log(`  ${x.nueva ? 'generada ' : 'ya estaba'}  ${x.archivo}`);
}
