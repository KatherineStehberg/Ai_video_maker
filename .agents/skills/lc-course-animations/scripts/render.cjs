const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn, spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright-core');

(async () => {
  const [html, directory, ...flags] = process.argv.slice(2);
  if (!html || !directory) throw Error('Usage: node render.cjs input.html output-dir [--qa]');
  const out = path.resolve(directory);
  if (fs.existsSync(out)) throw Error('Output directory exists; use a new path');
  const exe = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
  ].find(p => fs.existsSync(p));
  if (!exe) throw Error('Set CHROME_PATH to an installed Chrome/Chromium binary');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  for (const bin of [ffmpeg,ffprobe]) {
    const r = spawnSync(bin,['-version'],{encoding:'utf8'});
    if (r.status !== 0) throw Error(`${bin} unavailable: ${r.error?.message || r.stderr}`);
  }
  fs.mkdirSync(out,{recursive:true});
  const browser = await chromium.launch({executablePath:exe,headless:true});
  let encoder;
  try {
    const page = await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    const errors = [];
    page.on('pageerror',e => errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve(html)).href+'?capture');
    await page.waitForFunction(() => typeof window.renderAt === 'function');
    await page.evaluate(() => document.fonts.ready);
    const duration = await page.evaluate(() => window.duration);
    if (!Number.isFinite(duration) || duration < 6 || duration > 120) throw Error('Invalid animation duration');
    const times = [0,duration*.1,duration*.4,duration*.65,duration*.9];
    const hashes = [];
    for (let i=0;i<times.length;i++) {
      await page.evaluate(t => window.renderAt(t),times[i]);
      const jpg = await page.screenshot({type:'jpeg',quality:87,path:path.join(out,`qa-${i}.jpg`)});
      hashes.push(createHash('sha256').update(jpg).digest('hex'));
    }
    if (errors.length) throw Error(errors.join('\n'));
    if (new Set(hashes).size < 3) throw Error('Animation samples show insufficient visual changes');
    const report = {width:1920,height:1080,duration,fps:24,audio:'none',qaTimes:times,frameHashes:hashes,rendered:false};
    if (!flags.includes('--qa')) {
      const partial = path.join(out,'animation.partial.mp4');
      encoder = spawn(ffmpeg,['-y','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-framerate','24','-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',partial]);
      let err = '';
      encoder.stderr.on('data',d => err += d);
      const done = new Promise((resolve,reject) => {encoder.once('error',reject);encoder.once('close',code => code === 0 ? resolve() : reject(Error(err || `FFmpeg exit ${code}`)));});
      // Handle early encoder failure while screenshots are being produced.
      done.catch(() => {});
      const total = Math.ceil(duration*24);
      for (let frame=0;frame<total;frame++) {
        if (encoder.exitCode !== null) throw Error(err || 'FFmpeg stopped');
        await page.evaluate(t => window.renderAt(t),frame/24);
        const jpg = await page.screenshot({type:'jpeg',quality:87});
        if (!encoder.stdin.write(jpg)) await new Promise((resolve,reject) => {
          const drain=()=>{cleanup();resolve();}; const fail=e=>{cleanup();reject(e);};
          const cleanup=()=>{encoder.stdin.off('drain',drain);encoder.stdin.off('error',fail);};
          encoder.stdin.once('drain',drain);encoder.stdin.once('error',fail);
        });
        if (frame % 96 === 0) console.log(`Frame ${frame}/${total}`);
      }
      encoder.stdin.end(); await done;
      const probe = spawnSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',partial],{encoding:'utf8'});
      if (probe.status !== 0) throw Error(probe.stderr);
      const data = JSON.parse(probe.stdout); const v=data.streams.find(s => s.codec_type==='video');
      if (!v || v.width!==1920 || v.height!==1080 || v.codec_name!=='h264' || v.pix_fmt!=='yuv420p' || v.avg_frame_rate!=='24/1' || Number(v.nb_frames)!==total || Math.abs(Number(data.format.duration)-duration)>1/24+.01) throw Error('MP4 metadata differs from animation contract');
      const decode=spawnSync(ffmpeg,['-v','error','-i',partial,'-f','null','-'],{encoding:'utf8'});
      if (decode.status!==0) throw Error(decode.stderr);
      fs.renameSync(partial,path.join(out,'animation.mp4'));
      Object.assign(report,{rendered:true,measuredDuration:Number(data.format.duration),frames:total,sha256:createHash('sha256').update(fs.readFileSync(path.join(out,'animation.mp4'))).digest('hex')});
    }
    fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally { if (encoder && encoder.exitCode===null) encoder.kill(); await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
