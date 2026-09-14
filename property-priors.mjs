#!/usr/bin/env node
// Property priors: an address → everything public that constrains the floor plan,
// so the walk fills rooms into a known envelope instead of inventing a house.
//
//   node property-priors.mjs "<street address, zip>" [--out dir] [--no-model] [--force]
//
// Sources (no keys except GEMINI_API_KEY for the facts step):
//   • US Census geocoder            → coordinates
//   • OpenStreetMap (Overpass)      → building footprint polygon matched by house number (often county-sourced), height
//   • USGS NAIP imagery (public)    → aerial photo, footprint overlaid
//   • Gemini + Google Search        → beds/baths/living area/lot/year/storeys/garage, listing floor plan URL if any, with sources
//
// Output: <out>/priors.json, footprint.geojson, aerial.jpg, aerial-overlay.jpg, facts.json, report.md.
// The address is used for lookups and written only inside the (gitignored) output folder.
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const args = process.argv.slice(2);
const address = args.find(a => !a.startsWith('--'));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = n => args.includes(`--${n}`);
if (!address) { console.error('usage: node property-priors.mjs "<address>" [--out dir] [--no-model] [--force]'); process.exit(2); }
const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const out = flag('out', path.join('test-output/reference', slug));
fs.mkdirSync(out, { recursive: true });
const log = (...m) => console.error(...m);
const UA = { 'User-Agent': 'homewalk-priors/0.1 (local research tool)' };
const cached = (name, fn) => async () => {
  const p = path.join(out, name);
  if (fs.existsSync(p) && !has('force')) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const v = await fn();
  fs.writeFileSync(p, JSON.stringify(v, null, 1));
  return v;
};

// ---------- 1. geocode ----------
const geocode = await cached('geocode.json', async () => {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' })}`;
  const d = await (await fetch(u, { headers: UA })).json();
  const m = d.result?.addressMatches?.[0];
  if (!m) throw new Error('address not found by the Census geocoder');
  return { matchedAddress: m.matchedAddress, lat: m.coordinates.y, lon: m.coordinates.x, source: 'US Census Bureau geocoder' };
})();
log(`geocode: ${geocode.matchedAddress} → ${geocode.lat.toFixed(6)}, ${geocode.lon.toFixed(6)}`);
const houseNumber = (geocode.matchedAddress.match(/^\s*(\d+[A-Z]?)\b/) ?? address.match(/^\s*(\d+[A-Z]?)\b/))?.[1] ?? null;

// ---------- 2. footprint ----------
const overpass = await cached('osm-buildings.json', async () => {
  const q = `[out:json][timeout:25];way["building"](around:60,${geocode.lat},${geocode.lon});out geom tags;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}` });
  return await r.json();
})();
const ways = overpass.elements ?? [];
let building = ways.find(w => houseNumber && w.tags?.['addr:housenumber'] === houseNumber) ?? null;
let footprintNote = building ? `matched by house number ${houseNumber}` : null;
if (!building && ways.length) {
  // Nearest building centroid to the geocode (the geocode itself is a street-interpolated point; treat as a guess).
  const d = w => { const la = w.geometry.reduce((a, p) => a + p.lat, 0) / w.geometry.length, lo = w.geometry.reduce((a, p) => a + p.lon, 0) / w.geometry.length; return Math.hypot((la - geocode.lat) * 111320, (lo - geocode.lon) * 111320 * Math.cos(geocode.lat * Math.PI / 180)); };
  building = ways.slice().sort((a, b) => d(a) - d(b))[0];
  footprintNote = `nearest building to the geocoded point (${d(building).toFixed(0)} m); no house-number match — verify on the aerial`;
}
let footprint = null;
if (building) {
  const ring = building.geometry.slice();
  if (ring.length > 1 && ring[0].lat === ring.at(-1).lat && ring[0].lon === ring.at(-1).lon) ring.pop();
  const lat0 = ring.reduce((a, p) => a + p.lat, 0) / ring.length, lon0 = ring.reduce((a, p) => a + p.lon, 0) / ring.length;
  const mlat = 111320, mlon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const pts = ring.map(p => ({ east: (p.lon - lon0) * mlon, north: (p.lat - lat0) * mlat }));
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.east * b.north - b.east * a.north; }
  area = Math.abs(area) / 2;
  const edges = pts.map((a, i) => { const b = pts[(i + 1) % pts.length]; return { length: Math.hypot(b.east - a.east, b.north - a.north), bearing: (Math.atan2(b.east - a.east, b.north - a.north) * 180 / Math.PI + 360) % 360 }; });
  let sx = 0, sy = 0;
  for (const e of edges) { sx += e.length * Math.cos(4 * e.bearing * Math.PI / 180); sy += e.length * Math.sin(4 * e.bearing * Math.PI / 180); }
  const grid = ((Math.atan2(sy, sx) * 180 / Math.PI / 4) + 360) % 90;
  const es = pts.map(p => p.east), ns = pts.map(p => p.north);
  footprint = {
    source: `OpenStreetMap way ${building.id}${building.tags?.source ? ` (source tag: ${building.tags.source})` : ''}`,
    note: footprintNote,
    centroid: { lat: lat0, lon: lon0 },
    heightMeters: building.tags?.height ? Number(building.tags.height) : null,
    levels: building.tags?.['building:levels'] ? Number(building.tags['building:levels']) : null,
    areaM2: +area.toFixed(1), areaSqFt: +(area * 10.7639).toFixed(0),
    bboxEastWestM: +(Math.max(...es) - Math.min(...es)).toFixed(2), bboxNorthSouthM: +(Math.max(...ns) - Math.min(...ns)).toFixed(2),
    dominantWallBearingDeg: +grid.toFixed(1),
    edges: edges.map(e => ({ lengthM: +e.length.toFixed(2), bearingDeg: +e.bearing.toFixed(0) })),
    polygonEastNorthM: pts.map(p => ({ east: +p.east.toFixed(3), north: +p.north.toFixed(3) })),
    polygonLatLon: ring,
  };
  fs.writeFileSync(path.join(out, 'footprint.geojson'), JSON.stringify({ type: 'Feature', properties: { osm: building.id, tags: building.tags }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(p => [p.lon, p.lat])] } }, null, 1));
  log(`footprint: ${footprint.areaM2} m² (${footprint.areaSqFt} sq ft), ${footprint.bboxEastWestM} × ${footprint.bboxNorthSouthM} m bbox, walls on ${footprint.dominantWallBearingDeg}° grid, height ${footprint.heightMeters ?? '?'} m — ${footprintNote}`);
} else {
  log('footprint: none in OSM near this address');
}

// ---------- 3. aerial ----------
const centre = footprint?.centroid ?? { lat: geocode.lat, lon: geocode.lon };
const half = 45;
const dlat = half / 111320, dlon = half / (111320 * Math.cos(centre.lat * Math.PI / 180));
const bbox = [centre.lon - dlon, centre.lat - dlat, centre.lon + dlon, centre.lat + dlat];
const aerialPath = path.join(out, 'aerial.jpg');
if (!fs.existsSync(aerialPath) || has('force')) {
  const u = `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?${new URLSearchParams({ bbox: bbox.join(','), bboxSR: 4326, imageSR: 4326, size: '1024,1024', format: 'jpg', f: 'image' })}`;
  try {
    const r = await fetch(u, { headers: UA });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0xff && buf[1] === 0xd8) fs.writeFileSync(aerialPath, buf); else log('aerial: NAIP returned no image');
  } catch (e) { log('aerial: NAIP failed', e.message); }
}
fs.writeFileSync(path.join(out, 'aerial-bbox.json'), JSON.stringify({ bbox, size: [1024, 1024], source: 'USGS NAIP (public domain)' }));
// Overlay via a tiny SVG so no image library is needed; rasterise if rsvg-convert exists.
if (fs.existsSync(aerialPath)) {
  const W = 1024, H = 1024;
  const px = p => [((p.lon - bbox[0]) / (bbox[2] - bbox[0]) * W).toFixed(1), ((bbox[3] - p.lat) / (bbox[3] - bbox[1]) * H).toFixed(1)];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}"><image href="data:image/jpeg;base64,${fs.readFileSync(aerialPath).toString('base64')}" width="${W}" height="${H}"/>`;
  for (const w of ways) {
    const target = w === building;
    svg += `<polygon points="${w.geometry.map(p => px(p).join(',')).join(' ')}" fill="none" stroke="${target ? '#ffe600' : '#00c8ff'}" stroke-width="${target ? 4 : 2}"/>`;
  }
  svg += `<g stroke="#fff" fill="#fff" font-family="Arial" font-size="14"><line x1="60" y1="120" x2="60" y2="60" stroke-width="3"/><polygon points="60,50 52,68 68,68"/><text x="50" y="140">N</text><line x1="${W - 40 - 10 * (W / (2 * half))}" y1="${H - 30}" x2="${W - 40}" y2="${H - 30}" stroke-width="3"/><text x="${W - 40 - 5 * (W / (2 * half))}" y="${H - 40}" text-anchor="middle">10 m</text></g></svg>`;
  fs.writeFileSync(path.join(out, 'aerial-overlay.svg'), svg);
  try { const { execFileSync } = await import('node:child_process'); execFileSync('rsvg-convert', [path.join(out, 'aerial-overlay.svg'), '-o', path.join(out, 'aerial-overlay.png')]); } catch {}
  log('aerial: saved with footprint overlay');
}

// ---------- 4. facts via Gemini + Google Search ----------
let facts = null;
const factsPath = path.join(out, 'facts.json');
if (has('no-model')) {
  log('facts: skipped');
} else if (fs.existsSync(factsPath) && !has('force')) {
  facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  log('facts: cached');
} else if (!process.env.GEMINI_API_KEY) {
  log('facts: GEMINI_API_KEY not set, skipped');
} else {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = flag('model', 'gemini-3.1-pro-preview');
  const prompt = `Research the property at "${geocode.matchedAddress}" using web search. Find public listing / assessor / real-estate data.
Return ONLY JSON:
{
 "propertyType": "single-family|townhouse|condo|apartment|multi-family|unknown",
 "bedrooms": number|null, "bathrooms": number|null, "livingAreaSqFt": number|null, "lotSizeSqFt": number|null,
 "yearBuilt": number|null, "storeys": number|null, "garage": "attached 2-car|detached|carport|none|unknown", "pool": true|false|null,
 "roomsMentioned": ["names of rooms/spaces mentioned in listing text, e.g. family room, dining room, primary suite, bonus room"],
 "floorPlanURL": "URL of a floor plan image or page if any listing shows one, else null",
 "listingPhotoNotes": "one line on what interior photos show, if any",
 "lastListedOrSold": "date and price if public, else null",
 "confidence": 0-1,
 "sources": [{"title": "", "url": "", "whatItGave": ""}],
 "caveats": ["..."]
}
Only report facts you actually found; use null otherwise. Prefer assessor/county and major listing sites; note disagreements between sources in caveats.`;
  const started = Date.now();
  const response = await ai.models.generateContent({ model, contents: prompt, config: { tools: [{ googleSearch: {} }], temperature: 0.1 } });
  const text = response.text ?? '';
  fs.writeFileSync(path.join(out, 'facts.raw.txt'), text);
  const m = text.match(/\{[\s\S]*\}/);
  try { facts = JSON.parse(m ? m[0] : text); } catch { log('facts: model returned non-JSON, see facts.raw.txt'); }
  if (facts) {
    const gm = response.candidates?.[0]?.groundingMetadata;
    facts._grounding = { queries: gm?.webSearchQueries ?? [], chunks: (gm?.groundingChunks ?? []).map(c => ({ title: c.web?.title, uri: c.web?.uri })) };
    facts._meta = { model, seconds: (Date.now() - started) / 1000, usage: response.usageMetadata };
    fs.writeFileSync(factsPath, JSON.stringify(facts, null, 1));
    log(`facts: ${facts.propertyType ?? '?'}, ${facts.bedrooms ?? '?'} bd / ${facts.bathrooms ?? '?'} ba, ${facts.livingAreaSqFt ?? '?'} sq ft living, lot ${facts.lotSizeSqFt ?? '?'} sq ft, built ${facts.yearBuilt ?? '?'}, ${facts.storeys ?? '?'} storey(s)${facts.floorPlanURL ? ', floor plan: ' + facts.floorPlanURL : ''} (${facts._grounding.chunks.length} sources, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
}

// ---------- 5. priors bundle ----------
const priors = {
  schema: 'homewalk-priors/1',
  createdAt: new Date().toISOString(),
  address: geocode.matchedAddress,
  location: { lat: centre.lat, lon: centre.lon, geocodeSource: geocode.source },
  footprint,
  aerial: fs.existsSync(aerialPath) ? { file: 'aerial.jpg', overlay: fs.existsSync(path.join(out, 'aerial-overlay.png')) ? 'aerial-overlay.png' : 'aerial-overlay.svg', bbox, metersPerPixel: +((2 * half) / 1024).toFixed(4), source: 'USGS NAIP' } : null,
  facts: facts ? Object.fromEntries(Object.entries(facts).filter(([k]) => !k.startsWith('_'))) : null,
  derived: footprint ? {
    interiorEstimateSqFt: facts?.livingAreaSqFt ?? null,
    footprintVsLiving: facts?.livingAreaSqFt ? +(footprint.areaSqFt / facts.livingAreaSqFt).toFixed(2) : null,
    likelyStoreys: facts?.storeys ?? (footprint.heightMeters ? (footprint.heightMeters > 4.6 ? 2 : 1) : null),
    wallGridBearingDeg: footprint.dominantWallBearingDeg,
  } : null,
};
fs.writeFileSync(path.join(out, 'priors.json'), JSON.stringify(priors, null, 1));

const L = [];
L.push(`# Property priors — ${geocode.matchedAddress}`, '');
if (footprint) {
  L.push('## Footprint (public map data)', '', `- ${footprint.areaM2} m² / ${footprint.areaSqFt} sq ft, bounding box ${footprint.bboxEastWestM} × ${footprint.bboxNorthSouthM} m (E-W × N-S)`, `- walls on a **${footprint.dominantWallBearingDeg}°** grid from north; height ${footprint.heightMeters ?? '?'} m${footprint.levels ? `, ${footprint.levels} levels` : ''}`, `- edges: ${footprint.edges.map(e => `${e.lengthM} m @ ${e.bearingDeg}°`).join(', ')}`, `- ${footprint.source}; ${footprint.note}`, '');
}
if (facts) {
  L.push('## Facts (web, model-compiled — verify)', '', `- ${facts.propertyType ?? '?'} · ${facts.bedrooms ?? '?'} bed / ${facts.bathrooms ?? '?'} bath · ${facts.livingAreaSqFt ?? '?'} sq ft living · lot ${facts.lotSizeSqFt ?? '?'} sq ft · built ${facts.yearBuilt ?? '?'} · ${facts.storeys ?? '?'} storey(s) · garage ${facts.garage ?? '?'}${facts.pool ? ' · pool' : ''}`);
  if (facts.roomsMentioned?.length) L.push(`- rooms mentioned: ${facts.roomsMentioned.join(', ')}`);
  if (facts.floorPlanURL) L.push(`- **floor plan found:** ${facts.floorPlanURL}`);
  if (facts.listingPhotoNotes) L.push(`- photos: ${facts.listingPhotoNotes}`);
  if (facts.lastListedOrSold) L.push(`- last listed/sold: ${facts.lastListedOrSold}`);
  if (priors.derived?.footprintVsLiving) L.push(`- footprint ÷ living area = ${priors.derived.footprintVsLiving} (≈1 single storey incl. garage; <1 suggests two storeys)`);
  for (const c of facts.caveats ?? []) L.push(`- caveat: ${c}`);
  L.push('', '### Sources', '');
  for (const s of facts.sources ?? []) L.push(`- [${s.title}](${s.url}) — ${s.whatItGave}`);
  for (const c of facts._grounding?.chunks ?? []) if (!(facts.sources ?? []).some(s => s.url === c.uri)) L.push(`- ${c.title}: ${c.uri}`);
}
L.push('', `Files: priors.json, footprint.geojson, aerial.jpg, aerial-overlay.${fs.existsSync(path.join(out, 'aerial-overlay.png')) ? 'png' : 'svg'}, facts.json`);
fs.writeFileSync(path.join(out, 'report.md'), L.join('\n') + '\n');
log(`done → ${out}`);
console.log(out);
