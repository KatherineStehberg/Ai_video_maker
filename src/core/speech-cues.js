// Group real word-event boundaries; preserve the original text including punctuation.
export function speechCues(text, marks, duration, maxChars = 78) {
 if (!marks?.length || !Number.isFinite(duration) || duration <= 0) throw new Error('Missing speech timing');
 if(marks.some(m=>!Number.isFinite(m.time)||m.time<0||m.time>=duration))throw new Error('Speech marks exceed actual waveform duration');
 const valid=marks.filter(m=>Number.isFinite(m.time)&&m.time>=0&&m.time<duration&&Number.isInteger(m.offset)&&m.offset>=0&&m.offset<text.length);
 if (!valid.length || valid.some((m,i)=>i&&(m.time<valid[i-1].time||m.offset<valid[i-1].offset))) throw new Error('Invalid speech marks');
 const groups=[];let from=0;
 for(let i=1;i<valid.length;i++) {
  const part=text.slice(valid[from].offset,valid[i].offset).trim();
  if(part.length>maxChars || (part.length>35 && /[.!?]$/.test(part))) {groups.push({from,to:i});from=i;}
 }
 groups.push({from,to:valid.length});
 return groups.map((g,i)=>({start:i===0?0:valid[g.from].time,end:g.to<valid.length?valid[g.to].time:duration,
  text:text.slice(i===0?0:valid[g.from].offset,g.to<valid.length?valid[g.to].offset:text.length).trim()}));
}
