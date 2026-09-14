#!/usr/bin/env node
import { audioInputTimingArguments } from './homewalk-media.mjs';
// Post-walk pipeline: capture bundle (plan.json + walk-video.mov + walk-audio.m4a)
// → re-derived geometry → media proxy → Gemini over the tape + the measured plan
// → enriched plan (feature pins, openings, transcript, guidebook/inventory) + SVG/PNG/report.
//
//   node postwalk.mjs <bundle-dir> [--out <dir>] [--model gemini-3.8-flash] [--pad 0.5]
//                    [--grid <deg>] [--fps 2] [--no-model] [--force]
//
// The model never edits geometry. It reads the tape, names what it sees with
// timestamps, and *proposes* corrections; positions come from where the phone
// was at that moment. Requires GEMINI_API_KEY, ffmpeg/ffprobe, rsvg-convert (optional, for PNG).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';
import { rederive, bounds, closestEdge } from './public/homewalk-geometry.js';
import { renderSVG, evaluate, fmtTime, esc } from './public/homewalk-plan.js';

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const has = name => args.includes(`--${name}`);
const bundle = args.find(a => !a.startsWith('--') && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith('--')));
if (!bundle) { console.error('usage: node postwalk.mjs <bundle-dir> [--out dir] [--model id] [--pad m] [--grid deg] [--fps n] [--no-model] [--force]'); process.exit(2); }
const model = flag('model', process.env.POSTWALK_MODEL || 'gemini-3.8-flash');
const fps = Number(flag('fps', 2));
const planPath = fs.statSync(bundle).isDirectory() ? path.join(bundle, 'plan.json') : bundle;
const dir = path.dirname(planPath);
const doc = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const out = flag('out', path.join('test-output/postwalk', doc.sessionID));
fs.mkdirSync(out, { recursive: true });
const log = (...m) => console.error(...m);

// ---------- 1. geometry ----------
const overrides = {};
if (flag('pad')) overrides.pad = Number(flag('pad'));
if (flag('grid')) overrides.gridAngleOverride = Number(flag('grid')) * Math.PI / 180;
const plan = rederive(doc, overrides, { align: !has('no-align') });
fs.writeFileSync(path.join(out, 'plan-rederived.json'), JSON.stringify(plan, null, 2));
log(`geometry: ${plan.rooms.length} rooms, grid ${plan.rederived.gridAngleApplied == null ? 'unchanged' : (plan.rederived.gridAngleApplied * 180 / Math.PI).toFixed(1) + '°'}, pad ${plan.settings.pad} m`);

// ---------- 2. media ----------
const media = plan.media ?? {};
const videoSrc = media.videoPath ? path.join(dir, media.videoPath) : null;
const audioSrc = media.audioPath ? path.join(dir, media.audioPath) : null;
const hasVideo = videoSrc && fs.existsSync(videoSrc);
const hasAudio = audioSrc && fs.existsSync(audioSrc);
const proxy = path.join(out, 'proxy.mp4');
let duration = null;
if (hasVideo) {
  if (!fs.existsSync(proxy) || has('force')) {
    const ff = ['-y', '-v', 'error', '-i', videoSrc];
    if (hasAudio) {
      // Place both inputs on the video clock, including delayed microphone start.
      ff.push(...audioInputTimingArguments(media), '-i', audioSrc, '-map', '0:v', '-map', '1:a');
    }
    ff.push('-vf', 'scale=-2:960', '-r', '10', '-c:v', 'libx264', '-crf', '26', '-preset', 'fast');
    if (hasAudio) ff.push('-c:a', 'aac', '-b:a', '64k', '-shortest');
    ff.push('-movflags', '+faststart', proxy);
    execFileSync('ffmpeg', ff, { stdio: 'inherit' });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', proxy, '-vf', 'fps=1/3,scale=220:-2,tile=6x4:padding=2:margin=2', '-frames:v', '1', path.join(out, 'contact.jpg')]);
  }
  duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', proxy]).toString().trim());
  log(`media: proxy ${(fs.statSync(proxy).size / 1e6).toFixed(1)} MB, ${duration.toFixed(1)} s${hasAudio ? ' with audio' : ' (no audio)'}`);
} else {
  log('media: no video in bundle');
}

// ---------- 3. timeline: where the phone was at each video second ----------
const t0 = media.videoStartedAt ?? plan.events.find(e => e.type === 'walkStarted')?.timestamp ?? null;
const trail = [];   // {t (video s), x, y, yaw?, roomId}
for (const room of plan.rooms) {
  if (room.walkPoses?.length && t0 != null) {
    for (const p of room.walkPoses) trail.push({ t: p.t - t0, x: p.camera.x, y: p.camera.y, yaw: p.yaw ?? null, roomId: room.id });
  } else if (room.walkPath?.length && room.walkStartedAt != null && room.walkEndedAt != null && t0 != null) {
    // Older captures: no per-sample time; spread the path evenly over the room's walk window.
    const n = room.walkPath.length, span = room.walkEndedAt - room.walkStartedAt;
    room.walkPath.forEach((p, i) => trail.push({ t: room.walkStartedAt - t0 + (n > 1 ? span * i / (n - 1) : 0), x: p.x, y: p.y, yaw: null, roomId: room.id }));
  }
}
trail.sort((a, b) => a.t - b.t);
const poseAt = t => {
  if (!trail.length) return null;
  let best = trail[0];
  for (const p of trail) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
};
const headingAt = t => {
  const p = poseAt(t);
  if (!p) return null;
  if (p.yaw != null) return p.yaw;
  const i = trail.indexOf(p), a = trail[Math.max(0, i - 2)], b = trail[Math.min(trail.length - 1, i + 2)];
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.hypot(dx, dy) > 0.1 ? Math.atan2(dy, dx) : null;
};
const roomEvents = plan.events.filter(e => ['walkStarted', 'roomFinished', 'throughDoor', 'alignmentCheck'].includes(e.type) && t0 != null)
  .map(e => ({ t: +(e.timestamp - t0).toFixed(1), type: e.type, rooms: e.entityIDs.map(id => plan.rooms.find(r => r.id === id)?.name).filter(Boolean), detail: e.detail }));

// Plan image for the model: measured rooms + path with time stamps every 5 s.
const marks = [];
for (let s = 0; duration != null && s <= duration; s += 5) { const p = poseAt(s); if (p && Math.abs(p.t - s) < 2) marks.push({ x: p.x, y: p.y, label: fmtTime(s) }); }
const planForImage = { ...plan, features: [], openings: [] };
const planSvg = renderSVG(planForImage, { showTrail: false, showPath: true, pxPerMeter: 70, marks });
fs.writeFileSync(path.join(out, 'plan-for-model.svg'), planSvg);
let planPng = null;
try { execFileSync('rsvg-convert', ['-w', '1000', path.join(out, 'plan-for-model.svg'), '-o', path.join(out, 'plan-for-model.png')]); planPng = path.join(out, 'plan-for-model.png'); } catch { log('rsvg-convert not available: plan image skipped'); }

const context = {
  house: plan.name,
  videoDurationSeconds: duration,
  coordinateSystem: 'metres in the floor plan; x to the right, y up on the plan image; the phone path is drawn with video time stamps',
  rooms: plan.rooms.map(r => {
    const b = bounds(r.editedPolygon);
    const window = trail.filter(p => p.roomId === r.id);
    return {
      id: r.id, nameGivenByWalker: r.name, typeGivenByWalker: r.type,
      measuredWidthMeters: +(b.maxX - b.minX).toFixed(2), measuredDepthMeters: +(b.maxY - b.minY).toFixed(2),
      box: { minX: +b.minX.toFixed(2), minY: +b.minY.toFixed(2), maxX: +b.maxX.toFixed(2), maxY: +b.maxY.toFixed(2) },
      walkedVideoWindowSeconds: window.length ? [+window[0].t.toFixed(1), +window.at(-1).t.toFixed(1)] : null,
      note: 'The box is where the phone went plus a wall pad; it is a measured envelope, not a survey. Open-plan zones (e.g. kitchen + dining) can share one box.',
    };
  }),
  doorways: plan.doorways.map(d => ({ between: d.connectedRoomIDs.map(id => plan.rooms.find(r => r.id === id)?.name), position: { x: +((d.endpointA.x + d.endpointB.x) / 2).toFixed(2), y: +((d.endpointA.y + d.endpointB.y) / 2).toFixed(2) } })),
  events: roomEvents,
  phonePathEverySecond: trail.filter((p, i) => i === 0 || p.t - trail[i - 1].t >= 0.9).map(p => ({ t: +p.t.toFixed(1), x: +p.x.toFixed(2), y: +p.y.toFixed(2), ...(p.yaw != null ? { facingDeg: +(p.yaw * 180 / Math.PI).toFixed(0) } : {}) })),
  checklistTickedByWalker: (plan.inProgress?.checklist ?? []).filter(i => i.done).map(i => i.title),
  promptsSkippedByWalker: (plan.inProgress?.checklist ?? []).filter(i => i.skippedAt != null).map(i => i.title),
  notesTypedByWalker: (plan.observations ?? []).map(o => ({ room: plan.rooms.find(r => r.id === o.roomID)?.name, text: o.text })),
  // On-device speech results: a hint for the model, not ground truth (keyword matching, no visuals).
  itemsHeardOnDevice: (plan.capturedItems ?? []).map(c => ({ label: c.label, room: plan.rooms.find(r => r.id === c.roomID)?.name ?? null, videoSeconds: t0 != null ? +(c.timestamp - t0).toFixed(1) : null, said: c.transcript })),
  transcriptOnDevice: (plan.transcript ?? []).map(s => ({ start: t0 != null ? +(s.startedAt - t0).toFixed(1) : null, end: t0 != null ? +(s.endedAt - t0).toFixed(1) : null, room: plan.rooms.find(r => r.id === s.roomID)?.name ?? null, text: s.text })),
  geo: plan.geo ? { headingAligned: plan.geo.headingAligned, gpsAccuracyMeters: plan.geo.horizontalAccuracy } : null,
  footprintPlacedOnPlan: plan.site?.footprintPlan ? { vertices: plan.site.footprintPlan.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })), note: plan.site.placementNote } : null,
};
fs.writeFileSync(path.join(out, 'context.json'), JSON.stringify(context, null, 2));

// ---------- 4. the model ----------
const schemaText = `Return ONLY JSON with this shape:
{
 "transcript": [{"start": seconds, "end": seconds, "text": "what was said, verbatim"}],
 "rooms": [{"id": "<id from context>", "name": "best name", "type": "kitchen|dining|living|family|playroom|hallway|entry|bedroom|bathroom|laundry|garage|closet|office|stairs|outdoor|other",
            "confidence": 0-1, "whatItContains": "one line", "boundaryAssessment": "does the measured box match what the tape shows? which walls, openings, half-walls or counters bound it? is it several open-plan zones?",
            "zones": [{"name": "e.g. dining", "videoWindow": [start, end], "wherePhonePathSeconds": [t, t]}]}],
 "features": [{"label": "fridge / range / dishwasher / sink / island / electrical panel / thermostat / water heater / TV / sofa / table / baby gate / ...",
               "category": "appliance|fixture|control|furniture|storage|safety|other", "roomId": "<id>", "t": seconds when it is clearest on screen,
               "seenDirection": "ahead|left|right|behind|down", "approxDistanceMeters": number, "details": "brand, colour, condition, anything spoken about it", "serialOrModelText": "only if legible"}],
 "openings": [{"kind": "door|opening|window|gate|stairs|half-wall", "roomId": "<id>", "t": seconds, "description": "what and where in frame", "leadsTo": "room name or 'outside' or 'unknown'",
               "seenDirection": "ahead|left|right|behind", "approxDistanceMeters": number, "matchesMeasuredDoorway": true|false|null}],
 "guidebook": [{"roomId": "<id>", "text": "something a guest or new owner should know, from what was said or shown"}],
 "inventory": [{"item": "", "roomId": "<id>", "brand": "", "model": "", "serial": "", "t": seconds}],
 "maintenance": [{"item": "", "roomId": "<id>", "note": "", "t": seconds}],
 "layoutAssessment": "2-4 sentences: does the measured plan (image + boxes) agree with the tape? where would an owner say 'that's not my house'?",
 "suggestedCorrections": [{"roomId": "<id>", "kind": "rename|retype|split|merge|resize|move-door|add-opening", "rationale": "", "t": seconds}],
 "uncertainties": ["..."]
}`;
const instructions = `You are helping build an annotated floor plan of a real home from a walkthrough video recorded on a phone, plus measurements from the phone's own tracking (ARKit).
Watch the video and listen to the audio carefully. You also get: the measured rooms (boxes, metres), the phone's path with video time stamps (JSON and drawn on the plan image), the doorways the walker marked, and the walker's own room names and checklist.
Rules:
- The measurements are the ground truth for size and position. Do not invent dimensions or coordinates. You may say a box looks too big/small or spans zones, as a suggestion with a reason and a timestamp.
- Place everything in time: every feature/opening needs the video second where it is clearest. Timestamps must be within 0 and ${duration ?? 'the video length'} seconds. Never guess a time you did not see.
- Describe where things are relative to the phone at that second (ahead/left/right, rough distance) so pins can be placed on the plan from the path.
- Distinguish what was said (transcript) from what is visible. Do not create rooms that were not entered; a room glimpsed through an opening goes in "openings.leadsTo".
- Room names given by the walker win unless clearly wrong; explain any change.
- "itemsHeardOnDevice" and "transcriptOnDevice" come from on-device keyword matching of speech: use them as hints and confirm against what is visible; correct wrong ones.
- If "footprintPlacedOnPlan" is present, the real building outline is already on the plan (compass + GPS + room fit); mention if the walked rooms sit outside it.
- Be concrete and brief. Output JSON only.`;

let analysis = null, usage = null;
const analysisPath = path.join(out, 'analysis.json');
if (has('no-model')) {
  log('model: skipped (--no-model)');
} else if (fs.existsSync(analysisPath) && !has('force')) {
  analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  log('model: cached analysis.json (use --force to re-run)');
} else {
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const parts = [];
  if (hasVideo) {
    const bytes = fs.readFileSync(proxy);
    if (bytes.length < 18e6) {
      parts.push({ inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') }, videoMetadata: { fps } });
    } else {
      log('media: uploading proxy via Files API…');
      let file = await ai.files.upload({ file: proxy, config: { mimeType: 'video/mp4' } });
      while (file.state === 'PROCESSING') { await new Promise(r => setTimeout(r, 2000)); file = await ai.files.get({ name: file.name }); }
      if (file.state !== 'ACTIVE') throw new Error(`upload failed: ${file.state}`);
      parts.push({ fileData: { fileUri: file.uri, mimeType: 'video/mp4' }, videoMetadata: { fps } });
    }
  }
  if (planPng) parts.push({ inlineData: { mimeType: 'image/png', data: fs.readFileSync(planPng).toString('base64') } });
  const prompt = `${instructions}\n\nMEASURED CONTEXT (JSON):\n${JSON.stringify(context)}\n\n${planPng ? 'The image is the measured plan with the phone path and video time stamps.\n\n' : ''}${schemaText}`;
  parts.push({ text: prompt });
  fs.writeFileSync(path.join(out, 'prompt.txt'), prompt);
  log(`model: ${model}, ${fps} fps video${planPng ? ' + plan image' : ''}…`);
  const started = Date.now();
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 65536 },
  });
  const seconds = (Date.now() - started) / 1000;
  fs.writeFileSync(path.join(out, 'analysis.raw.txt'), response.text ?? '');
  try { analysis = JSON.parse(response.text); } catch (e) { console.error('model returned non-JSON; see analysis.raw.txt'); process.exit(1); }
  usage = { model, seconds, fps, usage: response.usageMetadata };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
  log(`model: ${seconds.toFixed(0)} s, tokens in ${response.usageMetadata?.promptTokenCount ?? '?'} / out ${response.usageMetadata?.candidatesTokenCount ?? '?'}`);
}

// ---------- 5. merge: pins from the pose at each timestamp ----------
const enriched = structuredClone(plan);
enriched.features = [];
enriched.openings = [];
enriched.analysis = analysis ? { model, layoutAssessment: analysis.layoutAssessment, suggestedCorrections: analysis.suggestedCorrections ?? [], uncertainties: analysis.uncertainties ?? [], rooms: analysis.rooms ?? [] } : null;
const validT = t => typeof t === 'number' && t >= 0 && (duration == null || t <= duration + 0.5);
const dirOffset = { ahead: 0, left: Math.PI / 2, right: -Math.PI / 2, behind: Math.PI, down: 0 };
function place(item) {
  if (!validT(item.t)) return { position: null, note: 'invalid time' };
  const p = poseAt(item.t);
  if (!p) return { position: null };
  const heading = headingAt(item.t);
  const dist = Math.min(3, Math.max(0.3, Number(item.approxDistanceMeters) || 1.2));
  let pos = { x: p.x, y: p.y };
  if (heading != null && item.seenDirection && item.seenDirection !== 'down') {
    const a = heading + (dirOffset[item.seenDirection] ?? 0);
    pos = { x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist };
  }
  // Keep pins inside the room the phone was in at that moment.
  const room = enriched.rooms.find(r => r.id === (item.roomId || p.roomId)) ?? enriched.rooms.find(r => r.id === p.roomId);
  if (room) {
    const b = bounds(room.editedPolygon);
    pos = { x: Math.min(b.maxX - 0.15, Math.max(b.minX + 0.15, pos.x)), y: Math.min(b.maxY - 0.15, Math.max(b.minY + 0.15, pos.y)) };
  }
  return { position: pos, phoneAt: { x: p.x, y: p.y }, roomId: room?.id ?? null };
}
if (analysis) {
  for (const f of analysis.features ?? []) enriched.features.push({ ...f, ...place(f) });
  for (const o of analysis.openings ?? []) {
    const placed = place(o);
    // Openings sit on a wall: snap to the nearest edge of the room.
    if (placed.position && placed.roomId) {
      const room = enriched.rooms.find(r => r.id === placed.roomId);
      const e = closestEdge(room.editedPolygon, placed.position);
      if (e && e.distance < 2.5) placed.position = e.projected;
    }
    enriched.openings.push({ ...o, ...placed });
  }
  enriched.transcript = (analysis.transcript ?? []).filter(x => validT(x.start));
  enriched.guidebook = analysis.guidebook ?? [];
  enriched.inventory = analysis.inventory ?? [];
  enriched.maintenance = analysis.maintenance ?? [];
  // Model-proposed names/types are recorded, never applied silently.
  enriched.zoneDividers = [];
  for (const r of analysis.rooms ?? []) {
    const room = enriched.rooms.find(x => x.id === r.id);
    if (!room) continue;
    room.modelAssessment = { name: r.name, type: r.type, confidence: r.confidence, whatItContains: r.whatItContains, boundaryAssessment: r.boundaryAssessment, zones: r.zones ?? [] };
    // Zones → dashed dividers across the room's short axis, at the phone's
    // position when the tape passed from one zone to the next. A proposal drawn, not a wall.
    const zones = (r.zones ?? []).filter(z => Array.isArray(z.videoWindow) && validT(z.videoWindow[0]) && validT(z.videoWindow[1])).sort((a, b) => a.videoWindow[0] - b.videoWindow[0]);
    if (zones.length < 2) continue;
    const b = bounds(room.editedPolygon);
    const longX = (b.maxX - b.minX) >= (b.maxY - b.minY);
    // Where each zone sits along the long axis: the centroid of the features
    // seen during its window (people loop around a room, so the phone's
    // position at the transition second is a poor divider); fall back to the
    // phone position at the boundary when a zone has no placed features.
    const axis = pt => (longX ? pt.x : pt.y);
    const zoneCentre = z => {
      const feats = enriched.features.filter(f => f.roomId === room.id && f.position && validT(f.t) && f.t >= z.videoWindow[0] && f.t <= z.videoWindow[1]);
      if (feats.length) return feats.reduce((acc, f) => acc + axis(f.position), 0) / feats.length;
      const p = poseAt((z.videoWindow[0] + z.videoWindow[1]) / 2);
      return p ? axis(p) : null;
    };
    const centres = zones.map(zoneCentre);
    const cuts = [];
    for (let i = 1; i < zones.length; i++) {
      let c = centres[i - 1] != null && centres[i] != null ? (centres[i - 1] + centres[i]) / 2 : null;
      if (c == null) { const p = poseAt((zones[i - 1].videoWindow[1] + zones[i].videoWindow[0]) / 2); if (!p) continue; c = axis(p); }
      c = longX ? Math.min(b.maxX - 0.3, Math.max(b.minX + 0.3, c)) : Math.min(b.maxY - 0.3, Math.max(b.minY + 0.3, c));
      cuts.push(c);
      enriched.zoneDividers.push(longX
        ? { roomId: room.id, a: { x: c, y: b.minY }, b: { x: c, y: b.maxY }, label: null, labelAt: null }
        : { roomId: room.id, a: { x: b.minX, y: c }, b: { x: b.maxX, y: c }, label: null, labelAt: null });
    }
    // Zone labels centred between cuts, in position order along the axis.
    cuts.sort((p, q) => p - q);
    const ordered = zones.map((z, i) => ({ z, c: centres[i] ?? Infinity })).sort((p, q) => p.c - q.c).map(o => o.z);
    const edges = [longX ? b.minX : b.minY, ...cuts, longX ? b.maxX : b.maxY];
    ordered.forEach((z, i) => {
      if (i >= edges.length - 1) return;
      const mid = (edges[i] + edges[i + 1]) / 2;
      enriched.zoneDividers.push({ roomId: room.id, a: longX ? { x: mid, y: b.minY } : { x: b.minX, y: mid }, b: longX ? { x: mid, y: b.minY } : { x: b.minX, y: mid }, label: z.name, labelAt: longX ? { x: mid, y: b.maxY - 0.35 } : { x: b.minX + 0.9, y: mid + 0.12 } });
    });
  }
}
fs.writeFileSync(path.join(out, 'plan-enriched.json'), JSON.stringify(enriched, null, 2));

// ---------- 6. outputs ----------
const svg = renderSVG(enriched, { showTrail: false, showPath: true, pxPerMeter: 80 });
fs.writeFileSync(path.join(out, 'plan.svg'), svg);
try { execFileSync('rsvg-convert', ['-w', '1400', path.join(out, 'plan.svg'), '-o', path.join(out, 'plan.png')]); } catch {}

const lines = [];
lines.push(`# ${plan.name}`, '');
lines.push(`Model: ${analysis ? model : 'none'} · video ${duration != null ? duration.toFixed(0) + ' s' : '—'} · grid ${plan.rederived.gridAngleApplied == null ? 'unchanged' : (plan.rederived.gridAngleApplied * 180 / Math.PI).toFixed(1) + '°'} · pad ${plan.settings.pad} m`, '');
lines.push('## Rooms (measured)', '');
for (const r of enriched.rooms) {
  const b = bounds(r.editedPolygon);
  const ma = r.modelAssessment;
  lines.push(`- **${r.name}** — ${(b.maxX - b.minX).toFixed(2)} × ${(b.maxY - b.minY).toFixed(2)} m${r.wallSnapShift != null ? ` (wall snapped ${(r.wallSnapShift * 100).toFixed(0)} cm)` : ''}`);
  if (ma) {
    lines.push(`  - model: ${ma.name} (${ma.type}, ${Math.round((ma.confidence ?? 0) * 100)}%) — ${ma.whatItContains}`);
    lines.push(`  - boundary: ${ma.boundaryAssessment}`);
    for (const z of ma.zones ?? []) lines.push(`  - zone: ${z.name} ${z.videoWindow ? `(${fmtTime(z.videoWindow[0])}–${fmtTime(z.videoWindow[1])})` : ''}`);
  }
}
if (analysis) {
  lines.push('', '## Layout assessment', '', analysis.layoutAssessment ?? '');
  if (analysis.suggestedCorrections?.length) { lines.push('', '## Suggested corrections (not applied)', ''); for (const c of analysis.suggestedCorrections) lines.push(`- ${c.kind} · ${enriched.rooms.find(r => r.id === c.roomId)?.name ?? c.roomId} · ${c.rationale}${validT(c.t) ? ` (${fmtTime(c.t)})` : ''}`); }
  lines.push('', '## Features', '');
  enriched.features.forEach((f, i) => lines.push(`${i + 1}. **${f.label}** (${f.category}) · ${enriched.rooms.find(r => r.id === f.roomId)?.name ?? '?'} · ${validT(f.t) ? fmtTime(f.t) : 'no time'}${f.details ? ` — ${f.details}` : ''}${f.serialOrModelText ? ` — text: ${f.serialOrModelText}` : ''}${f.position ? '' : ' — (not placed)'}`));
  lines.push('', '## Openings', '');
  for (const o of enriched.openings) lines.push(`- ${o.kind} · ${enriched.rooms.find(r => r.id === o.roomId)?.name ?? '?'} · ${validT(o.t) ? fmtTime(o.t) : 'no time'} — ${o.description}${o.leadsTo ? ` → ${o.leadsTo}` : ''}${o.matchesMeasuredDoorway === true ? ' (matches a marked doorway)' : ''}`);
  const section = (title, rows, fmt) => { if (rows?.length) { lines.push('', `## ${title}`, ''); for (const r of rows) lines.push(`- ${fmt(r)}`); } };
  section('Guidebook', enriched.guidebook, g => `${enriched.rooms.find(r => r.id === g.roomId)?.name ?? '?'}: ${g.text}`);
  section('Inventory', enriched.inventory, x => `${x.item}${x.brand ? ` — ${x.brand}` : ''}${x.model ? ` ${x.model}` : ''}${x.serial ? ` · serial ${x.serial}` : ''} (${enriched.rooms.find(r => r.id === x.roomId)?.name ?? '?'}${validT(x.t) ? `, ${fmtTime(x.t)}` : ''})`);
  section('Maintenance', enriched.maintenance, m => `${m.item}: ${m.note} (${enriched.rooms.find(r => r.id === m.roomId)?.name ?? '?'}${validT(m.t) ? `, ${fmtTime(m.t)}` : ''})`);
  if (analysis.uncertainties?.length) section('Uncertainties', analysis.uncertainties, u => u);
  if (enriched.transcript?.length) { lines.push('', '## Transcript', ''); for (const t of enriched.transcript) lines.push(`- ${fmtTime(t.start)} ${t.text}`); }
}
fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n');
if (enriched.transcript?.length) fs.writeFileSync(path.join(out, 'transcript.txt'), enriched.transcript.map(t => `[${fmtTime(t.start)}] ${t.text}`).join('\n') + '\n');

const ev = evaluate(enriched);
log(`done → ${out}`);
log(`  rooms ${ev.summary.rooms} · features ${enriched.features.length} (${enriched.features.filter(f => f.position).length} placed) · openings ${enriched.openings.length} · transcript ${enriched.transcript?.length ?? 0} lines`);
console.log(out);
