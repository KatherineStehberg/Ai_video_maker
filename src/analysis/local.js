import { spawn } from 'node:child_process';
import { resolveFfmpeg, run } from '../lib/ffmpeg.js';

// Stream output: neither decoded frames nor a full audio track are retained.
export function streamProcess(bin, args, consume) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let tail = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Procesamiento excedió 2 horas')); }, 7200000);
    child.stdout.on('data', consume);
    child.stderr.on('data', b => { tail = (tail + b).slice(-3000); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('No se pudo ejecutar FFmpeg')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FFmpeg falló (${code}): ${tail}`)); });
  });
}

export async function probe(file) {
  const { ffprobe } = await resolveFfmpeg();
  if (!ffprobe) throw new Error('Se requiere ffprobe; configura FFPROBE_PATH');
  const r = await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('Archivo inválido o no compatible con ffprobe');
  const p = JSON.parse(r.stdout), v = p.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(p.format.duration);
  if (!v || !Number.isFinite(duration) || duration <= 0) throw new Error('Se requiere video con duración finita');
  const fraction = x => { const [a,b] = x.split('/').map(Number); return b ? a/b : 0; };
  return { duration, fps: fraction(v.avg_frame_rate), nominalFps: fraction(v.r_frame_rate), width: v.width, height: v.height,
    videoStream: v.index, startTime: Number(p.format.start_time || 0), videoStartTime: Number(v.start_time || 0),
    timeBase: v.time_base, audio: p.streams.filter(s => s.codec_type === 'audio').map(s => ({ index: s.index, codec: s.codec_name, channels: s.channels, sampleRate: Number(s.sample_rate), startTime: Number(s.start_time || 0) })) };
}

// Energy-rise onset detector, not a musical beat tracker. 10 ms windows,
// adaptive trailing baseline, absolute silence floor, 120 ms refractory period.
export function onsetDetector(offset = 0) {
  let pending = Buffer.alloc(0), index = 0, previous = 0, last = -1, history = [];
  const events = [];
  return { events, get seconds(){ return index*.01; }, push(chunk) {
    pending = Buffer.concat([pending, chunk]);
    let pos = 0;
    while (pos + 320 <= pending.length) {
      let energy = 0;
      for (let i = 0; i < 160; i++) energy += (pending.readInt16LE(pos + i*2)/32768)**2;
      const rms = Math.sqrt(energy), baseline = history.reduce((a,b)=>a+b,0)/(history.length || 1);
      const timestamp = offset + index * .01;
      if (rms > .015 && rms > Math.max(previous * 1.8, baseline * 2.5) && timestamp-last >= .12) {
        events.push({ timestamp, kind: 'onset', reason: 'Inicio de energía de audio', evidence: { rms, baseline, windowSeconds: .01 }, confidence: null }); last = timestamp;
      }
      history.push(rms); if (history.length > 50) history.shift(); previous = rms; index++; pos += 320;
    }
    pending = pending.subarray(pos);
  } };
}

export async function analyzeLocal(file, metadata, progress = () => {}) {
  const { ffmpeg } = await resolveFfmpeg();
  if (!ffmpeg) throw new Error('Se requiere FFmpeg');
  const scenes = []; let line = '', timestamp = null;
  progress(10, 'Detectando cambios visuales en los frames decodificados');
  await streamProcess(ffmpeg, ['-hide_banner','-nostdin','-v','error','-i',file,'-map',`0:${metadata.videoStream}`,'-vf',"scale=320:-2,select='gt(scene,0.3)',metadata=print:file=-",'-an','-f','null','-'], chunk => {
    line += chunk.toString(); const lines = line.split(/\r?\n/); line = lines.pop();
    for (const s of lines) {
      const t = /pts_time:([\d.e+-]+)/.exec(s); if (t) timestamp = Number(t[1]);
      const score = /lavfi.scene_score=([\d.]+)/.exec(s);
      if (score && timestamp !== null && timestamp > 0 && timestamp < metadata.duration) scenes.push({ timestamp, kind:'scene', reason:'Cambio visual', evidence:{ sceneScore:Number(score[1]), threshold:.3, scaleWidth:320 }, confidence:null });
      if (t) progress(Math.min(55,10+45*timestamp/metadata.duration),'Detectando cambios visuales');
    }
  });
  progress(60, 'Detectando onsets de audio (no equivalen a beats)');
  const audio = metadata.audio[0];
  const detector = onsetDetector(audio ? Math.max(0,audio.startTime-metadata.startTime) : 0);
  if (audio) await streamProcess(ffmpeg, ['-hide_banner','-nostdin','-v','error','-i',file,'-map',`0:${audio.index}`,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','s16le','pipe:1'], b => {detector.push(b);progress(60+15*Math.min(1,detector.seconds/metadata.duration),'Detectando onsets de audio');});
  return { scenes, onsets: detector.events.filter(e=>e.timestamp < metadata.duration), beats: [],
    notes:['Onsets: detector de energía implementado en JavaScript; FFmpeg sólo decodifica audio. No se estima tempo ni rejilla de beats.', 'Umbral visual 0.3 a ancho 320; puede omitir fundidos y cambios sutiles. Scores no son probabilidades.', 'Timestamps en segundos sobre la línea temporal de reproducción; FPS promedio no implica CFR.'], audioStream:audio?.index ?? null };
}

export function combine(local, suggestions = []) {
  const events = [...local.scenes, ...local.onsets];
  const cuts = events.map(e => ({...e, source:'local'}));
  for (const s of suggestions) {
    const nearest = events.reduce((best,e)=>!best || Math.abs(e.timestamp-s.timestamp)<Math.abs(best.timestamp-s.timestamp) ? e : best,null);
    const matched = nearest && Math.abs(nearest.timestamp-s.timestamp)<=.25;
    cuts.push({ timestamp:matched ? nearest.timestamp : s.timestamp, modelTimestamp:s.timestamp, kind:'suggestion', source:'gemini', reason:s.reason,
      evidence:{ interpretation:s.evidence, local:matched ? nearest : null, alignmentDelta:matched ? nearest.timestamp-s.timestamp : null }, confidence:null });
  }
  return cuts.sort((a,b)=>a.timestamp-b.timestamp);
}

export function cutsCsv(cuts) {
  const cell = x => '"'+String(x ?? '').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
  return '\uFEFFtimestamp_seconds,source,kind,reason,evidence,confidence\r\n'+cuts.map(c=>[c.timestamp,c.source,c.kind,c.reason,JSON.stringify(c.evidence),c.confidence].map(cell).join(',')).join('\r\n');
}
