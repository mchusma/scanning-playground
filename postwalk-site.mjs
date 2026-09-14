#!/usr/bin/env node
// Site fit: put the walked rooms inside the real building footprint and let the
// model fill in the rooms that were not walked — as clearly-marked expectations.
//
//   node postwalk-site.mjs <postwalk-out-dir> <priors-dir> [--model gemini-3.8-flash] [--force] [--no-model]
//
// Frames:
//   walk frame  = the walk's plan rotated so its dominant wall heading is axis-aligned
//   house frame = the footprint (east/north metres) rotated so its walls are axis-aligned, origin at the footprint centroid
// The model chooses one of four grid-consistent rotations and a translation of the
// walk frame into the house frame, using cues in the video (windows to the pool
// side, patio doors, garage side, street side) and the listing's room list. Geometry
// of walked rooms is never changed; expected rooms are drawn dashed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';
import { bounds, rotate, dominantAngleOfPath } from './public/homewalk-geometry.js';
import { esc, fmtTime } from './public/homewalk-plan.js';

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['model', 'out'].includes(args[i - 1].slice(2))));
const [walkDir, priorsDir] = pos;
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = n => args.includes(`--${n}`);
if (!walkDir || !priorsDir) { console.error('usage: node postwalk-site.mjs <postwalk-out-dir> <priors-dir> [--model id] [--force] [--no-model]'); process.exit(2); }
const log = (...m) => console.error(...m);
const model = flag('model', 'gemini-3.8-flash');
const out = walkDir;

const plan = JSON.parse(fs.readFileSync(path.join(walkDir, 'plan-enriched.json'), 'utf8'));
const priors = JSON.parse(fs.readFileSync(path.join(priorsDir, 'priors.json'), 'utf8'));
if (!priors.footprint) { console.error('priors have no footprint; nothing to fit into'); process.exit(1); }

// ---------- walk frame ----------
const path2d = plan.rooms.flatMap(r => r.walkPath ?? []);
const walkTheta = plan.floor?.gridAngle != null && plan.rederived?.gridAngleApplied != null ? 0
  : (dominantAngleOfPath(path2d, { minInlierFraction: 0.3, inlierWindowDegrees: 8 }) ?? 0);
const toWalk = p => rotate(p, -walkTheta);
const walkRooms = plan.rooms.map(r => ({ id: r.id, name: r.name, type: r.type, poly: r.editedPolygon.map(toWalk), model: r.modelAssessment ?? null }));
const walkCentre = (() => { const b = bounds(walkRooms.flatMap(r => r.poly)); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; })();
const W = p => ({ x: p.x - walkCentre.x, y: p.y - walkCentre.y });   // walk frame, centred
for (const r of walkRooms) r.poly = r.poly.map(W);
const walkDoors = plan.doorways.map(d => ({ a: W(toWalk(d.endpointA)), b: W(toWalk(d.endpointB)), rooms: d.connectedRoomIDs.map(id => plan.rooms.find(r => r.id === id)?.name) }));
const walkFeatures = (plan.features ?? []).filter(f => f.position).map(f => ({ ...f, position: W(toWalk(f.position)) }));
const walkOpenings = (plan.openings ?? []).filter(o => o.position).map(o => ({ ...o, position: W(toWalk(o.position)) }));
const walkDividers = (plan.zoneDividers ?? []).map(z => ({ ...z, a: W(toWalk(z.a)), b: W(toWalk(z.b)), labelAt: z.labelAt ? W(toWalk(z.labelAt)) : null }));
log(`walk frame: rotated ${(walkTheta * 180 / Math.PI).toFixed(1)}° so walls are axis-aligned`);

// ---------- house frame ----------
const fp = priors.footprint;
const bearing = fp.dominantWallBearingDeg;                       // clockwise from north
const houseTheta = -(90 - bearing) * Math.PI / 180;              // rotate east/north by this to make walls axis-aligned
const H = p => rotate({ x: p.east, y: p.north }, houseTheta);
const housePoly = fp.polygonEastNorthM.map(H);
const northVec = rotate({ x: 0, y: 1 }, houseTheta);
// Street side: the geocoded point is street-interpolated, so its direction from the centroid points at the street.
const geo = JSON.parse(fs.readFileSync(path.join(priorsDir, 'geocode.json'), 'utf8'));
const mlon = 111320 * Math.cos(fp.centroid.lat * Math.PI / 180), mlat = 111320;
const streetVec = (() => { const v = rotate({ x: (geo.lon - fp.centroid.lon) * mlon, y: (geo.lat - fp.centroid.lat) * mlat }, houseTheta); const n = Math.hypot(v.x, v.y) || 1; return { x: v.x / n, y: v.y / n }; })();
const hb = bounds(housePoly);
log(`house frame: footprint ${(hb.maxX - hb.minX).toFixed(1)} × ${(hb.maxY - hb.minY).toFixed(1)} m, walls axis-aligned (bearing ${bearing}°)`);

// ---------- renderers ----------
function svgFrame(polys, { pxPerMeter = 28, pad = 2 } = {}) {
  const b = bounds(polys.flat());
  const w = (b.maxX - b.minX + pad * 2) * pxPerMeter, h = (b.maxY - b.minY + pad * 2) * pxPerMeter;
  const sx = x => ((x - b.minX + pad) * pxPerMeter).toFixed(1), sy = y => ((b.maxY + pad - y) * pxPerMeter).toFixed(1);
  return { w, h, sx, sy, pt: p => `${sx(p.x)},${sy(p.y)}`, b };
}
function arrow(f, origin, vec, label, color) {
  const o = { x: +f.sx(origin.x), y: +f.sy(origin.y) }, e = { x: o.x + vec.x * 40, y: o.y - vec.y * 40 };
  return `<line x1="${o.x}" y1="${o.y}" x2="${e.x.toFixed(1)}" y2="${e.y.toFixed(1)}" stroke="${color}" stroke-width="2.5"/><circle cx="${e.x.toFixed(1)}" cy="${e.y.toFixed(1)}" r="3.5" fill="${color}"/><text x="${(e.x + vec.x * 10).toFixed(1)}" y="${(e.y - vec.y * 10 + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${color}" text-anchor="middle">${label}</text>`;
}
function houseSVG({ placed = null, expected = [], title = '' } = {}) {
  const f = svgFrame([housePoly], { pxPerMeter: 28 });
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w.toFixed(0)} ${f.h.toFixed(0)}" font-family="Inter,Arial,sans-serif"><rect width="100%" height="100%" fill="#faf8f2"/>`;
  s += '<g stroke="#263b33" stroke-opacity="0.07" stroke-width="1">';
  for (let x = Math.floor(f.b.minX - 2); x <= f.b.maxX + 2; x++) s += `<line x1="${f.sx(x)}" y1="0" x2="${f.sx(x)}" y2="${f.h}"/>`;
  for (let y = Math.floor(f.b.minY - 2); y <= f.b.maxY + 2; y++) s += `<line x1="0" y1="${f.sy(y)}" x2="${f.w}" y2="${f.sy(y)}"/>`;
  s += '</g>';
  s += `<polygon points="${housePoly.map(f.pt).join(' ')}" fill="#e9e5db" stroke="#263b33" stroke-width="3"/>`;
  // edge lengths
  housePoly.forEach((a, i) => { const b = housePoly[(i + 1) % housePoly.length]; const L = Math.hypot(b.x - a.x, b.y - a.y); if (L > 2) s += `<text x="${f.sx((a.x + b.x) / 2)}" y="${f.sy((a.y + b.y) / 2)}" font-size="9" fill="#5a6a60" text-anchor="middle">${L.toFixed(1)} m</text>`; });
  for (const r of expected) {
    const bb = r.box;
    s += `<rect x="${f.sx(bb.minX)}" y="${f.sy(bb.maxY)}" width="${((bb.maxX - bb.minX) * 28).toFixed(1)}" height="${((bb.maxY - bb.minY) * 28).toFixed(1)}" fill="#d5e9ed" fill-opacity="0.5" stroke="#2b5d8a" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    s += `<text x="${f.sx((bb.minX + bb.maxX) / 2)}" y="${f.sy((bb.minY + bb.maxY) / 2)}" font-size="10" font-style="italic" fill="#2b5d8a" text-anchor="middle">${esc(r.name)}${r.confidence != null ? ` (${Math.round(r.confidence * 100)}%)` : ''}</text>`;
  }
  if (placed) {
    for (const r of placed.rooms) {
      s += `<polygon points="${r.poly.map(f.pt).join(' ')}" fill="#f0dfbc" fill-opacity="0.8" stroke="#56685f" stroke-width="2"/>`;
      const bb = bounds(r.poly);
      s += `<text x="${f.sx((bb.minX + bb.maxX) / 2)}" y="${f.sy((bb.minY + bb.maxY) / 2)}" font-size="11" font-weight="700" fill="#293c35" text-anchor="middle">${esc(r.name)}</text><text x="${f.sx((bb.minX + bb.maxX) / 2)}" y="${(+f.sy((bb.minY + bb.maxY) / 2) + 12).toFixed(1)}" font-size="9" fill="#5a6a60" text-anchor="middle">${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} m · measured</text>`;
    }
    for (const z of placed.dividers) if (z.label == null) s += `<line x1="${f.sx(z.a.x)}" y1="${f.sy(z.a.y)}" x2="${f.sx(z.b.x)}" y2="${f.sy(z.b.y)}" stroke="#7a8a80" stroke-width="1.2" stroke-dasharray="5 4"/>`; else if (z.labelAt) s += `<text x="${f.sx(z.labelAt.x)}" y="${f.sy(z.labelAt.y)}" font-size="9" font-style="italic" fill="#5a6a60" text-anchor="middle">${esc(z.label)}</text>`;
    for (const d of placed.doors) s += `<line x1="${f.sx(d.a.x)}" y1="${f.sy(d.a.y)}" x2="${f.sx(d.b.x)}" y2="${f.sy(d.b.y)}" stroke="#faf8f2" stroke-width="7"/><line x1="${f.sx(d.a.x)}" y1="${f.sy(d.a.y)}" x2="${f.sx(d.b.x)}" y2="${f.sy(d.b.y)}" stroke="#c49a3c" stroke-width="3"/>`;
    for (const o of placed.openings) { const c = { x: +f.sx(o.position.x), y: +f.sy(o.position.y) }; s += o.kind === 'window' ? `<line x1="${c.x - 6}" y1="${c.y}" x2="${c.x + 6}" y2="${c.y}" stroke="#2b5d8a" stroke-width="4"/>` : `<rect x="${c.x - 4}" y="${c.y - 4}" width="8" height="8" fill="none" stroke="#7c3aed" stroke-width="2"/>`; }
    placed.features.forEach((ft, i) => { const c = { x: +f.sx(ft.position.x), y: +f.sy(ft.position.y) }; s += `<circle cx="${c.x}" cy="${c.y}" r="6" fill="#b45309" stroke="#faf8f2" stroke-width="1.5"/><text x="${c.x}" y="${c.y + 3}" font-size="7" font-weight="700" fill="#faf8f2" text-anchor="middle">${i + 1}</text>`; });
  }
  s += arrow(f, { x: f.b.minX - 0.6, y: f.b.maxY + 0.6 }, northVec, 'N', '#263b33');
  s += arrow(f, { x: f.b.minX - 0.6, y: f.b.maxY - 1.6 }, streetVec, 'street', '#98623e');
  if (title) s += `<text x="${f.w / 2}" y="${f.h - 8}" font-size="10" fill="#657369" text-anchor="middle">${esc(title)}</text>`;
  return s + '</svg>';
}
function walkSVG() {
  const f = svgFrame(walkRooms.map(r => r.poly), { pxPerMeter: 40, pad: 1.2 });
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w.toFixed(0)} ${f.h.toFixed(0)}" font-family="Inter,Arial,sans-serif"><rect width="100%" height="100%" fill="#faf8f2"/>`;
  for (const r of walkRooms) { s += `<polygon points="${r.poly.map(f.pt).join(' ')}" fill="#f0dfbc" stroke="#56685f" stroke-width="2"/>`; const bb = bounds(r.poly); s += `<text x="${f.sx((bb.minX + bb.maxX) / 2)}" y="${f.sy((bb.minY + bb.maxY) / 2)}" font-size="11" font-weight="700" fill="#293c35" text-anchor="middle">${esc(r.name)}</text><text x="${f.sx((bb.minX + bb.maxX) / 2)}" y="${(+f.sy((bb.minY + bb.maxY) / 2) + 12).toFixed(1)}" font-size="9" fill="#5a6a60" text-anchor="middle">${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} m</text>`; }
  for (const d of walkDoors) s += `<line x1="${f.sx(d.a.x)}" y1="${f.sy(d.a.y)}" x2="${f.sx(d.b.x)}" y2="${f.sy(d.b.y)}" stroke="#c49a3c" stroke-width="4"/>`;
  for (const o of walkOpenings) { const c = { x: +f.sx(o.position.x), y: +f.sy(o.position.y) }; s += `<rect x="${c.x - 4}" y="${c.y - 4}" width="8" height="8" fill="none" stroke="#7c3aed" stroke-width="2"/><text x="${c.x + 6}" y="${c.y + 3}" font-size="8" fill="#7c3aed">${esc(o.kind)} ${fmtTime(o.t ?? 0)}${o.leadsTo ? ' → ' + esc(o.leadsTo) : ''}</text>`; }
  walkFeatures.forEach((ft, i) => { const c = { x: +f.sx(ft.position.x), y: +f.sy(ft.position.y) }; s += `<circle cx="${c.x}" cy="${c.y}" r="6" fill="#b45309" stroke="#faf8f2" stroke-width="1.5"/><text x="${c.x + 8}" y="${c.y + 3}" font-size="8" fill="#5a3a06">${i + 1} ${esc(ft.label)}</text>`; });
  s += `<text x="${f.w / 2}" y="${f.h - 6}" font-size="9" fill="#657369" text-anchor="middle">walk frame: x right, y up; origin at the walked rooms' centre; orientation relative to the house is unknown</text>`;
  return s + '</svg>';
}
const png = (svg, name) => { const p = path.join(out, name); fs.writeFileSync(p.replace(/\.png$/, '.svg'), svg); try { execFileSync('rsvg-convert', ['-w', '1100', p.replace(/\.png$/, '.svg'), '-o', p]); return p; } catch { return null; } };
const housePng = png(houseSVG({ title: 'house frame: the real footprint, walls axis-aligned; N and street arrows' }), 'site-house-frame.png');
const walkPng = png(walkSVG(), 'site-walk-frame.png');

// ---------- the model ----------
const fitPath = path.join(out, 'site-fit.json');
let fit = null;
const transformPoint = (p, rot, t) => { const r = rotate(p, rot * Math.PI / 180); return { x: r.x + t.x, y: r.y + t.y }; };
const inside = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
const containment = (rot, t) => { let n = 0, k = 0; for (const r of walkRooms) { const b = bounds(r.poly); for (let x = b.minX + 0.2; x < b.maxX; x += 0.4) for (let y = b.minY + 0.2; y < b.maxY; y += 0.4) { n++; if (inside(transformPoint({ x, y }, rot, t), housePoly)) k++; } } return n ? k / n : 0; };

if (has('no-model')) log('model: skipped');
else if (fs.existsSync(fitPath) && !has('force')) { fit = JSON.parse(fs.readFileSync(fitPath, 'utf8')); log('model: cached site-fit.json'); }
else {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const parts = [];
  const proxy = path.join(walkDir, 'proxy.mp4');
  if (fs.existsSync(proxy)) parts.push({ inlineData: { mimeType: 'video/mp4', data: fs.readFileSync(proxy).toString('base64') }, videoMetadata: { fps: 1 } });
  const aerial = ['aerial-overlay.png', 'aerial-overlay.jpg', 'aerial.jpg'].map(n => path.join(priorsDir, n)).find(p => fs.existsSync(p));
  if (aerial) parts.push({ inlineData: { mimeType: aerial.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(aerial).toString('base64') } });
  if (housePng) parts.push({ inlineData: { mimeType: 'image/png', data: fs.readFileSync(housePng).toString('base64') } });
  if (walkPng) parts.push({ inlineData: { mimeType: 'image/png', data: fs.readFileSync(walkPng).toString('base64') } });
  const context = {
    facts: priors.facts,
    footprint: { areaSqFt: fp.areaSqFt, heightM: fp.heightMeters, edges: fp.edges, houseFramePolygonMeters: housePoly.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })), northDirectionInHouseFrame: { x: +northVec.x.toFixed(3), y: +northVec.y.toFixed(3) }, streetDirectionInHouseFrame: { x: +streetVec.x.toFixed(3), y: +streetVec.y.toFixed(3) } },
    walkedRooms: walkRooms.map(r => ({ id: r.id, name: r.name, walkFrameBox: bounds(r.poly), model: r.model ? { name: r.model.name, zones: r.model.zones?.map(z => z.name) } : null })),
    walkedDoorways: walkDoors,
    walkedOpenings: walkOpenings.map(o => ({ kind: o.kind, t: o.t, description: o.description, leadsTo: o.leadsTo, walkFramePosition: o.position })),
    walkedFeatures: walkFeatures.map((f, i) => ({ n: i + 1, label: f.label, t: f.t, walkFramePosition: f.position })),
  };
  const prompt = `You are placing a partial, measured floor plan of a real single-family house into the house's real building footprint, and sketching where the remaining rooms probably are.
Inputs: (1) the walkthrough video, (2) an aerial photo with the footprint outlined in yellow (north up), (3) the footprint in the HOUSE FRAME (walls axis-aligned; N and street arrows drawn), (4) the walked rooms in the WALK FRAME (walls axis-aligned; orientation relative to the house unknown), (5) JSON context with public facts about the house.
Both frames are in metres. The walk frame can be rotated by exactly 0, 90, 180 or 270 degrees (counter-clockwise) and translated to land in the house frame.
Decide the rotation and translation using cues: which walls of the walked rooms have windows/patio doors and what is outside them (pool/backyard vs street vs neighbour), where the front door and garage would be, the gate/opening directions, the shape of the footprint (the walked kitchen+dining and family room must fit inside it, ideally with their outer walls on footprint edges).
Then, using the listing's room list and the footprint, sketch the rooms that were NOT walked as boxes in the house frame (living room, formal dining if separate, primary suite, bedrooms, bathrooms, laundry, garage, entry, lanai, office). Keep them inside the footprint and not overlapping the walked rooms. These are expectations, not measurements; give each a confidence.
Return ONLY JSON:
{
 "rotationDeg": 0|90|180|270,
 "translation": {"x": metres, "y": metres},
 "cues": ["short reasons, each with a video timestamp or an image reference"],
 "confidence": 0-1,
 "alternatives": [{"rotationDeg": n, "translation": {"x": n, "y": n}, "why": ""}],
 "expectedRooms": [{"name": "", "type": "", "box": {"minX": n, "minY": n, "maxX": n, "maxY": n}, "confidence": 0-1, "basis": "why here"}],
 "notes": "anything the owner should check"
}
CONTEXT JSON:\n${JSON.stringify(context)}`;
  parts.push({ text: prompt });
  fs.writeFileSync(path.join(out, 'site-prompt.txt'), prompt);
  log(`model: ${model} — placing the walk in the footprint…`);
  const started = Date.now();
  const response = await ai.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 65536 } });
  fs.writeFileSync(path.join(out, 'site-fit.raw.txt'), response.text ?? '');
  try { fit = JSON.parse(response.text); } catch { console.error('non-JSON, see site-fit.raw.txt'); process.exit(1); }
  fit._meta = { model, seconds: (Date.now() - started) / 1000, usage: response.usageMetadata };
  fs.writeFileSync(fitPath, JSON.stringify(fit, null, 2));
  log(`model: ${fit._meta.seconds.toFixed(0)} s, rotation ${fit.rotationDeg}°, translation (${fit.translation?.x}, ${fit.translation?.y}), confidence ${fit.confidence}`);
}

// ---------- apply, score, refine ----------
let placedRooms = null, result = null;
if (fit) {
  let rot = [0, 90, 180, 270].includes(fit.rotationDeg) ? fit.rotationDeg : 0;
  let t = { x: Number(fit.translation?.x) || 0, y: Number(fit.translation?.y) || 0 };
  const before = containment(rot, t);
  // Small local search: slide up to ±1.5 m to maximise containment without changing the model's choice of side.
  let best = { score: before, t };
  for (let dx = -1.5; dx <= 1.5; dx += 0.25) for (let dy = -1.5; dy <= 1.5; dy += 0.25) { const tt = { x: t.x + dx, y: t.y + dy }; const s = containment(rot, tt); if (s > best.score + 1e-9) best = { score: s, t: tt }; }
  t = best.t;
  const T = p => transformPoint(p, rot, t);
  placedRooms = {
    rooms: walkRooms.map(r => ({ ...r, poly: r.poly.map(T) })),
    doors: walkDoors.map(d => ({ a: T(d.a), b: T(d.b) })),
    openings: walkOpenings.map(o => ({ ...o, position: T(o.position) })),
    features: walkFeatures.map(f => ({ ...f, position: T(f.position) })),
    dividers: walkDividers.map(z => ({ ...z, a: T(z.a), b: T(z.b), labelAt: z.labelAt ? T(z.labelAt) : null })),
  };
  const expected = (fit.expectedRooms ?? []).filter(r => r.box && [r.box.minX, r.box.minY, r.box.maxX, r.box.maxY].every(Number.isFinite));
  result = { rotationDeg: rot, translation: t, containmentBefore: +before.toFixed(3), containment: +best.score.toFixed(3), expected: expected.length };
  log(`fit: containment ${(before * 100).toFixed(0)}% → ${(best.score * 100).toFixed(0)}% after a ${Math.hypot(t.x - (fit.translation?.x ?? 0), t.y - (fit.translation?.y ?? 0)).toFixed(2)} m nudge; ${expected.length} expected rooms`);
  const finalPng = png(houseSVG({ placed: placedRooms, expected, title: `measured rooms (solid) placed in the real footprint; expected rooms (dashed) from the listing — ${model}` }), 'site-plan.png');
  // Report
  const L = [`# Site fit — ${priors.address}`, '', `Footprint ${fp.areaSqFt} sq ft (${(hb.maxX - hb.minX).toFixed(1)} × ${(hb.maxY - hb.minY).toFixed(1)} m), walls on ${bearing}° · facts: ${priors.facts?.bedrooms ?? '?'} bd / ${priors.facts?.bathrooms ?? '?'} ba, ${priors.facts?.livingAreaSqFt ?? '?'} sq ft living`, '', `## Placement`, '', `- rotation ${rot}°, translation (${t.x.toFixed(2)}, ${t.y.toFixed(2)}) m in the house frame; containment ${(best.score * 100).toFixed(0)}% (model ${(before * 100).toFixed(0)}%)`, `- model confidence ${fit.confidence ?? '?'}`, ...(fit.cues ?? []).map(c => `- cue: ${c}`), ...(fit.alternatives ?? []).map(a => `- alternative: rotation ${a.rotationDeg}°, translation (${a.translation?.x}, ${a.translation?.y}) — ${a.why}`), '', '## Expected rooms (dashed, not measured)', '', ...expected.map(r => `- ${r.name} (${r.type}, ${Math.round((r.confidence ?? 0) * 100)}%): ${(r.box.maxX - r.box.minX).toFixed(1)} × ${(r.box.maxY - r.box.minY).toFixed(1)} m — ${r.basis}`), '', `## Notes`, '', fit.notes ?? '', '', `Files: site-plan.png/svg (result), site-house-frame.png, site-walk-frame.png, site-fit.json`];
  fs.writeFileSync(path.join(out, 'site-report.md'), L.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'site-result.json'), JSON.stringify({ ...result, walkTheta, houseTheta, bearing, northVec, streetVec, housePoly, placed: placedRooms, expected }, null, 1));
  if (finalPng) log(`done → ${finalPng}`);
}
console.log(out);
