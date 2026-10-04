import { loadPack, courseSpec, preflight } from '../src/course-production/index.js';
import { validatePack } from '../src/course-production/queue.js';
const pack=validatePack(loadPack());
const voice={provider:'sapi',name:'validation-only'};
for(const item of pack.items)courseSpec(item,voice);
const environment=await preflight();
console.log(JSON.stringify({scriptsValidated:pack.items.length,scenes:pack.items.reduce((n,i)=>n+i.scenes.length,0),recordingsProduced:false,environment},null,2));
