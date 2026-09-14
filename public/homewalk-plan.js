// HomeWalk capture bundle: metrics and SVG. Pure module, no DOM — shared by
// the browser review page (homewalk-review.js) and the CLI (eval-capture.mjs).
//
// Input is the `plan.json` written by the iOS app (CaptureDocument). All
// geometry is metres in the plan frame (aligned to the first room's walls).

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function bounds(points) {
  if (!points?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY };
}

const pct = (measured, tape) => tape > 0 ? (measured - tape) / tape * 100 : null;
const median = xs => { const a = [...xs].sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

export function roomName(doc, id) { return doc.rooms.find(r => r.id === id)?.name ?? 'unknown'; }

/** Everything the physical-test protocol asks for, computed once. */
export function evaluate(doc) {
  const rooms = doc.rooms.map(r => {
    const b = bounds(r.editedPolygon);
    const raw = bounds(r.capturedPoints?.map(p => p.rawPlan) ?? []);
    const tape = r.tapeSize ? { width: r.tapeSize.x, depth: r.tapeSize.y } : null;
    const errW = tape ? pct(b.width, tape.width) : null;
    const errD = tape ? pct(b.depth, tape.depth) : null;
    return {
      id: r.id, name: r.name, type: r.type,
      width: b.width, depth: b.depth, area: b.width * b.depth,
      rawWidth: raw?.width ?? null, rawDepth: raw?.depth ?? null,
      tape, errW, errD,
      absErr: tape ? Math.max(Math.abs(errW), Math.abs(errD)) : null,
      snap: r.wallSnapShift ?? null,
      doors: doc.doorways.filter(d => d.connectedRoomIDs.includes(r.id)).length,
      trailPoints: r.walkTrail?.length ?? 0,
      pathPoints: r.walkPath?.length ?? 0,
      walkSeconds: r.walkStartedAt && r.walkEndedAt ? r.walkEndedAt - r.walkStartedAt : null,
      revision: r.revision,
      notes: doc.observations.filter(o => o.roomID === r.id).map(o => o.text),
    };
  });
  const doors = doc.doorways.map(d => {
    const mid = { x: (d.endpointA.x + d.endpointB.x) / 2, y: (d.endpointA.y + d.endpointB.y) / 2 };
    return { id: d.id, rooms: d.connectedRoomIDs.map(id => roomName(doc, id)), mid, width: d.width, connected: d.connectedRoomIDs.length >= 2 };
  });
  const alignmentChecks = (doc.alignmentChecks ?? []).map(c => ({
    id: c.id, timestamp: c.timestamp, distance: c.distanceMeters,
    rooms: doc.doorways.find(d => d.id === c.doorwayID)?.connectedRoomIDs.map(id => roomName(doc, id)) ?? [],
    tracking: c.trackingState,
  }));
  const withTape = rooms.filter(r => r.tape);
  const errs = withTape.flatMap(r => [Math.abs(r.errW), Math.abs(r.errD)]);
  const media = doc.media ?? null;
  const events = doc.events ?? [];
  const t0 = events[0]?.timestamp ?? null;
  const t1 = events.at(-1)?.timestamp ?? null;
  return {
    name: doc.name,
    schemaVersion: doc.schemaVersion,
    appVersion: doc.appVersion,
    captureMode: doc.deviceCapabilities?.captureMode,
    gridAngleDeg: doc.floor?.gridAngle != null ? doc.floor.gridAngle * 180 / Math.PI : null,
    rooms, doors, alignmentChecks,
    mismatches: doc.mismatches.map(m => ({ summary: m.summary, rooms: [roomName(doc, m.roomA), roomName(doc, m.roomB)], distance: m.distanceMeters, angle: m.angleDegrees })),
    media,
    summary: {
      rooms: rooms.length,
      doors: doors.length,
      unresolvedDoors: doors.filter(d => !d.connected).length,
      roomsWithTape: withTape.length,
      medianAbsErrPct: errs.length ? median(errs) : null,
      maxAbsErrPct: errs.length ? Math.max(...errs) : null,
      roomsWithin10Pct: withTape.filter(r => r.absErr <= 10).length,
      medianDoorDriftCm: alignmentChecks.length ? median(alignmentChecks.map(c => c.distance)) * 100 : null,
      maxDoorDriftCm: alignmentChecks.length ? Math.max(...alignmentChecks.map(c => c.distance)) * 100 : null,
      durationSeconds: t0 != null && t1 != null ? t1 - t0 : null,
      videoFrames: media?.videoFrames ?? 0,
      videoDropped: media?.videoDroppedFrames ?? 0,
      checklistDone: (doc.inProgress?.checklist ?? []).filter(i => i.done).length,
      checklistTotal: (doc.inProgress?.checklist ?? []).length,
    },
  };
}

/** Seconds into the video for a Unix timestamp, or null. */
export function videoOffset(doc, unix) {
  const m = doc.media;
  if (!m?.videoStartedAt) return null;
  const off = unix - m.videoStartedAt;
  if (off < 0) return null;
  if (m.videoEndedAt != null && unix > m.videoEndedAt) return null;
  return off;
}

/** Timeline rows: room events, notes, door checks, with media offsets. */
export function timeline(doc) {
  const rows = [];
  for (const e of doc.events ?? []) {
    if (!['walkStarted', 'roomFinished', 'throughDoor', 'alignmentCheck', 'gridAligned', 'sharedWallSnap', 'tapeSize', 'paused'].includes(e.type)) continue;
    rows.push({ t: e.timestamp, type: e.type, label: e.detail, rooms: e.entityIDs.map(id => roomName(doc, id)).filter(n => n !== 'unknown') });
  }
  for (const o of doc.observations ?? []) {
    rows.push({ t: o.startedAt, type: 'note', label: o.text, rooms: o.roomID ? [roomName(doc, o.roomID)] : [] });
  }
  // Post-walk analysis rows carry video seconds directly.
  const v0 = doc.media?.videoStartedAt;
  if (v0 != null) {
    for (const t of doc.transcript ?? []) rows.push({ t: v0 + t.start, type: 'said', label: t.text, rooms: [] });
    for (const f of doc.features ?? []) if (typeof f.t === 'number') rows.push({ t: v0 + f.t, type: 'feature', label: f.label + (f.details ? ` — ${f.details}` : ''), rooms: f.roomId ? [roomName(doc, f.roomId)] : [] });
    for (const o of doc.openings ?? []) if (typeof o.t === 'number') rows.push({ t: v0 + o.t, type: o.kind ?? 'opening', label: o.description + (o.leadsTo ? ` → ${o.leadsTo}` : ''), rooms: o.roomId ? [roomName(doc, o.roomId)] : [] });
  }
  rows.sort((a, b) => a.t - b.t);
  const t0 = rows[0]?.t ?? 0;
  const audioStart = doc.media?.audioStartedAt ?? null;
  return rows.map(r => ({
    ...r,
    sinceStart: r.t - t0,
    videoOffset: videoOffset(doc, r.t),
    audioOffset: audioStart != null && r.t >= audioStart && (doc.media?.audioEndedAt == null || r.t <= doc.media.audioEndedAt) ? r.t - audioStart : null,
  }));
}

const PALETTE = { kitchen: '#f0dfbc', hallway: '#e9e5db', bedroom: '#e9dff2', bathroom: '#d5e9ed', living: '#e5e8c9', dining: '#f2e4d3', other: '#e2e6e0' };

/**
 * Faithful polygon rendering (no rectangle forcing). Metres → px, y up.
 * Options: selected room id, showTrail, showPath, pxPerMeter, labelDims.
 */
export function renderSVG(doc, { selected = null, showTrail = true, showPath = false, pxPerMeter = 60, labelDims = true, pad = 0.9, marks = [], showFeatures = true } = {}) {
  const pts = doc.rooms.flatMap(r => r.editedPolygon).concat(doc.doorways.flatMap(d => [d.endpointA, d.endpointB])).concat(doc.footprint ?? doc.site?.footprintPlan ?? []);
  const b = bounds(pts) ?? { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  const w = (b.maxX - b.minX + pad * 2) * pxPerMeter, h = (b.maxY - b.minY + pad * 2) * pxPerMeter;
  const sx = x => ((x - b.minX + pad) * pxPerMeter).toFixed(1);
  const sy = y => ((b.maxY + pad - y) * pxPerMeter).toFixed(1);
  const pt = p => `${sx(p.x)},${sy(p.y)}`;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" role="img" aria-label="${esc(doc.name)} floor plan"><rect width="100%" height="100%" fill="#faf8f2"/>`;
  // metre grid
  out += '<g stroke="#263b33" stroke-opacity="0.07" stroke-width="1">';
  for (let x = Math.floor(b.minX - pad); x <= b.maxX + pad; x++) out += `<line x1="${sx(x)}" y1="0" x2="${sx(x)}" y2="${h}"/>`;
  for (let y = Math.floor(b.minY - pad); y <= b.maxY + pad; y++) out += `<line x1="0" y1="${sy(y)}" x2="${w}" y2="${sy(y)}"/>`;
  out += '</g><g font-family="Inter,Arial,sans-serif">';
  const footprint = doc.footprint ?? doc.site?.footprintPlan ?? null;
  if (footprint?.length >= 3) out += `<polygon points="${footprint.map(pt).join(' ')}" fill="#0f766e" fill-opacity="0.07" stroke="#0f766e" stroke-width="2.5"/>`;
  for (const r of doc.rooms) {
    const sel = r.id === selected;
    const fill = PALETTE[r.type] ?? PALETTE.other;
    out += `<g data-room="${esc(r.id)}" style="cursor:pointer"><polygon points="${r.editedPolygon.map(pt).join(' ')}" fill="${fill}" stroke="${sel ? '#e46b3b' : '#56685f'}" stroke-width="${sel ? 4 : 1.7}"/>`;
    if (showTrail && r.walkTrail?.length > 1) out += `<polyline points="${r.walkTrail.map(pt).join(' ')}" fill="none" stroke="#b42323" stroke-width="1.4" stroke-dasharray="5 4" opacity="${sel ? 0.9 : 0.35}"/>`;
    if (showPath && r.walkPath?.length > 1) out += `<polyline points="${r.walkPath.map(pt).join(' ')}" fill="none" stroke="#2b5d8a" stroke-width="1.2" opacity="${sel ? 0.9 : 0.3}"/>`;
    const rb = bounds(r.editedPolygon);
    const cx = (rb.minX + rb.maxX) / 2, cy = (rb.minY + rb.maxY) / 2;
    out += `<text x="${sx(cx)}" y="${sy(cy)}" text-anchor="middle" font-size="12" font-weight="600" fill="#293c35">${esc(r.name)}</text>`;
    if (labelDims) {
      out += `<text x="${sx(cx)}" y="${(+sy(cy) + 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5a6a60">${rb.width.toFixed(2)} × ${rb.depth.toFixed(2)} m</text>`;
      if (r.tapeSize) out += `<text x="${sx(cx)}" y="${(+sy(cy) + 26).toFixed(1)}" text-anchor="middle" font-size="9" fill="#98623e">tape ${r.tapeSize.x.toFixed(2)} × ${r.tapeSize.y.toFixed(2)}</text>`;
      out += `<text x="${sx(cx)}" y="${(+sy(rb.maxY) - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#7a8a80">${rb.width.toFixed(2)}</text>`;
      out += `<text x="${(+sx(rb.minX) - 4).toFixed(1)}" y="${sy(cy)}" text-anchor="end" font-size="9" fill="#7a8a80" transform="rotate(-90 ${(+sx(rb.minX) - 4).toFixed(1)} ${sy(cy)})">${rb.depth.toFixed(2)}</text>`;
    }
    out += '</g>';
  }
  for (const d of doc.doorways) {
    out += `<line x1="${sx(d.endpointA.x)}" y1="${sy(d.endpointA.y)}" x2="${sx(d.endpointB.x)}" y2="${sy(d.endpointB.y)}" stroke="#faf8f2" stroke-width="8"/>`;
    out += `<line x1="${sx(d.endpointA.x)}" y1="${sy(d.endpointA.y)}" x2="${sx(d.endpointB.x)}" y2="${sy(d.endpointB.y)}" stroke="${d.connectedRoomIDs.length >= 2 ? '#c49a3c' : '#c78659'}" stroke-width="3" ${d.connectedRoomIDs.length >= 2 ? '' : 'stroke-dasharray="4 3"'}/>`;
  }
  for (const c of doc.alignmentChecks ?? []) {
    out += `<line x1="${sx(c.doorwayMidpoint.x)}" y1="${sy(c.doorwayMidpoint.y)}" x2="${sx(c.cameraPlan.x)}" y2="${sy(c.cameraPlan.y)}" stroke="#b42323" stroke-width="1.5"/>`;
    out += `<circle cx="${sx(c.cameraPlan.x)}" cy="${sy(c.cameraPlan.y)}" r="4" fill="#b42323"/>`;
    out += `<text x="${(+sx(c.cameraPlan.x) + 6).toFixed(1)}" y="${(+sy(c.cameraPlan.y) - 6).toFixed(1)}" font-size="9" fill="#b42323">${(c.distanceMeters * 100).toFixed(0)} cm</text>`;
  }
  // Zone dividers proposed by the model (dashed, never geometry): each zone's
  // boundary is where the phone was when the tape moved from one zone to the next.
  if (showFeatures) for (const z of doc.zoneDividers ?? []) {
    out += `<line x1="${sx(z.a.x)}" y1="${sy(z.a.y)}" x2="${sx(z.b.x)}" y2="${sy(z.b.y)}" stroke="#7a8a80" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    if (z.label) out += `<text x="${sx(z.labelAt.x)}" y="${sy(z.labelAt.y)}" text-anchor="middle" font-size="10" font-style="italic" fill="#5a6a60">${esc(z.label)}</text>`;
  }
  // Openings the model saw (windows as blue ticks, other openings as hollow squares).
  if (showFeatures) for (const o of doc.openings ?? []) {
    if (!o.position) continue;
    const c = { x: +sx(o.position.x), y: +sy(o.position.y) };
    if (o.kind === 'window') out += `<line x1="${(c.x - 7).toFixed(1)}" y1="${c.y.toFixed(1)}" x2="${(c.x + 7).toFixed(1)}" y2="${c.y.toFixed(1)}" stroke="#2b5d8a" stroke-width="4"/>`;
    else out += `<rect x="${(c.x - 5).toFixed(1)}" y="${(c.y - 5).toFixed(1)}" width="10" height="10" fill="none" stroke="#7c3aed" stroke-width="2"/>`;
    out += `<text x="${(c.x + 9).toFixed(1)}" y="${(c.y + 3).toFixed(1)}" font-size="8" fill="#2b5d8a">${esc(o.kind)}${o.t != null ? ` ${fmtTime(o.t)}` : ''}</text>`;
  }
  // Feature pins the model placed (position from the phone's pose at that moment).
  if (showFeatures) for (const [i, f] of (doc.features ?? []).entries()) {
    if (!f.position) continue;
    const c = { x: +sx(f.position.x), y: +sy(f.position.y) };
    out += `<g><circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="7" fill="#b45309" stroke="#faf8f2" stroke-width="1.5"/><text x="${c.x.toFixed(1)}" y="${(c.y + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#faf8f2">${i + 1}</text>`;
    out += `<text x="${(c.x + 10).toFixed(1)}" y="${(c.y - 4).toFixed(1)}" font-size="8.5" font-weight="600" fill="#5a3a06">${esc(f.label)}</text>`;
    if (f.t != null) out += `<text x="${(c.x + 10).toFixed(1)}" y="${(c.y + 6).toFixed(1)}" font-size="7.5" fill="#8a6a2a">${fmtTime(f.t)}</text>`;
    out += '</g>';
  }
  // Time marks along the path (for the model, and for humans reading the plan against the tape).
  for (const m of marks) {
    const c = { x: +sx(m.x), y: +sy(m.y) };
    out += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="#263b33"/><text x="${(c.x + 5).toFixed(1)}" y="${(c.y - 4).toFixed(1)}" font-size="8" font-weight="600" fill="#263b33">${esc(m.label)}</text>`;
  }
  // scale bar: 1 m
  out += `<g><line x1="${(w - pxPerMeter - 16).toFixed(0)}" y1="${(h - 16).toFixed(0)}" x2="${(w - 16).toFixed(0)}" y2="${(h - 16).toFixed(0)}" stroke="#293c35" stroke-width="2"/><text x="${(w - pxPerMeter / 2 - 16).toFixed(0)}" y="${(h - 22).toFixed(0)}" text-anchor="middle" font-size="9" fill="#293c35">1 m</text></g>`;
  return out + '</g></svg>';
}

export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Plain-text report for the terminal. */
export function report(doc) {
  const ev = evaluate(doc);
  const f = (n, d = 2) => n == null ? '—' : n.toFixed(d);
  const p = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
  const lines = [];
  lines.push(`${ev.name}  (schema ${ev.schemaVersion}, app ${ev.appVersion}, ${ev.captureMode})`);
  lines.push(`grid angle: ${ev.gridAngleDeg == null ? 'not aligned' : f(ev.gridAngleDeg, 1) + '°'}   duration: ${ev.summary.durationSeconds == null ? '—' : Math.round(ev.summary.durationSeconds) + ' s'}   video: ${ev.summary.videoFrames} frames${ev.summary.videoDropped ? ` (${ev.summary.videoDropped} dropped)` : ''}`);
  lines.push('');
  const head = ['room', 'type', 'measured w×d', 'tape w×d', 'err w', 'err d', 'snap', 'doors', 'samples'];
  const rows = ev.rooms.map(r => [
    r.name, r.type, `${f(r.width)} × ${f(r.depth)}`,
    r.tape ? `${f(r.tape.width)} × ${f(r.tape.depth)}` : '—',
    p(r.errW), p(r.errD), r.snap == null ? '—' : `${(r.snap * 100).toFixed(0)} cm`, String(r.doors), String(r.trailPoints),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = r => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  lines.push(fmt(head));
  lines.push(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  lines.push('');
  for (const d of ev.doors) lines.push(`door  ${d.rooms.join(' ↔ ')}${d.connected ? '' : '  (unresolved: only one room)'}  width ${f(d.width)} m`);
  for (const m of ev.mismatches) lines.push(`MISMATCH  ${m.rooms.join(' ↔ ')}: ${m.summary}`);
  for (const c of ev.alignmentChecks) lines.push(`door check  ${c.rooms.join(' ↔ ')}: ${(c.distance * 100).toFixed(0)} cm off  (${c.tracking})`);
  lines.push('');
  const s = ev.summary;
  lines.push(`tape rooms: ${s.roomsWithTape}/${s.rooms}   median |err|: ${s.medianAbsErrPct == null ? '—' : f(s.medianAbsErrPct, 1) + '%'}   max |err|: ${s.maxAbsErrPct == null ? '—' : f(s.maxAbsErrPct, 1) + '%'}   within 10%: ${s.roomsWithin10Pct}/${s.roomsWithTape}`);
  lines.push(`door drift: ${s.medianDoorDriftCm == null ? 'no checks' : `median ${f(s.medianDoorDriftCm, 0)} cm, max ${f(s.maxDoorDriftCm, 0)} cm`}   unresolved doors: ${s.unresolvedDoors}   checklist: ${s.checklistDone}/${s.checklistTotal}`);
  lines.push('targets (proposed, not guaranteed): median wall error ≤ 10%, return-door discrepancy < 25 cm.');
  return lines.join('\n');
}
