import { renderSVG, esc } from './homewalk-plan.js';

const $ = id => document.getElementById(id);
const NUM = ['pad', 'minSide', 'sharedWallMaxShift', 'minRayFloorDot', 'maxHitDistance', 'yawMinSamples', 'yawMinInlierFraction'];
const DEFAULTS = { pad: 0.5, minSide: 1.2, measureFromHits: false, minRayFloorDot: 0.3, maxHitDistance: 4, sharedWallMaxShift: 1.2, yawMinSamples: 40, yawMinInlierFraction: 0.35, gridAngleOverride: null };
let snap = null, settings = null, showHits = true, showPath = true, ws = null, lastLocalEdit = 0;

function log(msg) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent.slice(0, 4000);
}

// ---------- websocket ----------

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live?role=viewer`);
  ws.onopen = () => log('viewer connected to relay');
  ws.onclose = () => { log('relay closed, retrying'); setTimeout(connect, 2000); };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'snapshot') return;
    snap = msg;
    // Don't fight the user's slider with the phone's echo for a moment after an edit.
    if (Date.now() - lastLocalEdit > 1500) { settings = { ...DEFAULTS, ...(msg.settings ?? {}) }; syncControls(); }
    render();
  };
}
connect();

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  else log('not connected');
}

function pushSettings(rebox = false) {
  lastLocalEdit = Date.now();
  send({ type: 'settings', settings, rebox });
  log(`settings → phone (pad ${settings.pad.toFixed(2)}, hits ${settings.measureFromHits}, grid ${settings.gridAngleOverride == null ? 'auto' : (settings.gridAngleOverride * 180 / Math.PI).toFixed(1) + '°'})${rebox ? ' + re-box' : ''}`);
}

// ---------- controls ----------

for (const id of NUM) {
  $(id).oninput = () => { $(`${id}-v`).textContent = fmt(id, Number($(id).value)); };
  $(id).onchange = () => { if (!settings) return; settings[id] = Number($(id).value); pushSettings(); };
}
$('measureFromHits').onchange = () => { if (!settings) return; settings.measureFromHits = $('measureFromHits').checked; pushSettings(); };
$('overrideOn').onchange = () => {
  if (!settings) return;
  if ($('overrideOn').checked) {
    const deg = snap?.grid?.applied ?? snap?.grid?.angleDegrees ?? 0;
    $('overrideDeg').value = deg; $('overrideDeg-v').textContent = `${Number(deg).toFixed(1)}°`;
    settings.gridAngleOverride = deg * Math.PI / 180;
  } else settings.gridAngleOverride = null;
  pushSettings();
};
$('overrideDeg').oninput = () => { $('overrideDeg-v').textContent = `${Number($('overrideDeg').value).toFixed(1)}°`; };
$('overrideDeg').onchange = () => { if (!settings || !$('overrideOn').checked) return; settings.gridAngleOverride = Number($('overrideDeg').value) * Math.PI / 180; pushSettings(); };
$('align').onclick = () => { send({ type: 'command', name: 'alignNow' }); log('command → alignNow'); };
$('rebox').onclick = () => { if (settings) pushSettings(true); };
$('door').onclick = () => { send({ type: 'command', name: 'throughDoor' }); log('command → throughDoor'); };
$('reset').onclick = () => {
  settings = { ...DEFAULTS };
  syncControls(); pushSettings();
};
$('hits').onclick = () => { showHits = !showHits; $('hits').classList.toggle('active', showHits); render(); };
$('path').onclick = () => { showPath = !showPath; $('path').classList.toggle('active', showPath); render(); };

function fmt(id, v) {
  if (id === 'yawMinSamples') return String(v);
  if (['pad', 'minSide', 'sharedWallMaxShift', 'maxHitDistance'].includes(id)) return `${v.toFixed(2)} m`;
  return v.toFixed(2);
}

function syncControls() {
  if (!settings) return;
  for (const id of NUM) { $(id).value = settings[id]; $(`${id}-v`).textContent = fmt(id, settings[id]); }
  $('measureFromHits').checked = Boolean(settings.measureFromHits);
  const on = settings.gridAngleOverride != null;
  $('overrideOn').checked = on;
  const deg = on ? settings.gridAngleOverride * 180 / Math.PI : (snap?.grid?.applied ?? 0);
  $('overrideDeg').value = deg; $('overrideDeg-v').textContent = `${Number(deg).toFixed(1)}°`;
}

// ---------- rendering ----------

function render() {
  if (!snap) return;
  $('dot').classList.add('on');
  $('pill').innerHTML = `<span class="dot on"></span>${esc(snap.name)} · ${esc(snap.tracking)}${snap.walking ? ' · recording' : ''}`;
  $('title').textContent = `${snap.inProgress.label}${snap.inProgress.size ? ` · ${snap.inProgress.size.x.toFixed(1)} × ${snap.inProgress.size.y.toFixed(1)} m` : ''}`;
  const card = (label, value, cls = '') => `<div class="${cls}"><b>${value}</b><span>${label}</span></div>`;
  const ip = snap.inProgress, g = snap.grid, m = snap.media;
  $('stats').innerHTML =
    card('rooms', snap.rooms.length) +
    card('walked (raw)', ip.rawSize ? `${ip.rawSize.x.toFixed(1)} × ${ip.rawSize.y.toFixed(1)}` : '—') +
    card('box', ip.size ? `${ip.size.x.toFixed(1)} × ${ip.size.y.toFixed(1)}` : '—') +
    card('poses', `${ip.poseCount}`) +
    card('cam height', ip.lastCameraHeight != null ? `${ip.lastCameraHeight.toFixed(2)} m` : '—', ip.lastCameraHeight != null && (ip.lastCameraHeight < 0.9 || ip.lastCameraHeight > 1.8) ? 'bad' : '') +
    card('yaw', ip.lastYawDegrees != null ? `${ip.lastYawDegrees.toFixed(0)}°` : '—') +
    card('grid', g.applied != null ? `${g.applied.toFixed(1)}° set` : (g.angleDegrees != null ? `${g.angleDegrees.toFixed(1)}° est` : '—'), g.applied != null ? 'good' : '') +
    card('yaw votes', `${g.yawVotes}`) +
    card('video', m.recording ? `${m.videoFrames}${m.videoDropped ? ` (−${m.videoDropped})` : ''}` : 'off', m.videoDropped > 20 ? 'bad' : '') +
    card('door checks', snap.checks.length ? snap.checks.map(c => `${(c * 100).toFixed(0)}`).join(' / ') + ' cm' : '—', snap.checks.some(c => c > 0.25) ? 'bad' : (snap.checks.length ? 'good' : '')) +
    card('geo', snap.geo ? `±${snap.geo.accuracy.toFixed(0)} m${snap.geo.headingAligned ? ' · compass' : ''}` : 'no fix', snap.geo?.headingAligned ? 'good' : '') +
    card('footprint', snap.footprint?.length ? (snap.siteNote ?? 'placed') : 'none') +
    card('prompt', snap.prompt ? `${snap.prompt} (${snap.promptsDone}/${snap.promptsTotal})` : `all ${snap.promptsTotal} done`, snap.prompt ? '' : 'good') +
    card('heard', (snap.captured ?? []).slice(-4).join(', ') || '—');
  if (snap.heard?.length) log(`heard: ${snap.heard.at(-1)}`);
  $('gridNote').textContent = `${snap.phase} · ${g.pathMeters.toFixed(1)} m walked in total${snap.mismatches.length ? ' · ' + snap.mismatches.join(' · ') : ''}`;

  // Build a doc-shaped object for the shared renderer: closed rooms plus the live box as a room.
  const doc = {
    name: snap.name,
    rooms: snap.rooms.map(r => ({ id: r.id, name: r.name, type: r.type, editedPolygon: r.polygon, walkTrail: [], tapeSize: r.tape })),
    doorways: snap.doorways.map(d => ({ endpointA: d.a, endpointB: d.b, connectedRoomIDs: d.rooms })),
    alignmentChecks: [],
  };
  if (ip.box?.length) doc.rooms.push({ id: 'live', name: `${ip.label} (live)`, type: 'other', editedPolygon: ip.box, walkTrail: showPath ? ip.samples : [] });
  if (snap.footprint?.length) doc.footprint = snap.footprint;
  let svg = renderSVG(doc, { selected: 'live', showTrail: true, showPath: false, pxPerMeter: snap.footprint?.length ? 28 : 50 });
  if (showHits && ip.hits?.length) {
    // Overlay hit dots using the same metre→px mapping the renderer used (read its viewBox and bounds).
    svg = svg.replace('</g></svg>', hitsLayer(doc, ip) + '</g></svg>');
  }
  $('map').innerHTML = svg;
}

function hitsLayer(doc, ip) {
  // Recompute the renderer's mapping: pad 0.9, pxPerMeter 50, bounds over polygons + doors.
  const pts = doc.rooms.flatMap(r => r.editedPolygon).concat(doc.doorways.flatMap(d => [d.endpointA, d.endpointB]));
  let minX = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxY = Math.max(maxY, p.y); }
  const pad = 0.9, k = 50;
  const sx = x => ((x - minX + pad) * k).toFixed(1), sy = y => ((maxY + pad - y) * k).toFixed(1);
  let out = '<g fill="#3f7351" fill-opacity="0.6">';
  for (const h of ip.hits) out += `<circle cx="${sx(h.x)}" cy="${sy(h.y)}" r="2.2"/>`;
  const me = ip.samples.at(-1);
  if (me) out += `<circle cx="${sx(me.x)}" cy="${sy(me.y)}" r="5" fill="#263b33" stroke="#faf8f2" stroke-width="2"/>`;
  return out + '</g>';
}
