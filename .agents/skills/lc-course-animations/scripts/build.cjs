const fs = require('node:fs');
const path = require('node:path');

function validate(spec) {
  if (!spec || typeof spec !== 'object') throw Error('Expected a JSON object');
  for (const key of ['course', 'title', 'sub', 'question', 'tip']) {
    if (typeof spec[key] !== 'string' || !spec[key].trim()) throw Error(`Missing ${key}`);
  }
  if (!['en', 'es'].includes(spec.lang || (spec.mode === 'web' ? 'es' : 'en'))) throw Error('lang must be es or en');
  for (const key of ['names', 'hints', 'examples']) {
    if (!Array.isArray(spec[key]) || spec[key].length !== 4 || spec[key].some(x => typeof x !== 'string' || !x.trim())) throw Error(`${key} must contain four nonempty strings`);
  }
  const limits = { title: 70, sub: 95, course: 42, question: 95, tip: 125 };
  for (const [key, max] of Object.entries(limits)) if (spec[key].length > max) throw Error(`${key} exceeds ${max} characters; shorten it before rendering`);
  for (const [key, max] of [['names', 20], ['hints', 55], ['examples', 145]]) if (spec[key].some(x => x.length > max)) throw Error(`${key} text exceeds ${max} characters`);
  spec.duration ??= 32;
  if (!Number.isFinite(spec.duration) || spec.duration < 6 || spec.duration > 120) throw Error('duration must be 6–120 seconds');
  return spec;
}
function build(spec) {
  validate(spec);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tokens = Object.fromEntries(['course','title','sub','question','tip'].map(key => [key.toUpperCase(), esc(spec[key])]));
  spec.names.forEach((s,i) => tokens['NAME_'+i] = esc(s));
  spec.hints.forEach((s,i) => tokens['HINT_'+i] = esc(s));
  tokens.SPEC_JSON = JSON.stringify(spec).replace(/</g,'\\u003c');
  const seconds = Math.round(spec.duration);
  tokens.DURATION_LABEL = String(Math.floor(seconds/60)).padStart(2,'0') + ':' + String(seconds%60).padStart(2,'0');
  tokens.LANG = spec.lang || (spec.mode === 'web' ? 'es' : 'en');
  return fs.readFileSync(path.join(__dirname,'../assets/four-step.html'),'utf8').replace(/\{\{([A-Z_0-9]+)\}\}/g, (_,key) => {
    if (!(key in tokens)) throw Error('Unknown token '+key);
    return tokens[key];
  });
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: node build.cjs spec.json output.html');
  if (fs.existsSync(output)) throw Error('Output exists; use a new path');
  fs.mkdirSync(path.dirname(path.resolve(output)), {recursive:true});
  fs.writeFileSync(output,build(JSON.parse(fs.readFileSync(input,'utf8'))));
  console.log(path.resolve(output));
}
module.exports = {build,validate};
