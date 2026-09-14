import { applyEdits, rectangle, sharedEdges } from './homewalk-edits.js';
import { bounds, rotate } from './homewalk-geometry.js';
import { esc } from './homewalk-plan.js';
const $ = id => document.getElementById(id);
let state, selected, native = false, walkFiles = [], pending = [], busy = false, showCurrent = false, drag;
const endpoint = suffix => `/api/homewalk/plans/${state.id}${suffix}`;
async function request(url, body, options = {}) {
  const response = await fetch(url, { method: body == null ? 'GET' : 'POST', headers: body == null ? {} : { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body), ...options });
  const payload = await response.json(); if (!response.ok) throw Error(payload.error || 'Request failed.'); return payload;
}
async function work(label, fn) {
  if (busy) return;
  busy = true; $('error').hidden = true; $('status').textContent = label; toggleBusy();
  try { await fn(); } catch (e) { $('error').textContent = e.message; $('error').hidden = false; }
  finally { busy = false; $('status').textContent = ''; toggleBusy(); }
}
function toggleBusy() { document.querySelectorAll('button,textarea,input,select').forEach(e => e.disabled = busy); if (state) { $('undo').disabled = busy || !state.canUndo; $('room-tools').querySelectorAll('button,input,select').forEach(e => e.disabled = busy || !!state.draft); } }
async function start(plan) { state = await request('/api/homewalk/plans', { plan }); selected = state.plan.rooms[0]?.id; pending = state.evidence.filter(e => !e.used).map(e => e.id); render(); }
window.homewalkInit = async payload => { native = true; await work('Opening your plan…', () => start(payload.plan)); };
window.homewalkMediaReady = payload => { if (payload.error) nativeMediaReject?.(Error(payload.error)); else { state = payload; pending = state.evidence.filter(e => !e.used).map(e => e.id); render(); nativeMediaResolve?.(); } nativeMediaResolve = nativeMediaReject = null; };
let nativeMediaResolve, nativeMediaReject;
async function upload(file, note = '') {
  const mime = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : /\.m4a$/i.test(file.name) ? 'audio/mp4' : 'application/octet-stream');
  state = await request(endpoint(`/evidence?name=${encodeURIComponent(file.name)}&note=${encodeURIComponent(note)}`), null, { method: 'POST', headers: { 'Content-Type': mime }, body: file });
  pending.push(state.evidence.at(-1).id);
}
$('folder').onchange = () => work('Opening capture…', async () => { const files = [...$('folder').files], file = files.find(f => f.name === 'plan-enriched.json') ?? files.find(f => f.name === 'plan.json'); if (!file) throw Error('Choose a folder containing plan.json.'); walkFiles = files.filter(f => /^(walk-video\.mov|walk-audio\.m4a|proxy\.mp4|replay\.mp4)$/.test(f.name)); await start(JSON.parse(await file.text())); });
$('sample').onclick = () => work('Opening sample…', async () => start(await (await fetch('/fixtures/homewalk-sample.homewalk/plan.json')).json()));
$('attach').onchange = () => work('Adding your evidence…', async () => { for (const file of $('attach').files) await upload(file); $('attach').value = ''; render(); $('message').focus(); });
function notifyNative() { if (native) window.webkit.messageHandlers.homewalk.postMessage({ type: 'planChanged', plan: state.plan, revision: state.revision, kind: state.kind }); }
async function edit(operations, label) { state = await request(endpoint('/edit'), { revision: state.revision, operations, label }); render(); notifyNative(); }
function currentPlan() { return state.draft && !showCurrent ? state.draft.plan : state.plan; }
function evidenceText(text) { for (const e of state.evidence) text = String(text).replaceAll(e.id, e.name); return text; }
function render() {
  $('loader').hidden = true; $('workspace').hidden = false;
  $('version').textContent = `${state.draft && !showCurrent ? 'Preview · ' : ''}Version ${state.revision + 1} · ${currentPlan().rooms.length} areas`;
  $('kind').textContent = (state.draft && !showCurrent ? state.draft.kind : state.kind) === 'proposal' ? 'Proposed layout · hypothetical' : 'Your captured home';
  if (!currentPlan().rooms.some(r => r.id === selected)) selected = currentPlan().rooms[0]?.id;
  draw(currentPlan());
  const room = currentPlan().rooms.find(r => r.id === selected);
  $('room-name').value = room?.name ?? '';
  $('neighbor').innerHTML = currentPlan().rooms.filter(r => r.id !== selected).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  $('draft').hidden = !state.draft;
  $('draft-text').textContent = state.draft?.explanation ?? '';
  $('compare').textContent = showCurrent ? 'Show proposed changes' : 'Show current plan';
  $('messages').innerHTML = state.messages.map(m => `<div class="bubble ${esc(m.role)}">${esc(evidenceText(m.text))}${(m.evidenceNotes ?? []).map(n => `<div class="evidence-note">${esc(evidenceText(n))}</div>`).join('')}${m.validationError ? `<div class="evidence-note">No change prepared: ${esc(m.validationError)}</div>` : ''}</div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
  $('attachments').innerHTML = state.evidence.map(e => `<span class="attachment">${e.used ? '✓' : '+'} ${esc(e.name)}${pending.includes(e.id) ? ' · included next' : ''}</span>`).join('');
  $('warnings').innerHTML = [...new Set([...(state.warnings ?? []), ...(state.draft?.warnings ?? [])])].map(w => `<li>${esc(w)}</li>`).join('');
  $('history').innerHTML = state.history.map(h => `<option value="${h.revision}" ${h.revision === state.revision ? 'selected' : ''}>${h.revision + 1}. ${esc(h.label)}</option>`).join('');
  toggleBusy();
}
function draw(doc, snapping = false) {
  const angle = doc.geo?.headingAligned ? doc.floor?.gridAngle ?? 0 : 0;
  const points = [...doc.rooms.flatMap(r => r.editedPolygon), ...(doc.site?.footprintPlan ?? [])].map(p => rotate(p, angle));
  const b = bounds(points) ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 }, pad = 1.3;
  const view = `${b.minX - pad} ${b.minY - pad} ${b.maxX - b.minX + 2 * pad} ${b.maxY - b.minY + 2 * pad}`;
  const pts = poly => poly.map(p => `${p.x},${p.y}`).join(' ');
  const room = doc.rooms.find(r => r.id === selected);
  let handles = '';
  if (room && !state.draft) { try { const r = rectangle(room); handles = [['minX', r.minX, (r.minY + r.maxY) / 2], ['maxX', r.maxX, (r.minY + r.maxY) / 2], ['minY', (r.minX + r.maxX) / 2, r.minY], ['maxY', (r.minX + r.maxX) / 2, r.maxY]].map(([side, x, y]) => `<circle class="handle" data-side="${side}" cx="${x}" cy="${y}" r=".22" fill="${snapping ? '#c69b3e' : '#315d4c'}" stroke="white" stroke-width=".08"/><circle class="handle" data-side="${side}" cx="${x}" cy="${y}" r=".5" fill="transparent"/>`).join(''); } catch {} }
  $('canvas').innerHTML = `<svg viewBox="${view}" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(${angle * 180 / Math.PI})" id="plan-frame">${doc.site?.footprintPlan ? `<polygon points="${pts(doc.site.footprintPlan)}" fill="#dbece7" stroke="#4b9f99" stroke-width=".08"/>` : ''}${doc.rooms.map(r => { const bb = bounds(r.editedPolygon), center = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }; return `<g class="room" data-room="${esc(r.id)}"><polygon points="${pts(r.editedPolygon)}" fill="${r.id === selected ? '#e7ce84' : '#dde3cb'}" fill-opacity=".7" stroke="#315d4c" stroke-width=".06" ${r.isApproximate ? 'stroke-dasharray=".15 .08"' : ''}/><text x="${center.x}" y="${center.y}" text-anchor="middle" font-size=".36" fill="#243630" transform="rotate(${-angle * 180 / Math.PI} ${center.x} ${center.y})">${esc(r.name)}</text></g>`; }).join('')}${(doc.doorways ?? []).map(d => `<line x1="${d.endpointA.x}" y1="${d.endpointA.y}" x2="${d.endpointB.x}" y2="${d.endpointB.y}" stroke="#fffdf8" stroke-width=".16"/>`).join('')}${handles}</g></svg>`;
  $('canvas').querySelectorAll('[data-room]').forEach(g => g.onclick = () => { if (!drag && !busy) { selected = g.dataset.room; render(); } });
  $('hint').textContent = snapping ? 'Nearby wall found — release to snap.' : doc.geo?.headingAligned ? 'North up · Tap a room, then drag a wall. One gesture = one Undo.' : 'Tap a room, then drag a wall. One gesture = one Undo.';
}
function pointerPlan(event) { const svg = $('canvas').querySelector('svg'), frame = $('plan-frame'); return new DOMPoint(event.clientX, event.clientY).matrixTransform(frame.getScreenCTM().inverse()); }
$('canvas').onpointerdown = event => { const side = event.target.dataset.side; if (!side || busy || state.draft) return; event.preventDefault(); drag = { side, roomID: selected, plan: structuredClone(state.plan), revision: state.revision }; $('canvas').setPointerCapture(event.pointerId); };
$('canvas').onpointermove = event => {
  if (!drag) return;
  const p = pointerPlan(event), axis = drag.side.endsWith('X') ? 'x' : 'y'; let value = p[axis], snapping = false;
  const b = rectangle(drag.plan.rooms.find(r => r.id === drag.roomID));
  for (const r of drag.plan.rooms.filter(r => r.id !== drag.roomID)) { let n; try { n = rectangle(r); } catch { continue; } const other = (drag.side.startsWith('min') ? 'max' : 'min') + drag.side.slice(3); const cross = axis === 'x' ? 'Y' : 'X'; if (Math.min(b[`max${cross}`], n[`max${cross}`]) - Math.max(b[`min${cross}`], n[`min${cross}`]) > .3 && Math.abs(value - n[other]) < .25) { value = n[other]; snapping = true; break; } }
  const op = { type: 'moveWall', roomID: drag.roomID, side: drag.side, value };
  try { const preview = applyEdits(drag.plan, [op]); drag.op = op; draw(preview, snapping); } catch (e) { drag.op = null; $('hint').textContent = e.message; }
};
$('canvas').onpointerup = () => { if (!drag) return; const op = drag.op; drag = null; if (op) work('Saving wall adjustment…', () => edit([op], 'Moved shared wall')); else render(); };
$('canvas').onpointercancel = () => { drag = null; render(); };
$('room-name').onfocus = () => setTimeout(() => $('room-name').select(), 0);
$('rename').onclick = () => work('Renaming…', () => edit([{ type: 'renameRoom', roomID: selected, name: $('room-name').value }], 'Renamed room'));
for (const [id, type] of [['join', 'joinRooms'], ['merge', 'mergeRooms']]) $(id).onclick = () => work('Adjusting rooms…', () => edit([{ type, roomID: selected, otherRoomID: $('neighbor').value }], id === 'join' ? 'Snapped rooms together' : 'Merged rooms'));
for (const axis of ['x', 'y']) $(`split-${axis}`).onclick = () => work('Adding divider…', async () => { const b = rectangle(state.plan.rooms.find(r => r.id === selected)), a = axis.toUpperCase(); await edit([{ type: 'splitRoom', roomID: selected, axis, value: (b[`min${a}`] + b[`max${a}`]) / 2 }], 'Added room divider'); });
$('compare').onclick = () => { showCurrent = !showCurrent; render(); };
for (const id of ['keep', 'discard']) $(id).onclick = () => work(id === 'keep' ? 'Keeping revision…' : 'Discarding preview…', async () => { state = await request(endpoint('/draft'), { revision: state.revision, draftID: state.draft.id, accept: id === 'keep' }); showCurrent = false; render(); notifyNative(); });
$('restore').onclick = () => work('Restoring version…', async () => { state = await request(endpoint('/restore'), { revision: state.revision, target: Number($('history').value) }); render(); notifyNative(); });
$('reset').onclick = () => work('Restoring original…', async () => { state = await request(endpoint('/restore'), { revision: state.revision, target: 0 }); render(); notifyNative(); });
$('undo').onclick = () => work('Undoing…', async () => { state = await request(endpoint('/undo'), { revision: state.revision }); render(); notifyNative(); });
async function chat(assemble = false) {
  state = await request(endpoint('/chat'), { revision: state.revision, message: assemble ? 'Assemble the rooms from this walk. Use the recording and original path; identify uncertain intervals and connections supported by evidence.' : $('message').value, evidenceIDs: pending, assemble });
  pending = []; $('message').value = ''; showCurrent = false; render();
}
$('chat').onsubmit = e => { e.preventDefault(); work('Reviewing your evidence and request…', () => chat()); };
$('assemble').onclick = () => work('Preparing the walk for room assembly…', async () => {
  if (native && !state.evidence.some(e => e.note === 'Original walk recording')) {
    await new Promise((resolve, reject) => { nativeMediaResolve = resolve; nativeMediaReject = reject; window.webkit.messageHandlers.homewalk.postMessage({ type: 'uploadWalk', projectID: state.id }); });
  } else if (!native && walkFiles.length && !state.evidence.some(e => e.note === 'Original walk recording')) {
    const proxy = walkFiles.find(f => /^(proxy|replay)\.mp4$/.test(f.name));
    for (const file of proxy ? [proxy] : walkFiles) await upload(file, 'Original walk recording');
  }
  if (!state.evidence.some(e => e.mime.startsWith('video/') || e.mime.startsWith('audio/'))) throw Error('Add the walk recording first, or open the complete capture folder.');
  $('status').textContent = 'Finding rooms and connections in the recording…'; await chat(true);
});
$('recording').onclick = () => { const video = state.evidence.find(e => e.mime.startsWith('video/')); if (!video) { $('error').textContent = 'Add the original walk video to seek room evidence.'; $('error').hidden = false; return; } const player = $('evidence-player'); player.hidden = false; player.src = endpoint(`/evidence/${video.id}`); const room = state.plan.rooms.find(r => r.id === selected); player.onloadedmetadata = () => { player.currentTime = Math.max(0, (room.walkStartedAt ?? 0) - (state.plan.media?.videoStartedAt ?? room.walkStartedAt ?? 0)); player.play().catch(() => {}); }; player.scrollIntoView({ behavior: 'smooth' }); };
$('export').onclick = () => { const blob = new Blob([JSON.stringify(state.plan, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'plan-enriched.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
const project = new URLSearchParams(location.search).get('project');
if (project) work('Opening saved plan…', async () => { state = await request(`/api/homewalk/plans/${encodeURIComponent(project)}`); pending = state.evidence.filter(e => !e.used).map(e => e.id); render(); });
if (new URLSearchParams(location.search).has('sample')) $('sample').click();
if (window.webkit?.messageHandlers?.homewalk) window.webkit.messageHandlers.homewalk.postMessage({ type: 'ready' });
