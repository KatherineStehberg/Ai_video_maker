import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLangSegments, stripLangTags, hasLangTags, buildSsml,
  resolveVoices, narrationPlan, normalizeLanguage, baseLanguage, pickVoice,
} from '../src/core/lang.js';
import { buildCues } from '../src/core/subtitles.js';
import { makeProject } from '../src/core/project.js';

const ZIRA = 'Microsoft Zira Desktop';
const SABINA = 'Microsoft Sabina Desktop';
const HELENA = 'Microsoft Helena Desktop';

const INSTALLED = [
  { name: ZIRA, language: 'en-US', provider: 'sapi' },
  { name: HELENA, language: 'es-ES', provider: 'sapi' },
  { name: SABINA, language: 'es-MX', provider: 'sapi' },
];

const proj = over => ({ language: 'es', voice: { name: '', en: '', es: '' }, ...over });

/** Voces, en orden, tal como las narraria el plan. */
const voiceOrder = plan => plan.segments.map(s => plan.voices[s.lang]);

test('1. guion 100% ingles se narra con Zira', () => {
  const p = proj({ language: 'en' });
  const plan = narrationPlan('The board approved the budget.', p, INSTALLED);
  assert.equal(plan.baseLang, 'en');
  assert.equal(plan.base, ZIRA);
  assert.deepEqual(voiceOrder(plan), [ZIRA]);
  assert.equal(plan.ssml, null, 'una sola voz no necesita SSML');
});

test('2. guion 100% espanol se narra con Sabina', () => {
  const p = proj({ language: 'es' });
  const plan = narrationPlan('Hoy practicamos el presente simple.', p, INSTALLED);
  assert.equal(plan.baseLang, 'es');
  assert.equal(plan.base, SABINA);
  assert.deepEqual(voiceOrder(plan), [SABINA]);
  assert.equal(plan.ssml, null);
});

test('3. espanol con [en]...[/en] alterna Sabina -> Zira -> Sabina', () => {
  const p = proj({ language: 'bilingual' });
  const plan = narrationPlan(
    'Hoy practicamos [en]the board approved the budget[/en] y seguimos en espanol.',
    p, INSTALLED,
  );
  assert.deepEqual(plan.segments.map(s => s.lang), ['es', 'en', 'es']);
  assert.deepEqual(voiceOrder(plan), [SABINA, ZIRA, SABINA]);
  assert.ok(plan.ssml, 'el cambio de voz exige SSML');
  assert.match(plan.ssml, /<voice name="Microsoft Zira Desktop" xml:lang="en-US">the board approved the budget<\/voice>/);
});

test('4. ingles con [es]...[/es] alterna Zira -> Sabina -> Zira', () => {
  const p = proj({ language: 'en' });
  const plan = narrationPlan(
    'We start by saying [es]Buenos dias[/es] before the meeting.',
    p, INSTALLED,
  );
  assert.deepEqual(plan.segments.map(s => s.lang), ['en', 'es', 'en']);
  assert.deepEqual(voiceOrder(plan), [ZIRA, SABINA, ZIRA]);
  assert.match(plan.ssml, /<voice name="Microsoft Sabina Desktop" xml:lang="es-MX">Buenos dias<\/voice>/);
});

test('5. los tags no llegan al audio ni a los subtitulos', () => {
  const texto = 'Hoy vemos [en]present simple[/en] en clase.';

  // Audio: ni el texto plano ni el SSML contienen las marcas.
  const plan = narrationPlan(texto, proj({ language: 'bilingual' }), INSTALLED);
  assert.equal(plan.plain, 'Hoy vemos present simple en clase.');
  for (const tag of ['[en]', '[/en]', '[es]', '[/es]']) {
    assert.ok(!plan.plain.includes(tag), `texto plano sin ${tag}`);
    assert.ok(!plan.ssml.includes(tag), `SSML sin ${tag}`);
    for (const seg of plan.segments) assert.ok(!seg.text.includes(tag));
  }

  // Subtitulos: buildCues usa el texto ya limpio.
  const cues = buildCues({
    captions: { maxCharsPerLine: 80 },
    scenes: [{ text: texto, duration: 4 }],
  });
  const todo = cues.map(c => c.text).join(' ');
  assert.ok(todo.includes('present simple'));
  for (const tag of ['[en]', '[/en]', '[es]', '[/es]']) {
    assert.ok(!todo.includes(tag), `subtitulo sin ${tag}`);
  }
});

test('6. proyectos antiguos sin tags ni idioma siguen igual', () => {
  // Un proyecto guardado antes de este cambio: sin voice.en/voice.es.
  const viejo = { language: 'es', voice: { provider: 'auto', name: SABINA, enabled: true } };
  const plan = narrationPlan('Texto de siempre, sin marcas.', viejo, INSTALLED);
  assert.equal(plan.base, SABINA, 'respeta la voz ya elegida');
  assert.equal(plan.ssml, null, 'sin SSML: mismo camino de antes');
  assert.equal(plan.plain, 'Texto de siempre, sin marcas.');
  assert.deepEqual(plan.warnings, []);

  // makeProject rellena los campos nuevos sin alterar los antiguos.
  const p = makeProject({ title: 'viejo', voice: { name: SABINA } });
  assert.equal(p.voice.name, SABINA);
  assert.equal(p.voice.en, '');
  assert.equal(p.voice.es, '');
  assert.equal(p.language, 'es');
});

test('validacion: idioma en con voz espanola avisa y cambia a una voz inglesa', () => {
  const p = proj({ language: 'en', voice: { name: SABINA } });
  const { base, warnings } = resolveVoices(p, INSTALLED);
  assert.equal(base, ZIRA);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Zira/);
  assert.match(warnings[0], /Sabina/);
});

test('validacion: idioma es con voz inglesa avisa y cambia a una voz espanola', () => {
  const p = proj({ language: 'es', voice: { name: ZIRA } });
  const { base, warnings } = resolveVoices(p, INSTALLED);
  assert.equal(base, SABINA);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Sabina/);
});

test('validacion: sin voz del idioma declarado avisa y no inventa una voz', () => {
  const soloIngles = [{ name: ZIRA, language: 'en-US' }];
  const p = proj({ language: 'es', voice: { name: ZIRA } });
  const { base, warnings } = resolveVoices(p, soloIngles);
  assert.equal(base, ZIRA, 'se queda con la unica disponible');
  assert.match(warnings[0], /no hay/i);
});

test('voz coincidente con el idioma no genera aviso', () => {
  const p = proj({ language: 'en', voice: { name: ZIRA } });
  assert.deepEqual(resolveVoices(p, INSTALLED).warnings, []);
});

test('la voz por idioma elegida a mano manda sobre la predeterminada', () => {
  const p = proj({ language: 'bilingual', voice: { es: HELENA } });
  const plan = narrationPlan('Hola [en]hello[/en] adios', p, INSTALLED);
  assert.deepEqual(voiceOrder(plan), [HELENA, ZIRA, HELENA]);
});

test('no hay deteccion heuristica: el ingles sin marcar usa la voz base', () => {
  const p = proj({ language: 'es' });
  const plan = narrationPlan('The board approved the budget', p, INSTALLED);
  assert.deepEqual(voiceOrder(plan), [SABINA]);
  assert.equal(plan.ssml, null);
});

test('parseLangSegments: tramos contiguos del mismo idioma se unen', () => {
  const segs = parseLangSegments('[en]one[/en] [en]two[/en]', 'es');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'one two');
  assert.equal(segs[0].lang, 'en');
});

test('parseLangSegments: mayusculas y anidado suelto no rompen nada', () => {
  const segs = parseLangSegments('Hola [EN]hello[/EN] mundo', 'es');
  assert.deepEqual(segs.map(s => s.lang), ['es', 'en', 'es']);

  // Tag sin cerrar: se limpia y el texto se narra en el idioma base.
  const rotos = parseLangSegments('Hola [en]hello mundo', 'es');
  assert.deepEqual(rotos.map(s => s.lang), ['es']);
  assert.ok(!rotos[0].text.includes('[en]'));
});

test('stripLangTags y hasLangTags', () => {
  assert.equal(stripLangTags('a [en]b[/en] c'), 'a b c');
  assert.equal(stripLangTags('a [en]b c'), 'a b c', 'tag suelto tambien se quita');
  assert.equal(stripLangTags(null), '');
  assert.ok(hasLangTags('x [es]y[/es]'));
  assert.ok(!hasLangTags('sin marcas'));
});

test('buildSsml produce XML valido y escapa el contenido', () => {
  const ssml = buildSsml(
    [{ lang: 'es', text: 'Uno & dos <tres>' }, { lang: 'en', text: 'four "five"' }],
    { es: SABINA, en: ZIRA }, { baseLang: 'es' },
  );
  assert.match(ssml, /^<speak version="1\.0"/);
  assert.match(ssml, /xmlns="http:\/\/www\.w3\.org\/2001\/10\/synthesis"/);
  assert.ok(ssml.endsWith('</speak>'));
  assert.ok(ssml.includes('Uno &amp; dos &lt;tres&gt;'), 'escapa & y <>');
  assert.ok(ssml.includes('four &quot;five&quot;'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(ssml), 'sin ampersands sueltos');

  const aperturas = (ssml.match(/<voice /g) || []).length;
  const cierres = (ssml.match(/<\/voice>/g) || []).length;
  assert.equal(aperturas, cierres, 'cada <voice> se cierra');
  assert.equal(aperturas, 2);
});

test('normalizeLanguage y baseLanguage', () => {
  assert.equal(normalizeLanguage('EN'), 'en');
  assert.equal(normalizeLanguage('bilingual'), 'bilingual');
  assert.equal(normalizeLanguage('fr'), 'es', 'idioma no admitido cae en es');
  assert.equal(normalizeLanguage(undefined), 'es');
  assert.equal(baseLanguage('en'), 'en');
  assert.equal(baseLanguage('bilingual'), 'es', 'lo no marcado se narra en espanol');
});

test('pickVoice prefiere la voz por defecto del idioma', () => {
  assert.equal(pickVoice('es', INSTALLED), SABINA);
  assert.equal(pickVoice('en', INSTALLED), ZIRA);
  assert.equal(pickVoice('es', INSTALLED, HELENA), HELENA, 'respeta la preferida');
  assert.equal(pickVoice('es', INSTALLED, ZIRA), SABINA, 'ignora una preferida de otro idioma');
  assert.equal(pickVoice('en', []), '', 'sin voces instaladas devuelve vacio');
});
