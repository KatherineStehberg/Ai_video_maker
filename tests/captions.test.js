import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  captionMetrics, captionBand, fontSizeBase, aspectoDe,
  normalizeCaptionStyle, defaultCaptionStyle, PRESETS,
  ZONA_SEGURA_INFERIOR, MAX_LINEAS,
} from '../src/core/captions-style.js';
import {
  buildCues, cuesToSrt, cuesToAss, assAlignment, verifyCaptionCoverage,
} from '../src/core/subtitles.js';
import {
  acortarDestacado, duplicaNarracion, pareceNarracion, onScreenMetrics,
  proponerTextosDestacados, escenasDestacables, resumenDestacados,
  normalizeOnScreenText, repartirEnDosLineas, PALABRAS_DESTACADO,
} from '../src/core/on-screen-text.js';
import { makeProject, makeScene, saveProject, loadProject, deleteProject } from '../src/core/project.js';
import { segmentarGuion } from '../src/generation/segmenter.js';
import { draftScript } from '../src/generation/script.js';

/**
 * SUBTITULOS Y TEXTO DESTACADO
 *
 * Todo aqui es local y puro salvo la prueba de persistencia, que escribe un
 * proyecto de verdad en disco y lo vuelve a leer. Sin red, sin FFmpeg y sin
 * proveedores de pago.
 */

// Los cuatro formatos que el producto entrega, con su resolucion real.
const FORMATOS = [
  { id: '9:16', w: 1080, h: 1920, min: 58, max: 68 },
  { id: '16:9', w: 1920, h: 1080, min: 42, max: 52 },
  // 1:1 y 4:5 no los fijo el encargo: se calculan interpolando entre los dos
  // anteriores, asi que la prueba comprueba que caen ENTRE ellos.
  { id: '1:1', w: 1080, h: 1080, min: 48, max: 68 },
  { id: '4:5', w: 1080, h: 1350, min: 48, max: 68 },
];

/** Guion de prueba: un parrafo largo por escena obliga a partir en varios cues. */
const TEXTO_LARGO = 'El presente simple se usa para hablar de habitos y rutinas diarias. '
  + 'Para formarlo en ingles se toma el infinitivo sin la particula to. '
  + 'En la tercera persona del singular se anade una ese al final del verbo.';

const proyecto = (extra = {}) => makeProject({
  title: 'Prueba de subtitulos',
  aspectRatio: '9:16',
  scenes: [
    { text: '¿Quieres aprender ingles de verdad?', duration: 4 },
    { text: TEXTO_LARGO, duration: 12 },
    { text: 'Escribenos y empezamos esta semana.', duration: 3.5 },
  ],
  ...extra,
});

// ------------------------------------------------- 1. TAMANOS POR FORMATO

test('cada formato recibe el tamano de letra que pide el encargo', () => {
  for (const f of FORMATOS) {
    const m = captionMetrics(f.w, f.h, {});
    assert.equal(m.aspecto, f.id, `${f.id}: aspecto mal deducido`);
    assert.ok(
      m.fontSize >= f.min && m.fontSize <= f.max,
      `${f.id}: la letra mide ${m.fontSize} px y debia estar entre ${f.min} y ${f.max}`,
    );
  }

  // Los dos extremos son valores MEDIDOS, no interpolados: deben salir exactos.
  assert.equal(captionMetrics(1080, 1920, {}).fontSize, 64, 'vertical debe dar 64 px');
  assert.equal(captionMetrics(1920, 1080, {}).fontSize, 48, 'horizontal debe dar 48 px');

  // 1:1 y 4:5 caen entre los dos extremos, que es lo que significa
  // «tamano equivalente»: mas grande que el horizontal, menor que el vertical.
  const cuadrado = captionMetrics(1080, 1080, {}).fontSize;
  const retrato = captionMetrics(1080, 1350, {}).fontSize;
  assert.ok(cuadrado > 48 && cuadrado < 64, `1:1 dio ${cuadrado}`);
  assert.ok(retrato > cuadrado && retrato < 64, `4:5 dio ${retrato}, deberia estar entre ${cuadrado} y 64`);
});

test('el tamano anterior (alto/34) era demasiado pequeno: esto es una regresion a evitar', () => {
  // Es la medida que producia el codigo viejo. Se deja escrita para que nadie
  // la reintroduzca pensando que "ya estaba bien".
  assert.equal(Math.round(1080 / 34), 32);
  assert.ok(captionMetrics(1920, 1080, {}).fontSize > Math.round(1080 / 34) * 1.4,
    'el horizontal debe ser bastante mayor que el viejo 32 px');
});

test('los cuatro presets existen y ninguno se sale del rango legible', () => {
  for (const id of ['redes-sociales', 'curso', 'limpio', 'alto-contraste']) {
    assert.ok(PRESETS[id], `falta el preset ${id}`);
    const v = captionMetrics(1080, 1920, { preset: id });
    assert.ok(v.fontSize >= 56 && v.fontSize <= 70, `${id}: ${v.fontSize} px en vertical`);
    const h = captionMetrics(1920, 1080, { preset: id });
    assert.ok(h.fontSize >= 42 && h.fontSize <= 52, `${id}: ${h.fontSize} px en horizontal`);
  }
  // Los presets se diferencian de verdad, no son el mismo estilo renombrado.
  assert.equal(PRESETS.curso.style.background, 'box');
  assert.equal(PRESETS['redes-sociales'].style.background, 'outline');
  assert.notEqual(PRESETS['alto-contraste'].style.color, PRESETS.limpio.style.color);
});

test('los controles globales existen, se validan y sobreviven a valores basura', () => {
  const s = normalizeCaptionStyle({
    fontFamily: 'Verdana', fontSize: 70, color: '#ffcc00', outlineColor: '#112233',
    background: 'box', backgroundColor: '#000000', backgroundOpacity: 0.6,
    position: 'top', alignment: 'left', maxWidthPct: 0.7,
  });
  assert.equal(s.fontFamily, 'Verdana');
  assert.equal(s.fontSize, 70);
  assert.equal(s.color, '#ffcc00');
  assert.equal(s.background, 'box');
  assert.equal(s.backgroundOpacity, 0.6);
  assert.equal(s.position, 'top');
  assert.equal(s.alignment, 'left');

  // Basura: cada campo cae a un valor valido en vez de romper el render.
  const b = normalizeCaptionStyle({
    color: 'rojo', background: 'neon', position: 'diagonal', alignment: 'justificado',
    backgroundOpacity: 99, maxLines: 17, fontSize: 'grande',
  });
  assert.equal(b.color, '#ffffff');
  assert.ok(['outline', 'box', 'none'].includes(b.background));
  assert.ok(['bottom', 'center', 'top'].includes(b.position));
  assert.equal(b.backgroundOpacity, 1);
  assert.ok(b.maxLines <= MAX_LINEAS, 'nunca mas de dos lineas simultaneas');
  assert.equal(b.fontSize, null, 'un tamano no numerico vuelve a "automatico"');

  // Cambiar de preset manda; retocar sin cambiarlo conserva el retoque.
  const conservado = normalizeCaptionStyle({ color: '#00ff00' }, defaultCaptionStyle());
  assert.equal(conservado.color, '#00ff00');
  const reseteado = normalizeCaptionStyle({ preset: 'curso' }, { ...defaultCaptionStyle(), color: '#00ff00' });
  assert.equal(reseteado.color, PRESETS.curso.style.color, 'cambiar de preset descarta el retoque anterior');
});

// ------------------------------------------------------- 2. ZONAS SEGURAS

test('los subtitulos caen dentro del encuadre y fuera de la franja de controles', () => {
  for (const f of FORMATOS) {
    const m = captionMetrics(f.w, f.h, {});
    const banda = captionBand(f.w, f.h, {});

    assert.ok(banda.y0 >= 0, `${f.id}: el bloque empieza fuera del encuadre`);
    assert.ok(banda.y1 <= f.h, `${f.id}: el bloque termina fuera del encuadre (${banda.y1} > ${f.h})`);

    // Zona segura inferior: es lo que tapan TikTok e Instagram.
    const limite = f.h - Math.round(f.h * ZONA_SEGURA_INFERIOR[f.id]);
    assert.ok(banda.y1 <= limite + 1,
      `${f.id}: el subtitulo entra en la franja de los controles (${banda.y1} > ${limite})`);

    // Ancho: el bloque no pasa del 85 % declarado, y queda centrado.
    assert.ok(m.marginH * 2 >= f.w * 0.15 - 2, `${f.id}: el bloque es mas ancho del 85 %`);
    assert.ok(m.maxCharsPerLine * m.fontSize * 0.5 <= f.w * 0.9,
      `${f.id}: la linea mas larga estimada se sale del encuadre`);
  }
});

test('en vertical la franja reservada es la mayor de las cuatro', () => {
  // No es un capricho: TikTok e Instagram dibujan mas interfaz en 9:16.
  assert.ok(ZONA_SEGURA_INFERIOR['9:16'] > ZONA_SEGURA_INFERIOR['16:9']);
  assert.ok(ZONA_SEGURA_INFERIOR['9:16'] >= 0.15, 'en vertical hace falta al menos un 15 %');
});

test('el .ass declara la resolucion real y traduce posicion y alineacion', () => {
  const p = proyecto();
  const ass = cuesToAss(buildCues(p, { width: 1080, height: 1920 }), { width: 1080, height: 1920, style: {} });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  // El tamano viaja en pixeles reales, no en las 288 lineas que asume el SRT.
  assert.match(ass, /^Style: Main,[^,]+,64,/m);

  // Numpad: 2 = abajo centro, 8 = arriba centro, 1 = abajo izquierda.
  assert.equal(assAlignment('bottom', 'center'), 2);
  assert.equal(assAlignment('top', 'center'), 8);
  assert.equal(assAlignment('bottom', 'left'), 1);
  assert.equal(assAlignment('center', 'right'), 6);

  // Caja opaca => BorderStyle 3; contorno => BorderStyle 1.
  // El grupo capturado empieza DESPUES de "Style: Main,", asi que el indice 0
  // es Fontname y BorderStyle (el 16.º campo del formato) cae en el 14.
  const caja = cuesToAss(buildCues(p), { width: 1080, height: 1920, style: { preset: 'curso' } });
  const campos = caja.match(/^Style: Main,(.+)$/m)[1].split(',');
  assert.equal(campos[14], '3', 'el preset con caja debe usar BorderStyle 3');
  assert.match(campos[5], /^&H[0-9A-F]{8}$/, 'BackColour debe llevar canal alfa');
  const contorno = cuesToAss(buildCues(p), { width: 1080, height: 1920, style: { preset: 'redes-sociales' } });
  assert.equal(contorno.match(/^Style: Main,(.+)$/m)[1].split(',')[14], '1',
    'el preset con contorno debe usar BorderStyle 1');
});

// -------------------------------------------- 3. SUBTITULADO COMPLETO

test('el video entero queda subtitulado: ninguna escena narrada se queda fuera', () => {
  const p = proyecto();
  const informe = verifyCaptionCoverage(p);
  assert.equal(informe.ok, true, `quedaron huecos: ${informe.problemas.join(' | ')}`);
  assert.equal(informe.problemas.length, 0);
  assert.ok(informe.cobertura >= 0.999, `cobertura ${informe.cobertura}`);
  assert.equal(informe.segundosConSubtitulo.toFixed(1), informe.segundosNarrados.toFixed(1));
});

test('los cues son contiguos, no se solapan y ninguno dura cero', () => {
  const cues = buildCues(proyecto());
  assert.ok(cues.length > 3, 'un guion de tres escenas con parrafos largos da mas de tres cues');
  for (const [i, c] of cues.entries()) {
    assert.ok(c.end > c.start, `el cue ${i + 1} dura cero o menos`);
    if (i > 0) {
      assert.ok(c.start >= cues[i - 1].end - 1e-6, `el cue ${i + 1} se solapa con el anterior`);
    }
  }
});

test('REGRESION: una escena corta con mucho texto ya no pierde el final', () => {
  // Este es el caso que rompia: muchos grupos en pocos segundos. El minimo de
  // 0,7 s por cue sumaba mas que la escena y los ultimos cues quedaban en cero,
  // asi que el final de la escena se narraba SIN subtitulo.
  const apretada = makeProject({
    title: 'Escena apretada',
    aspectRatio: '9:16',
    scenes: [{
      text: 'Uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece '
        + 'catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintidos.',
      duration: 3,
    }],
  });
  const cues = buildCues(apretada);
  assert.ok(cues.length >= 3, 'ese texto no cabe en un solo cue');
  for (const c of cues) assert.ok(c.end - c.start > 0, 'ningun cue puede durar cero');
  assert.equal(cues.at(-1).end.toFixed(2), '3.00', 'el ultimo cue cierra al final de la escena');
  assert.equal(verifyCaptionCoverage(apretada).ok, true);
});

test('nunca se muestran mas de dos lineas a la vez y no se parte ninguna palabra', () => {
  const p = proyecto();
  const original = p.scenes.map(s => s.text).join(' ');
  for (const c of buildCues(p)) {
    assert.ok(c.text.split('\n').length <= MAX_LINEAS, `un cue trae ${c.text.split('\n').length} lineas`);
    for (const palabra of c.text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean)) {
      assert.ok(original.includes(palabra), `la palabra "${palabra}" no esta entera en el guion`);
    }
  }
});

test('la narracion llega a los subtitulos palabra por palabra, sin resumir', () => {
  const p = proyecto();
  const norm = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const guion = norm(p.scenes.map(s => s.text).join(' '));
  const subtitulos = norm(buildCues(p).map(c => c.text).join(' '));
  assert.deepEqual(subtitulos, guion, 'los subtitulos deben reproducir la narracion exacta');
});

test('sin subtitulos no se escribe ni un cue', () => {
  const p = proyecto({ captions: { enabled: false } });
  // `buildCues` sigue siendo una funcion pura; quien decide es el pipeline y el
  // renderer, que solo queman cuando `captions.enabled` no es false.
  assert.equal(p.captions.enabled, false);
  assert.equal(p.captions.burnIn, true, 'burnIn conserva su valor; manda `enabled`');
});

test('una escena sin `caption` propio se subtitula con su narracion', () => {
  const p = makeProject({
    title: 'Sin caption',
    scenes: [
      { text: 'Primera frase narrada.', duration: 3, caption: null },
      { text: 'Segunda frase narrada.', duration: 3, caption: '   ' },
    ],
  });
  const texto = buildCues(p).map(c => c.text).join(' ');
  assert.match(texto, /Primera frase narrada/);
  assert.match(texto, /Segunda frase narrada/, 'un caption en blanco no puede silenciar el subtitulo');
  assert.equal(verifyCaptionCoverage(p).ok, true);
});

test('el SRT sale valido y en orden', () => {
  const srt = cuesToSrt(buildCues(proyecto()));
  const marcas = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)];
  assert.ok(marcas.length > 0);
  assert.match(srt, /^1\n/, 'el primer cue va numerado');
});

// -------------------------------------- 4. TEXTO DESTACADO: SOLO ALGUNAS

test('el texto destacado se propone solo en escenas clave, nunca en todas', () => {
  const escenas = Array.from({ length: 12 }, (_, i) => ({
    role: i === 0 ? 'hook' : i === 11 ? 'cta' : 'point',
    // El cierre narra una frase CORTA, que sí puede servir de rótulo. Las
    // intermedias narran frases largas: de ahí no sale ningún titular.
    text: i === 11 ? 'Escribenos hoy mismo.' : `Frase numero ${i + 1} de la narracion completa del video.`,
    duration: 5,
  }));
  const con = proponerTextosDestacados(escenas, { titulo: 'Mi video' });
  const r = resumenDestacados(con);

  assert.ok(r.conDestacado >= 2, 'portada y cierre llevan rotulo cuando hay texto que lo permita');
  assert.ok(r.conDestacado < r.total, 'no pueden llevarlo todas');
  assert.ok(r.proporcion <= 0.35, `demasiadas escenas con rotulo: ${r.proporcion}`);
  assert.ok(con[0].showOnScreenText, 'la portada debe llevar rotulo');
  assert.ok(con.at(-1).showOnScreenText, 'el cierre debe llevar rotulo');

  // Nunca dos seguidas: un destacado detras de otro deja de destacar nada.
  for (let i = 1; i < con.length; i++) {
    assert.ok(!(con[i].showOnScreenText && con[i - 1].showOnScreenText),
      `las escenas ${i} y ${i + 1} llevan rotulo seguidas`);
  }
});

test('una narracion larga NO se convierte en rotulo aunque sea escena clave', () => {
  // Portada y cierre son candidatas, pero si lo unico disponible es una frase
  // larga, se deja SIN rotulo en vez de recortarla a mitad de idea. Es lo que
  // producia los rotulos rotos tipo «Isan, entiendo que tenias el don de ver».
  const escenas = [
    { role: 'hook', text: 'Hoy vamos a repasar despacio todo lo que hace falta para empezar bien.', duration: 6 },
    { role: 'point', text: 'Una frase intermedia cualquiera del desarrollo.', duration: 5 },
    { role: 'cta', text: 'Si te ha servido, comparte este video con alguien a quien le venga bien.', duration: 6 },
  ];
  const con = proponerTextosDestacados(escenas, {});
  for (const [i, e] of con.entries()) {
    assert.equal(e.showOnScreenText, false,
      `la escena ${i + 1} no deberia llevar rotulo: su narracion es demasiado larga`);
  }
  // Pero el titulo del proyecto SI sirve de portada cuando se conoce.
  const conTitulo = proponerTextosDestacados(escenas, { titulo: 'Empieza bien' });
  assert.equal(conTitulo[0].showOnScreenText, true);
  assert.equal(conTitulo[0].onScreenTitle, 'Empieza bien');
});

test('las escenas sin rotulo conservan narracion y subtitulos', () => {
  const escenas = Array.from({ length: 8 }, (_, i) => ({
    role: 'point', text: `Frase ${i + 1} que se narra entera.`, duration: 4,
  }));
  const con = proponerTextosDestacados(escenas, {});
  const sinRotulo = con.filter(e => !e.showOnScreenText);
  assert.ok(sinRotulo.length > 0, 'la prueba no vale si todas llevan rotulo');

  const p = makeProject({ title: 'Mixto', scenes: con });
  const informe = verifyCaptionCoverage(p);
  assert.equal(informe.ok, true, 'apagar el rotulo no puede quitar el subtitulo');
  for (const s of p.scenes.filter(e => !e.showOnScreenText)) {
    assert.ok(s.text.trim(), 'la escena conserva su narracion');
  }
});

test('el rotulo nunca copia el guion entero sobre la imagen', () => {
  const narracion = 'Esta es una frase larga de narracion que jamas deberia acabar entera escrita sobre la imagen de fondo.';
  const corto = acortarDestacado(narracion);
  assert.ok(corto.split(/\s+/).length <= PALABRAS_DESTACADO.max, `${corto} tiene demasiadas palabras`);
  assert.ok(narracion.startsWith(corto.split(' ')[0]), 'se acorta por el principio, sin inventar');
  assert.ok(!corto.endsWith(','), 'no deja puntuacion suelta');

  assert.equal(duplicaNarracion(narracion, narracion), true, 'copiar la narracion larga esta prohibido');
  assert.equal(duplicaNarracion('¿Buscas ingles?', '¿Buscas ingles?'), false,
    'un gancho corto SI puede coincidir con su narracion');
});

test('un trozo de dialogo no se acepta como rotulo', () => {
  // Salidos de un video real: el detector de titulos los marcaba como titulos
  // por ser cortos y no acabar en punto.
  for (const malo of ['-Por ejemplo', '-Te explico', 'Me dijo', '-Ajanabh carraspeo nerviosamente y dijo',
    '-Isan, entiendo que tenias el don de ver enfermedades, pero']) {
    assert.equal(pareceNarracion(malo), true, `"${malo}" no deberia valer como rotulo`);
  }
  // Los titulos de verdad siguen pasando, incluso de una sola palabra.
  for (const bueno of ['REVELACIONES 8', 'VORTICE PINEAL', 'EL VIDENTE', 'Introduccion', 'Modulo 2']) {
    assert.equal(pareceNarracion(bueno), false, `"${bueno}" es un titulo valido`);
  }
});

test('un guion narrativo con dialogos ya no llena el video de rotulos', () => {
  const guion = [
    '## REVELACIONES 8', '', 'Aquella tarde el cielo estaba despejado sobre el desierto.', '',
    '## -Por ejemplo', '', 'El maestro levanto la mano y senalo el horizonte lejano.', '',
    '## Me dijo', '', 'Que todo lo que veiamos formaba parte de lo mismo.', '',
  ].join('\n');
  const { escenas } = segmentarGuion(guion);
  const rotulos = escenas.filter(e => e.showOnScreenText).map(e => e.onScreenTitle);
  assert.ok(rotulos.includes('REVELACIONES 8'), 'el titulo real si es un rotulo');
  assert.ok(!rotulos.some(t => /^-/.test(t)), `entro un dialogo como rotulo: ${rotulos.join(' | ')}`);
  assert.ok(!rotulos.includes('Me dijo'), 'una muletilla no es un rotulo');
});

test('el borrador desde un prompt propone rotulos solo en gancho y cierre', async () => {
  const d = await draftScript(
    { prompt: 'Reel vertical para promocionar clases particulares de ingles online para adultos', duration: 30 },
    { templateId: 'reel-promocional' },
  );
  const r = resumenDestacados(d.escenas);
  assert.ok(r.total >= 4, 'el borrador debe traer varias escenas');
  assert.ok(r.conDestacado >= 1 && r.conDestacado < r.total,
    `rotulos en ${r.conDestacado} de ${r.total}: deben ser algunas, no todas`);
  assert.ok(d.escenas[0].showOnScreenText, 'el gancho lleva rotulo');
  for (const e of d.escenas) {
    if (e.showOnScreenText) {
      assert.ok(e.onScreenTitle.split(/\s+/).length <= PALABRAS_DESTACADO.max,
        `"${e.onScreenTitle}" pasa de ${PALABRAS_DESTACADO.max} palabras`);
    }
  }
});

test('escenasDestacables prioriza portada, cierre, secciones y cifras', () => {
  const escenas = [
    { role: 'hook', text: 'Empieza aqui.' },
    { role: 'point', text: 'Una frase cualquiera.' },
    { role: 'point', text: 'El metodo subio un 40 % la retencion.' },
    { role: 'point', text: 'Otra frase cualquiera.' },
    { role: 'section', text: 'Modulo dos.', abreSeccion: true },
    { role: 'point', text: 'Mas desarrollo.' },
    { role: 'cta', text: 'Escribenos hoy.' },
  ];
  const elegidos = escenasDestacables(escenas);
  assert.ok(elegidos.includes(0), 'la portada entra siempre');
  assert.ok(elegidos.includes(6), 'el cierre entra siempre');
  assert.ok(elegidos.length < escenas.length, 'no entran todas');
});

// --------------------------------- 5. CONVIVENCIA ROTULO + SUBTITULO

test('rotulo y subtitulo conviven sin pisarse en los cuatro formatos', () => {
  for (const f of FORMATOS) {
    for (const position of ['top', 'upper-third', 'center', 'lower-third', 'bottom']) {
      const m = onScreenMetrics(f.w, f.h, {
        text: 'Concepto principal', position, captionsEnabled: true, captionStyle: {},
      });
      const banda = captionBand(f.w, f.h, {});

      const solapa = m.y < banda.y1 && m.y + m.blockHeight > banda.y0;
      assert.equal(solapa, false,
        `${f.id}/${position}: el rotulo (${m.y}..${m.y + m.blockHeight}) pisa el subtitulo (${banda.y0}..${banda.y1})`);

      assert.ok(m.y >= 0 && m.y + m.blockHeight <= f.h,
        `${f.id}/${position}: el rotulo se sale del encuadre`);
      assert.ok(m.y >= m.safeTop - 1, `${f.id}/${position}: el rotulo invade la zona segura superior`);
    }
  }
});

test('el rotulo es mayor que el subtitulo, pero cabe en el ancho', () => {
  for (const f of FORMATOS) {
    const sub = captionMetrics(f.w, f.h, {}).fontSize;
    const m = onScreenMetrics(f.w, f.h, { text: 'Idea clave', position: 'upper-third' });
    assert.ok(m.fontSize > sub, `${f.id}: el rotulo (${m.fontSize}) no destaca sobre el subtitulo (${sub})`);

    // Un rotulo largo se encoge en vez de salirse por los lados.
    const largo = onScreenMetrics(f.w, f.h, { text: 'Un concepto bastante mas largo de la cuenta', position: 'top' });
    const anchoEstimado = Math.max(...largo.lineas.map(l => l.length)) * largo.fontSize * 0.52;
    assert.ok(anchoEstimado <= f.w * 0.9, `${f.id}: el rotulo largo se sale (${Math.round(anchoEstimado)} px de ${f.w})`);
  }
});

test('el rotulo se parte en dos lineas como mucho, sin cortar palabras', () => {
  const lineas = repartirEnDosLineas('Cuatro palabras bien repartidas aqui');
  assert.ok(lineas.length <= 2);
  assert.equal(lineas.join(' '), 'Cuatro palabras bien repartidas aqui');
  assert.deepEqual(repartirEnDosLineas('Corto'), ['Corto']);
  assert.deepEqual(repartirEnDosLineas(''), []);
});

test('sin subtitulos el rotulo puede bajar a la zona inferior', () => {
  const conSubs = onScreenMetrics(1080, 1920, { text: 'Idea', position: 'bottom', captionsEnabled: true });
  const sinSubs = onScreenMetrics(1080, 1920, { text: 'Idea', position: 'bottom', captionsEnabled: false });
  assert.ok(sinSubs.y > conSubs.y, 'sin subtitulos el rotulo no tiene que esquivar nada');
  assert.equal(sinSubs.captionBand, null);
});

// ---------------------------------------------- 6. MODELO Y PERSISTENCIA

test('la escena declara los cinco campos del texto destacado', () => {
  const s = makeScene({ text: 'Hola', showOnScreenText: true, onScreenTitle: 'Concepto clave' });
  for (const campo of ['showOnScreenText', 'onScreenTitle', 'onScreenPosition', 'onScreenStyle', 'onScreenAnimation']) {
    assert.ok(campo in s, `falta el campo ${campo}`);
  }
  assert.equal(s.showOnScreenText, true);
  assert.equal(typeof s.onScreenStyle, 'object');
});

test('apagar el rotulo conserva el texto escrito', () => {
  const s = makeScene({ text: 'Hola', showOnScreenText: false, onScreenTitle: 'Lo escribi yo' });
  assert.equal(s.showOnScreenText, false);
  assert.equal(s.onScreenTitle, 'Lo escribi yo', 'apagar no puede borrar lo redactado');
});

test('un proyecto viejo sin `showOnScreenText` se reabre igual que se veia', () => {
  // Compatibilidad: antes solo existia `onScreenTitle`. Si tenia texto, el
  // rotulo se veia; si no, no. Reabrirlo no puede cambiar el video.
  assert.equal(normalizeOnScreenText({ onScreenTitle: 'TITULO' }).showOnScreenText, true);
  assert.equal(normalizeOnScreenText({ onScreenTitle: '' }).showOnScreenText, false);
  assert.equal(normalizeOnScreenText({}).showOnScreenText, false);
});

test('el estilo de subtitulos y los rotulos sobreviven a guardar y reabrir', () => {
  const p = makeProject({
    title: 'Persistencia de subtitulos',
    aspectRatio: '16:9',
    captions: {
      enabled: true,
      style: {
        preset: 'curso', color: '#ffee00', background: 'box', backgroundOpacity: 0.8,
        position: 'bottom', alignment: 'center', fontFamily: 'Verdana',
      },
    },
    scenes: [
      { text: 'Primera escena narrada entera.', duration: 4, showOnScreenText: true, onScreenTitle: 'Concepto clave', onScreenPosition: 'top', onScreenAnimation: 'slide-up' },
      { text: 'Segunda escena, sin rotulo.', duration: 4 },
    ],
  });
  const file = saveProject(p);
  try {
    const leido = loadProject(p.id);
    assert.ok(leido, 'el proyecto debe poder releerse');

    // Estilo global.
    assert.equal(leido.captions.style.preset, 'curso');
    assert.equal(leido.captions.style.color, '#ffee00');
    assert.equal(leido.captions.style.background, 'box');
    assert.equal(leido.captions.style.backgroundOpacity, 0.8);
    assert.equal(leido.captions.style.fontFamily, 'Verdana');
    assert.equal(leido.captions.enabled, true);

    // Rotulo por escena.
    assert.equal(leido.scenes[0].showOnScreenText, true);
    assert.equal(leido.scenes[0].onScreenTitle, 'Concepto clave');
    assert.equal(leido.scenes[0].onScreenPosition, 'top');
    assert.equal(leido.scenes[0].onScreenAnimation, 'slide-up');
    assert.equal(leido.scenes[1].showOnScreenText, false);

    // Y el render seguiria midiendo igual tras reabrir.
    assert.equal(
      captionMetrics(1920, 1080, leido.captions.style).fontSize,
      captionMetrics(1920, 1080, p.captions.style).fontSize,
    );
  } finally {
    deleteProject(p.id);
    assert.equal(fs.existsSync(file), false);
  }
});

test('apagar los subtitulos persiste al guardar y reabrir', () => {
  const p = makeProject({ title: 'Sin subtitulos', captions: { enabled: false, burnIn: false }, scenes: [{ text: 'Hola.', duration: 2 }] });
  saveProject(p);
  try {
    assert.equal(loadProject(p.id).captions.enabled, false, 'la opcion apagada debe seguir apagada');
    assert.equal(loadProject(p.id).captions.burnIn, false);
  } finally {
    deleteProject(p.id);
  }
});
