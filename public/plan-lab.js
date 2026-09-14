import {renderPlan,diagnostics,esc} from './plan-lab-render.js';
const $=id=>document.getElementById(id);
const data=await fetch('walkthrough-2735/comparison.json').then(r=>{if(!r.ok)throw Error('Run node build-2735.mjs first');return r.json();});
const originals=structuredClone(data.plans);let plans=structuredClone(originals),active=1,selected=null,threeD=false,drag=null;
const histories=[[],[],[]];
try{const saved=JSON.parse(localStorage.getItem('atlas-2735-v1'));if(saved?.length===3&&saved.every(p=>p.rooms?.length&&p.rooms.every(r=>['x','y','w','h'].every(k=>Number.isFinite(r[k])))))plans=saved;}catch{}
const time=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
function save(){localStorage.setItem('atlas-2735-v1',JSON.stringify(plans));}
function checkpoint(){histories[active].push(structuredClone(plans[active]));}
function seek(t){if(Number.isFinite(t)&&t>=0&&t<=data.duration){$('video').currentTime=t;$('video').play().catch(()=>{});}}
function cards(){
  $('cards').innerHTML=plans.map((p,i)=>{const d=diagnostics(p);return `<button class="card ${i===active?'selected':''}" data-plan="${i}"><div class="eyebrow">${['ONE PASS','OBSERVE → FIT','FRAME REVIEW'][i]}</div><h3>${esc(p.title)}</h3><p>${esc(['Whole video and narration directly to room coordinates. Raw result, including mistakes.','Separate evidence extraction, layout assembly and geometric consistency fitting.','Independent frame interpretation, hand-arranged as a schematic.'][i])}</p><div class="mini">${renderPlan(p)}</div><div class="stats"><span><b>${d.bedrooms}</b> bedrooms</span><span><b>${d.collisions.length}</b> overlaps</span><span><b>${d.detached.length}</b> unresolved links</span></div></button>`;}).join('');
  document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{active=Number(b.dataset.plan);selected=null;render();});
}
function drawing(bounds){
  const p=plans[active];$('canvas').innerHTML=renderPlan(p,{threeD,selected,atTime:$('reveal').checked?$('video').currentTime:null,bounds});
  const d=diagnostics(p);$('issues').textContent=[d.collisions.length?`${d.collisions.length} overlapping room pair(s).`:'No rectangle overlaps.',d.detached.length?`${d.detached.length} links do not yet meet at a shared wall.`:'All modeled connections meet at shared walls.',d.badTimes.length?`${d.badTimes.length} room/note timestamps exceed the recording; invalid evidence links are disabled.`:'Room/note timestamps are within the recording.','These checks measure consistency, not real-world accuracy.'].join(' ');
}
function details(){
  const p=plans[active],r=p.rooms.find(r=>r.id===selected);
  if(!r){$('selection').innerHTML=`<h3>${esc(p.title)}</h3><p>${esc(p.method)}</p><p>${esc(p.scaleNote)}</p><p>Click a room to inspect notes or make a correction.</p><div class="tag">Unresolved assumptions</div>${p.uncertainties.map(t=>`<p>${esc(t)}</p>`).join('')}`;return;}
  $('selection').innerHTML=`<div class="tag">${esc(r.type.replaceAll('_',' '))} · approximate geometry</div><h3>${esc(r.name)}</h3><label>Room name<input id="roomName" value="${esc(r.name)}"></label><div class="dimensions"><label>Width (layout units)<input id="roomW" type="number" min="15" value="${r.w}"></label><label>Depth (layout units)<input id="roomH" type="number" min="15" value="${r.h}"></label></div><p>Layout units are not measured feet or meters. Changes may create unresolved connections.</p>${(r.notes||[]).map(n=>`<div class="note"><button data-time="${n.time}" ${n.time<0||n.time>data.duration?'disabled':''}>${time(n.time)} ${n.time>data.duration?'invalid':''}</button><span class="tag">${esc(n.source)}</span><p>${esc(n.text)}</p></div>`).join('')}`;
  const apply=document.createElement('button');apply.textContent='Apply room changes';apply.id='applyRoom';
  $('selection').querySelector('.dimensions').after(apply);
  apply.onclick=()=>{const w=Number($('roomW').value),h=Number($('roomH').value);if(w>=15&&w<=1000&&h>=15&&h<=1000){checkpoint();r.name=$('roomName').value.trim()||r.name;r.w=w;r.h=h;save();render();}};
  $('selection').querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>seek(Number(b.dataset.time)));
}
function render(){cards();$('planTitle').textContent=plans[active].title;$('view2d').classList.toggle('active',!threeD);$('view3d').classList.toggle('active',threeD);drawing();details();}
function point(event,svg){const p=new DOMPoint(event.clientX,event.clientY);return p.matrixTransform(svg.getScreenCTM().inverse());}
$('canvas').onpointerdown=e=>{const room=e.target.closest('[data-room]');if(!room)return;selected=room.dataset.room;details();if(threeD){drawing();return;}const svg=$('canvas').querySelector('svg'),p=point(e,svg),r=plans[active].rooms.find(r=>r.id===selected);checkpoint();drag={id:e.pointerId,x:p.x,y:p.y,rx:r.x,ry:r.y,r,bounds:svg.getAttribute('viewBox').split(' ').map(Number)};$('canvas').setPointerCapture(e.pointerId);};
$('canvas').onpointermove=e=>{if(!drag)return;const p=point(e,$('canvas').querySelector('svg'));drag.r.x=Math.round((drag.rx+p.x-drag.x)/5)*5;drag.r.y=Math.round((drag.ry+p.y-drag.y)/5)*5;drawing(drag.bounds);};
function endDrag(){if(drag){drag=null;save();render();}}
$('canvas').onpointerup=endDrag;$('canvas').onpointercancel=endDrag;
$('view2d').onclick=()=>{threeD=false;render();};$('view3d').onclick=()=>{threeD=true;render();};
$('undo').onclick=()=>{if(histories[active].length){plans[active]=histories[active].pop();save();render();}};
$('reset').onclick=()=>{checkpoint();plans[active]=structuredClone(originals[active]);save();render();};
$('reveal').onchange=()=>drawing();$('video').ontimeupdate=()=>{if($('reveal').checked&&!drag)drawing();};
function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('svg').onclick=()=>download(renderPlan(plans[active],{threeD}),`${plans[active].key}${threeD?'-3d':''}.svg`,'image/svg+xml');
$('json').onclick=()=>download(JSON.stringify(plans[active],null,2),`${plans[active].key}.json`,'application/json');
$('transcript').innerHTML=data.transcript.map(t=>`<div class="transcript-row"><button data-time="${t.start}">${time(t.start)}</button><p>${esc(t.text)}</p></div>`).join('');
$('transcript').querySelectorAll('button').forEach(b=>b.onclick=()=>seek(Number(b.dataset.time)));
render();
