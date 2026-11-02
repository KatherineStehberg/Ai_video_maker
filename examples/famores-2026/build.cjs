// Construye el HTML final de cada video Famores inyectando GSAP 3.15.0 (con su aviso de licencia)
// desde el paquete canónico de la skill lc-course-animations. Uso: node build.cjs specs/<id>.json <id>.html
const fs=require('node:fs'),path=require('node:path');
const [input,output]=process.argv.slice(2);
if(!input||!output) throw Error('Uso: node build.cjs specs/<id>.json salida.html');
if(fs.existsSync(output)) throw Error('La salida ya existe; usa otra ruta');
const spec=JSON.parse(fs.readFileSync(input,'utf8'));
for(const k of ['kicker','sku']) if(typeof spec[k]!=='string'||!spec[k].trim()) throw Error('Falta '+k);
if(!Array.isArray(spec.title)||!Array.isArray(spec.photos)||!spec.photos.length||!Array.isArray(spec.bullets)) throw Error('title/photos/bullets deben ser listas');
spec.duration??=18; if(spec.duration<6||spec.duration>120) throw Error('duration 6–120 s');
const skill=process.env.SKILL_HTML||path.join(__dirname,'../../.agents/skills/lc-course-animations/assets/four-step.html');
const src=fs.readFileSync(skill,'utf8');
const m=src.match(/<script>\/\*!\s*\n \* GSAP[\s\S]*?<\/script>/); if(!m) throw Error('No se encontró el bloque GSAP en '+skill);
const tpl=fs.readFileSync(path.join(__dirname,'template.html'),'utf8');
fs.writeFileSync(output,tpl.replace('<!--GSAP-->',()=>m[0]).replace('{{SPEC_JSON}}',()=>JSON.stringify(spec).replace(/</g,'\\u003c')));
console.log(path.resolve(output));
