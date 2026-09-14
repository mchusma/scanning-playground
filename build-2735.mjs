import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { renderPlan, diagnostics, overlap, sharedDoor } from './public/plan-lab-render.js';
import { generateFloorPlanSVG } from './public/svg-export.js';
const dir='test-output/walkthrough-2735',dest='public/walkthrough-2735';
mkdirSync(dest,{recursive:true});
const read=n=>JSON.parse(readFileSync(`${dir}/${n}.json`));
const manual = existsSync(`${dir}/manual-input.json`) ? read('manual-input') : {
  title: 'C · Manual interpretation', method: 'No manual interpretation supplied',
  summary: 'Add a private manual-input.json to the experiment output folder to compare it.',
  orientation: 'Unknown', scaleNote: 'No measured dimensions', rooms: [], edges: [], walk: [], uncertainties: [],
};
const direct=read('direct'),seed=read('constrained-seed'),evidence=read('evidence');
const constrained=structuredClone(seed);
// Small deterministic rectangle fitter. It preserves the LLM's direction/shape
// hypotheses, penalizes overlap, and searches translations that align openings.
function score(plan,initial){
  let s=0;
  for(let i=0;i<plan.rooms.length;i++){
    const a=plan.rooms[i],o=initial.rooms[i];s+=0.002*((a.x-o.x)**2+(a.y-o.y)**2);
    for(let j=i+1;j<plan.rooms.length;j++)s+=20*overlap(a,plan.rooms[j]);
  }
  for(const e of plan.edges){const a=plan.rooms.find(r=>r.id===e.from),b=plan.rooms.find(r=>r.id===e.to);if(!a||!b)continue;
    if(sharedDoor(a,b))continue;
    const gapX=Math.max(0,a.x-b.x-b.w,b.x-a.x-a.w),gapY=Math.max(0,a.y-b.y-b.h,b.y-a.y-a.h);
    s+=200+2*(gapX**2+gapY**2);
  }
  return s;
}
const before=score(constrained,seed);
for(let pass=0;pass<25;pass++){
  let changed=false;
  for(const r of constrained.rooms){
    const candidates=[];
    for(const e of constrained.edges){const otherId=e.from===r.id?e.to:e.to===r.id?e.from:null;const n=constrained.rooms.find(q=>q.id===otherId);if(!n)continue;
      for(const y of [r.y,n.y,n.y+n.h-r.h,n.y+(n.h-r.h)/2])for(const x of [n.x-r.w,n.x+n.w])candidates.push([x,y]);
      for(const x of [r.x,n.x,n.x+n.w-r.w,n.x+(n.w-r.w)/2])for(const y of [n.y-r.h,n.y+n.h])candidates.push([x,y]);
    }
    const old=[r.x,r.y];let best=old,bestScore=score(constrained,seed);
    for(const [x,y] of candidates){r.x=x;r.y=y;const candidateScore=score(constrained,seed);if(candidateScore<bestScore-0.001){bestScore=candidateScore;best=[x,y];}}
    [r.x,r.y]=best;if(best[0]!==old[0]||best[1]!==old[1])changed=true;
  }
  if(!changed)break;
}
constrained.title='B · Evidence + rectangle fitting';
constrained.method='Video/audio evidence ledger → LLM layout → deterministic rectangle fitting';
constrained.fit={before,after:score(constrained,seed),beforeDiagnostics:diagnostics(seed)};
constrained.uncertainties.push('Fitting improves geometric consistency only; it cannot establish true dimensions or correct unsupported directional assumptions.');
direct.title='A · Direct video → 2D';
direct.method='Single whole-video/audio LLM call; raw coordinates retained';
const plans=[direct,constrained,manual];
for(const [i,p] of plans.entries()){
  p.key=['direct','constrained','manual'][i];p.diagnostics=diagnostics(p);
  writeFileSync(`${dest}/${p.key}.svg`,renderPlan(p));
  writeFileSync(`${dest}/${p.key}-3d.svg`,renderPlan(p,{threeD:true}));
  writeFileSync(`${dest}/${p.key}.json`,JSON.stringify(p,null,2));
  // Adapter for the repository's original SVG export renderer.
  const home={rooms:new Map(p.rooms.map(r=>[r.id,{...r,x:r.x+r.w/2,y:r.y+r.h/2,width:r.w,height:r.h,roomType:r.type.replaceAll('_',' '),features:(r.notes||[]).map(n=>n.text)}])),edges:p.edges.map(e=>({...e,fromId:e.from,toId:e.to,pathType:e.kind}))};
  writeFileSync(`${dest}/${p.key}-legacy.svg`,generateFloorPlanSVG(home,{animate:false,title:p.title}));
}
writeFileSync(`${dir}/constrained.json`,JSON.stringify(constrained,null,2));
writeFileSync(`${dest}/comparison.json`,JSON.stringify({duration:124.113,plans,transcript:evidence.transcript,transitions:evidence.transitions},null,2));
copyFileSync(`${dir}/video.mp4`,`${dest}/video.mp4`);
copyFileSync(`${dir}/contact.jpg`,`${dest}/contact.jpg`);
console.log(JSON.stringify(plans.map(p=>({method:p.key,...p.diagnostics,fit:p.fit})),null,2));
