import assert from 'node:assert/strict';
import { parseHTML } from '../.tmp/dom-tools/node_modules/linkedom/esm/index.js';
import { panelRecursos, panelAudio } from '../src/ui/project-editor/panels.js';
import { estadoInicial } from '../src/ui/project-editor/state.js';
import { makeProject } from '../src/core/project.js';
import { derivar } from '../src/project-editor/service.js';
const { window, document } = parseHTML('<html><body></body></html>');
globalThis.document = document;
// linkedom lacks the native select.value setter; supply standard selection behavior.
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
  get() { return [...this.options].find(o => o.selected)?.value || this.options[0]?.value || ''; },
  set(value) { for (const op of this.options) op.selected = op.value === String(value); } });
const p = makeProject({ language: 'es', voice: { provider: 'edge', name: 'es-CL-CatalinaNeural' }, scenes: [{ text: 'Un río en movimiento.', duration: 3 }] });
const v = { id: '123', miniatura: 'https://images.pexels.com/a.jpg', vistaPrevia: 'https://videos.pexels.com/a.mp4', autor: 'Autora', licencia: 'Licencia Pexels' };
const s = { ...estadoInicial(), proyecto: p, derivado: derivar(p), capacidades: { biblioteca: { videos: true, imagenes: false }, voices: [{ provider: 'edge', name: 'es-CL-CatalinaNeural', language: 'es-CL' }, { provider: 'edge', name: 'en-US-JennyNeural', language: 'en-US' }] }, biblioteca: { videos: { consulta: 'river', seleccion: v, resultados: [v], total: 1 }, voz: { url: '/file?path=sample.wav' } } };
const calls = [];
const acc = new Proxy({}, { get: (_, name) => (...args) => calls.push({ name, args }) });
const resources = document.createElement('div'); resources.append(panelRecursos({ s, acc }));
assert.match(resources.textContent, /Clips con movimiento real/);
assert.equal(resources.querySelector('video').src, v.vistaPrevia);
const choose = [...resources.querySelectorAll('button')].find(b => b.textContent === 'Usar este clip');
assert.ok(choose); choose.click(); assert.equal(calls.at(-1).name, 'usarVideo');
assert.match(resources.textContent, /Video de Autora/);
const audio = document.createElement('div'); audio.append(panelAudio({ s, acc }));
assert.ok(audio.querySelector('audio'));
const button = [...audio.querySelectorAll('button')].find(b => b.textContent === 'Escuchar muestra de voz');
assert.ok(button); button.click(); assert.equal(calls.at(-1).name, 'probarVoz');
const select = [...audio.querySelectorAll('select')].find(n => [...n.options].some(o => o.value.startsWith('edge|')));
assert.ok(select); select.value = 'edge|en-US-JennyNeural'; select.dispatchEvent(new window.Event('change'));
assert.equal(calls.at(-1).name, 'elegirVoz'); assert.deepEqual(calls.at(-1).args, ['en-US-JennyNeural', 'edge']);
console.log('DOM smoke: clip preview, attribution, use clip, voice sample and selection passed.');
