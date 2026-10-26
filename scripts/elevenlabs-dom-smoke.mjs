// Optional dependency: npm install --no-save --package-lock=false --prefix .tmp/dom-tools linkedom@0.18.12
import assert from 'node:assert/strict';
import { parseHTML } from '../.tmp/dom-tools/node_modules/linkedom/esm/index.js';
import { panelAudio } from '../src/ui/project-editor/panels.js';
import { estadoInicial } from '../src/ui/project-editor/state.js';
import { makeProject } from '../src/core/project.js';
import { derivar } from '../src/project-editor/service.js';
const { window, document } = parseHTML('<html><body></body></html>');
globalThis.document = document;
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
  get() { return [...this.options].find(o => o.selected)?.value || this.options[0]?.value || ''; },
  set(value) { for (const op of this.options) op.selected = op.value === String(value); } });
const p = makeProject({ language:'en', voice: { provider:'elevenlabs', name:'voice123' }, scenes:[{text:'Welcome to remote work.',duration:3}] });
const s = { ...estadoInicial(), proyecto:p, derivado:derivar(p), capacidades:{voices:[{provider:'elevenlabs',name:'voice123',displayName:'English teacher',language:'en'}]}, biblioteca:{voz:{url:'/file?path=sample.wav'}} };
const calls=[];
const acc = new Proxy({}, { get: (_,name)=>(...args)=>calls.push({name,args}) });
const panel = document.createElement('div'); panel.append(panelAudio({s,acc}));
assert.match(panel.textContent,/English teacher/); assert.match(panel.textContent,/consume créditos/);
assert.ok(panel.querySelector('audio'));
const preview = [...panel.querySelectorAll('button')].find(b=>b.textContent==='Escuchar muestra de voz');
preview.click(); assert.equal(calls.at(-1).name,'probarVoz');
const model = [...panel.querySelectorAll('input')].find(n=>n.placeholder==='Modelo del backend (por defecto)');
assert.ok(model); model.value='eleven_multilingual_v2'; model.dispatchEvent(new window.Event('change'));
assert.deepEqual(calls.at(-1),{name:'cambiar',args:['voice.model','eleven_multilingual_v2']});
console.log('ElevenLabs DOM: human voice label, sample player, preview action and model input passed.');
