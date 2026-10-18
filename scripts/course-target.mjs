import fs from 'node:fs';
export function courseTarget(id = 'RPM-2026-001') {
 const pack=JSON.parse(fs.readFileSync(new URL('../content/courses/lc-chile-20261004.json',import.meta.url),'utf8'));
 const item=pack.items.find(i=>i.id===id);if(!item)throw new Error('Unknown prepared course: '+id);
 return {courseId:id,projectId:'vid_course_'+id,assetRoot:'data/assets/images/lc-chile-courses/prepared-'+id,item};
}
