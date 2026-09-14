export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function color(r) {
  const t = r.type.replaceAll('_',' ');
  return t.includes('bed')?'#e9dff2':t.includes('bath')?'#d5e9ed':t.includes('kitchen')?'#f0dfbc':t.includes('outdoor')?'#dce8cd':t.includes('hall')?'#e9e5db':t.includes('garage')?'#dce0e6':t.includes('closet')?'#e4dce2':'#e5e8c9';
}
export function overlap(a,b) { return Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)); }
export function sharedDoor(a,b) {
  const loY=Math.max(a.y,b.y),hiY=Math.min(a.y+a.h,b.y+b.h),loX=Math.max(a.x,b.x),hiX=Math.min(a.x+a.w,b.x+b.w);
  if(hiY-loY>8 && Math.abs(a.x+a.w-b.x)<2) return {x:b.x,y:(loY+hiY)/2,vertical:true};
  if(hiY-loY>8 && Math.abs(b.x+b.w-a.x)<2) return {x:a.x,y:(loY+hiY)/2,vertical:true};
  if(hiX-loX>8 && Math.abs(a.y+a.h-b.y)<2) return {x:(loX+hiX)/2,y:b.y,vertical:false};
  if(hiX-loX>8 && Math.abs(b.y+b.h-a.y)<2) return {x:(loX+hiX)/2,y:a.y,vertical:false};
  return null;
}
export function diagnostics(p) {
  const collisions=[];const ids=new Set(p.rooms.map(r=>r.id));
  for(let i=0;i<p.rooms.length;i++)for(let j=i+1;j<p.rooms.length;j++)if(overlap(p.rooms[i],p.rooms[j])>1)collisions.push([p.rooms[i].name,p.rooms[j].name]);
  const detached=p.edges.filter(e=>{const a=p.rooms.find(r=>r.id===e.from),b=p.rooms.find(r=>r.id===e.to);return a&&b&&!sharedDoor(a,b);});
  const badTimes=[];
  for(const r of p.rooms){if(r.firstSeen<0||r.firstSeen>124.114)badTimes.push({room:r.name,time:r.firstSeen});for(const n of r.notes||[])if(n.time<0||n.time>124.114)badTimes.push({room:r.name,time:n.time});}
  const invalidEdges=p.edges.filter(e=>!ids.has(e.from)||!ids.has(e.to));
  return {bedrooms:p.rooms.filter(r=>r.type.includes('bed')).length,spaces:p.rooms.length,collisions,detached:detached.map(e=>[e.from,e.to]),badTimes,invalidEdges};
}
export function renderPlan(plan, {threeD=false,selected=null,atTime=null,bounds=null}={}) {
  const rooms=plan.rooms;
  const minX=Math.min(...rooms.map(r=>r.x))-35,maxX=Math.max(...rooms.map(r=>r.x+r.w))+35;
  const minY=Math.min(...rooms.map(r=>r.y))-35,maxY=Math.max(...rooms.map(r=>r.y+r.h))+35;
  const project=(x,y,z=0)=>threeD?[0.82*(x-y),0.40*(x+y)-z]:[x,y];
  const corners=[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]].flatMap(([x,y])=>[project(x,y),project(x,y,35)]);
  const bx=Math.min(...corners.map(p=>p[0])),by=Math.min(...corners.map(p=>p[1])),bw=Math.max(...corners.map(p=>p[0]))-bx,bh=Math.max(...corners.map(p=>p[1]))-by;
  const vb=bounds||[bx,by,bw,bh];
  const polygon=(pts,attrs)=>`<polygon points="${pts.map(p=>p.join(',')).join(' ')}" ${attrs}/>`;
  let out=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" role="img" aria-label="${esc(plan.title)} — approximate floor plan"><rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#faf8f2"/><g font-family="Inter,Arial,sans-serif">`;
  for(const r of [...rooms].sort((a,b)=>threeD?(a.x+a.y)-(b.x+b.y):0)){
    const dim=atTime!==null&&r.firstSeen>atTime,fill=color(r),x=r.x,y=r.y,w=r.w,h=r.h,z=r.type==='outdoor'?2:18;
    out+=`<g data-room="${esc(r.id)}" opacity="${dim?0.14:1}" style="cursor:pointer">`;
    out+=polygon([[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([a,b])=>project(a,b)),`fill="${fill}" stroke="${selected===r.id?'#e46b3b':'#56685f'}" stroke-width="${selected===r.id?4:1.7}"`);
    if(threeD){
      out+=polygon([project(x,y),project(x+w,y),project(x+w,y,z),project(x,y,z)],'fill="#eee9df" stroke="#afa99a" stroke-width="1"');
      out+=polygon([project(x,y),project(x,y+h),project(x,y+h,z),project(x,y,z)],'fill="#dcd8cd" stroke="#afa99a" stroke-width="1"');
    }
    out+=`<title>${esc(r.name)}: ${esc(r.notes?.[0]?.text||'')}</title></g>`;
  }
  out+='<g pointer-events="none">';
  if(!threeD)for(const e of plan.edges){
    const a=rooms.find(r=>r.id===e.from),b=rooms.find(r=>r.id===e.to);if(!a||!b)continue;
    const door=sharedDoor(a,b);const dim=atTime!==null&&(a.firstSeen>atTime||b.firstSeen>atTime);
    if(door){const {x,y,vertical}=door,sz=/open/.test(e.kind)?14:7;out+=`<path opacity="${dim?0.12:1}" d="M ${x-(vertical?0:sz)} ${y-(vertical?sz:0)} L ${x+(vertical?0:sz)} ${y+(vertical?sz:0)}" stroke="#faf8f2" stroke-width="5"/><circle cx="${x}" cy="${y}" r="2.5" fill="#48776a" opacity="${dim?0.12:1}"/>`;}
    else out+=`<path d="M ${a.x+a.w/2} ${a.y+a.h/2} L ${b.x+b.w/2} ${b.y+b.h/2}" stroke="#c78659" stroke-width="1.2" stroke-dasharray="4 4" opacity="${dim?0.12:0.65}"/>`;
  }
  out+='</g>';
  for(const r of rooms){
    const [x,y]=project(r.x+r.w/2,r.y+r.h/2),dim=atTime!==null&&r.firstSeen>atTime;
    let words=r.name.split(' '),lines=[];for(const word of words){if(lines.length&&`${lines.at(-1)} ${word}`.length<(threeD?17:Math.max(7,r.w/7)))lines[lines.length-1]+=' '+word;else lines.push(word);}
    const size=threeD?8:Math.min(11,Math.max(7,r.w/8));
    out+=`<g pointer-events="none" opacity="${dim?0.15:1}"><text x="${x}" y="${y-(lines.length-1)*size*0.6}" text-anchor="middle" font-size="${size}" font-weight="600" fill="#293c35">${lines.map((line,i)=>`<tspan x="${x}" dy="${i?size*1.2:0}">${esc(line)}</tspan>`).join('')}</text></g>`;
  }
  return out+'</g></svg>';
}
