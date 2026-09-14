import { evaluate, renderSVG, timeline, esc } from './homewalk-plan.js';

const $ = id => document.getElementById(id);
let doc = null, selected = null, showTrail = true, showPath = false, media = { video: null, audio: null, photos: new Map() };

const time = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const f = (n, d = 2) => n == null ? '—' : n.toFixed(d);
const pctCell = n => n == null ? '<td class="err">—</td>' : `<td class="err ${Math.abs(n) <= 10 ? 'good' : 'bad'}">${n >= 0 ? '+' : ''}${n.toFixed(0)}%</td>`;

// ---------- loading ----------

async function readEntry(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((res, rej) => entry.file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, out);
    } while (batch.length);
  }
}

async function loadFiles(files) {
  // A post-walk folder has plan-enriched.json (pins, transcript) and proxy.mp4; prefer those.
  const plan = files.find(f => f.name === 'plan-enriched.json') ?? files.find(f => f.name === 'plan.json');
  if (!plan) { alert('No plan.json (or plan-enriched.json) in what you dropped. Drop the whole folder.'); return; }
  for (const url of [media.video, media.audio, ...media.photos.values()]) if (url) URL.revokeObjectURL(url);
  media = { video: null, audio: null, photos: new Map() };
  for (const file of files) {
    if (/\.(mov|mp4|m4v)$/i.test(file.name) && !(media.video && file.name !== 'proxy.mp4')) media.video = URL.createObjectURL(file);
    else if (/\.(m4a|aac|mp3|wav)$/i.test(file.name)) media.audio = URL.createObjectURL(file);
    else if (/^photo-.*\.(jpe?g|png|heic)$/i.test(file.name)) media.photos.set(file.name, URL.createObjectURL(file));
  }
  doc = JSON.parse(await plan.text());
  selected = doc.rooms[0]?.id ?? null;
  render();
}

$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = async e => {
  e.preventDefault(); $('drop').classList.remove('over');
  const files = [];
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const en of entries) await readEntry(en, files);
  else files.push(...e.dataTransfer.files);
  await loadFiles(files);
};
$('files').onchange = e => loadFiles([...e.target.files]);
$('folder').onchange = e => loadFiles([...e.target.files]);
$('sampleLabel').onclick = async () => {
  const r = await fetch('/fixtures/homewalk-sample.homewalk/plan.json').catch(() => null);
  if (!r?.ok) { alert('Sample not served. Run npm run dev and open /homewalk-review.html.'); return; }
  await loadFiles([new File([await r.text()], 'plan.json')]);
};

// ---------- rendering ----------

function render() {
  if (!doc) return;
  const ev = evaluate(doc);
  $('pill').textContent = `${doc.name} · ${ev.summary.rooms} rooms · ${ev.captureMode}`;
  $('planTitle').textContent = doc.name;
  $('workspace').hidden = false;
  $('summary').hidden = false;
  const s = ev.summary;
  const card = (label, value, cls = '') => `<div class="${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('summary').innerHTML =
    card('rooms', s.rooms) +
    card('rooms with tape', `${s.roomsWithTape}/${s.rooms}`) +
    card('median |error|', s.medianAbsErrPct == null ? '—' : `${s.medianAbsErrPct.toFixed(1)}%`, s.medianAbsErrPct == null ? '' : s.medianAbsErrPct <= 10 ? 'good' : 'bad') +
    card('max |error|', s.maxAbsErrPct == null ? '—' : `${s.maxAbsErrPct.toFixed(1)}%`) +
    card('door drift (median)', s.medianDoorDriftCm == null ? 'no checks' : `${s.medianDoorDriftCm.toFixed(0)} cm`, s.medianDoorDriftCm == null ? '' : s.medianDoorDriftCm < 25 ? 'good' : 'bad') +
    card('unresolved doors', s.unresolvedDoors, s.unresolvedDoors ? 'bad' : 'good') +
    card('video frames', s.videoFrames ? `${s.videoFrames}${s.videoDropped ? ` (−${s.videoDropped})` : ''}` : 'none') +
    card('checklist', `${s.checklistDone}/${s.checklistTotal}`);
  $('gridNote').textContent = ev.gridAngleDeg == null ? 'Grid not aligned (first room too short to find walls).' : `Plan rotated ${ev.gridAngleDeg.toFixed(1)}° to the first room's walls.`;
  drawPlan();
  $('rooms').innerHTML = `<tr><th>Room</th><th>Measured w × d</th><th>Tape w</th><th>Tape d</th><th>Error w</th><th>Error d</th><th>Wall snap</th><th>Samples</th></tr>` +
    ev.rooms.map(r => `<tr data-room="${esc(r.id)}" class="${r.id === selected ? 'sel' : ''}"><td><b>${esc(r.name)}</b> <span class="muted">${esc(r.type)}</span></td><td class="err">${f(r.width)} × ${f(r.depth)} m</td><td><input data-tape="w" data-room="${esc(r.id)}" value="${r.tape ? f(r.tape.width) : ''}" placeholder="m"></td><td><input data-tape="d" data-room="${esc(r.id)}" value="${r.tape ? f(r.tape.depth) : ''}" placeholder="m"></td>${pctCell(r.errW)}${pctCell(r.errD)}<td>${r.snap == null ? '—' : `${(r.snap * 100).toFixed(0)} cm`}</td><td class="muted">${r.trailPoints}</td></tr>`).join('');
  $('rooms').querySelectorAll('tr[data-room]').forEach(tr => tr.onclick = e => { if (e.target.tagName === 'INPUT') return; selected = tr.dataset.room; render(); });
  $('rooms').querySelectorAll('input[data-tape]').forEach(inp => inp.onchange = () => {
    const room = doc.rooms.find(r => r.id === inp.dataset.room);
    const row = inp.closest('tr');
    const w = Number(row.querySelector('[data-tape="w"]').value), d = Number(row.querySelector('[data-tape="d"]').value);
    room.tapeSize = w > 0 && d > 0 ? { x: w, y: d } : null;
    render();
  });
  $('doors').innerHTML = [
    ...ev.doors.map(d => `<div>${d.connected ? '🚪' : '⚠️'} ${esc(d.rooms.join(' ↔ '))}${d.connected ? '' : ' <span class="warn">— only one room attached</span>'}</div>`),
    ...ev.mismatches.map(m => `<div class="warn">⚠️ ${esc(m.rooms.join(' ↔ '))}: ${esc(m.summary)}</div>`),
    ...ev.alignmentChecks.map(c => `<div>📍 ${esc(c.rooms.join(' ↔ '))}: <b class="err ${c.distance < 0.25 ? 'good' : 'bad'}">${(c.distance * 100).toFixed(0)} cm</b> off when you returned <span class="muted">(${esc(c.tracking)})</span></div>`),
  ].join('') || '<div>No doors yet.</div>';
  $('issues').textContent = ev.summary.unresolvedDoors ? `${ev.summary.unresolvedDoors} door(s) attach to only one room — the next room was never closed.` : '';

  const rows = timeline(doc);
  $('timeline').innerHTML = rows.map(r => {
    const can = (media.video && r.videoOffset != null) || (media.audio && r.audioOffset != null);
    return `<div class="tl-row"><button data-video="${r.videoOffset ?? ''}" data-audio="${r.audioOffset ?? ''}" ${can ? '' : 'disabled'}>${time(r.sinceStart)}</button><span class="k">${esc(r.type)}</span><span>${esc(r.rooms.join(', '))}${r.rooms.length && r.label ? ' · ' : ''}${esc(r.label)}</span></div>`;
  }).join('') || '<div class="muted">No events.</div>';
  $('timeline').querySelectorAll('button[data-video]').forEach(b => b.onclick = () => seek(b.dataset.video === '' ? null : Number(b.dataset.video), b.dataset.audio === '' ? null : Number(b.dataset.audio)));

  $('video').hidden = !media.video;
  if (media.video && $('video').src !== media.video) $('video').src = media.video;
  $('audio').hidden = !media.audio;
  if (media.audio && $('audio').src !== media.audio) $('audio').src = media.audio;
}

function seek(videoOffset, audioOffset) {
  if (media.video && videoOffset != null) { $('video').currentTime = videoOffset; $('video').play().catch(() => {}); }
  else if (media.audio && audioOffset != null) { $('audio').currentTime = Math.max(0, audioOffset); $('audio').play().catch(() => {}); }
}

function drawPlan() {
  $('plan').innerHTML = renderSVG(doc, { selected, showTrail, showPath });
  $('plan').querySelectorAll('[data-room]').forEach(g => g.onclick = () => { selected = g.dataset.room; render(); });
}

$('trail').onclick = () => { showTrail = !showTrail; $('trail').classList.toggle('active', showTrail); drawPlan(); };
$('path').onclick = () => { showPath = !showPath; $('path').classList.toggle('active', showPath); drawPlan(); };

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('dlSvg').onclick = () => download(renderSVG(doc, { showTrail, showPath }), `${doc.name.replace(/[^\w.-]+/g, '-')}.svg`, 'image/svg+xml');
$('dlJson').onclick = () => download(JSON.stringify(doc, null, 2), 'plan.json', 'application/json');

// /homewalk-review.html?sample=1 opens the fixture straight away.
if (new URLSearchParams(location.search).has('sample')) $('sampleLabel').click();

$('adjust').onclick = async () => {
  if (!doc) return;
  const response = await fetch('/api/homewalk/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: doc }) });
  const result = await response.json();
  if (!response.ok) { alert(result.error); return; }
  location.href = `/homewalk-adjust.html?project=${encodeURIComponent(result.id)}`;
};
