/**
 * Node.js test for svg-export.js
 *
 * Runs all presets, validates SVG output, checks diagnostics, and catches regressions.
 * Run: node test-svg-export.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// We can't import ES modules with DOM dependencies directly, so we'll
// extract and eval the pure functions. Instead, let's replicate the core
// logic for testing since the module uses no DOM in generateFloorPlanSVG.

// Dynamically import by faking globalThis for browser APIs we don't need
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const svgExportSource = readFileSync(path.join(__dirname, 'public/svg-export.js'), 'utf8');

// The svg-export.js module uses no DOM APIs in generateFloorPlanSVG or diagnoseHomeState,
// so we can import it directly
const { generateFloorPlanSVG, diagnoseHomeState, svgToDataUrl } = await import('./public/svg-export.js');

const OUTPUT_DIR = path.join(__dirname, 'test-output');
mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Test utilities ────────────────────────────────────────────────────────
let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, msg) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    console.error(`  ✗ ${msg}`);
  }
}

function slugify(v) {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function makeState() {
  return { rooms: new Map(), edges: [], locationRoomId: null, heading: 'north' };
}

function addRoom(state, name, type, conf, features, x, y) {
  const id = slugify(name);
  state.rooms.set(id, {
    id, name, roomType: type || 'room', confidence: conf ?? 0.8,
    features: features || [], x: x ?? 200, y: y ?? 200,
    vx: 0, vy: 0, createdAt: Date.now(), spawnedAt: Date.now(), lastSeen: Date.now(),
    positionSource: 'test',
  });
  return state.rooms.get(id);
}

function addEdge(state, fromName, toName, pathType, anchorDir) {
  const fromId = slugify(fromName);
  const toId = slugify(toName);
  state.edges.push({
    key: [fromId, toId].sort().join('::'),
    fromId, toId,
    pathType: pathType || 'doorway',
    anchorFromId: anchorDir ? fromId : null,
    anchorDirection: anchorDir || null,
    updatedAt: Date.now(),
  });
}

// ── Test: Empty state ─────────────────────────────────────────────────────
console.log('\n▸ Empty state');
{
  const state = makeState();
  const svg = generateFloorPlanSVG(state);
  assert(svg.includes('<svg'), 'produces valid SVG opening tag');
  assert(svg.includes('No rooms mapped'), 'shows empty message');
  assert(svg.includes('</svg>'), 'closes SVG tag');
  writeFileSync(path.join(OUTPUT_DIR, 'empty.svg'), svg);
}

// ── Test: Single room ─────────────────────────────────────────────────────
console.log('\n▸ Single room');
{
  const state = makeState();
  addRoom(state, 'Kitchen', 'kitchen', 0.9, ['fridge', 'stove'], 300, 200);
  state.locationRoomId = 'kitchen';

  const svg = generateFloorPlanSVG(state, { debug: true });
  assert(svg.includes('data-room-id="kitchen"'), 'room has data-room-id attribute');
  assert(svg.includes('Kitchen'), 'room name rendered');
  assert(svg.includes('kitchen'), 'room type rendered');
  assert(svg.includes('90%'), 'confidence rendered');
  assert(svg.includes('fridge'), 'features rendered');
  assert(svg.includes('location-marker'), 'location marker present');
  assert(svg.includes('compass'), 'compass rose present');
  assert(svg.includes('scale-bar'), 'scale bar present');
  assert(svg.includes('<!-- Room: kitchen'), 'debug comments present');
  writeFileSync(path.join(OUTPUT_DIR, 'single-room.svg'), svg);

  const diag = diagnoseHomeState(state);
  assert(diag.ok, 'diagnostics OK');
  assert(diag.roomCount === 1, 'room count correct');
}

// ── Test: Two connected rooms ─────────────────────────────────────────────
console.log('\n▸ Two connected rooms');
{
  const state = makeState();
  addRoom(state, 'Living Room', 'living room', 0.9, ['sofa'], 200, 200);
  addRoom(state, 'Kitchen', 'kitchen', 0.85, ['fridge'], 380, 200);
  addEdge(state, 'Living Room', 'Kitchen', 'open-plan', 'east');

  const svg = generateFloorPlanSVG(state);
  assert(svg.includes('data-room-id="living-room"'), 'first room present');
  assert(svg.includes('data-room-id="kitchen"'), 'second room present');
  assert(svg.includes('open-plan'), 'edge label rendered');
  assert(svg.includes('data-edge='), 'edge data attribute present');
  assert(svg.includes('stroke-dasharray'), 'door/connection rendered');
  writeFileSync(path.join(OUTPUT_DIR, 'two-rooms.svg'), svg);
}

// ── Test: 3-bedroom house preset ──────────────────────────────────────────
console.log('\n▸ 3-bedroom house');
{
  const state = makeState();
  addRoom(state, 'Entryway', 'entryway', 0.95, [], 200, 400);
  addRoom(state, 'Hallway', 'hallway', 0.9, [], 200, 260);
  addRoom(state, 'Living Room', 'living room', 0.9, ['sofa', 'TV', 'fireplace'], 60, 260);
  addRoom(state, 'Kitchen', 'kitchen', 0.9, ['fridge', 'stove', 'island'], 60, 120);
  addRoom(state, 'Dining Room', 'dining room', 0.85, ['table', '8 chairs'], 240, 120);
  addRoom(state, 'Primary Bedroom', 'bedroom', 0.85, ['king bed', 'closet'], 380, 260);
  addRoom(state, 'Bedroom 2', 'bedroom', 0.8, ['queen bed'], 200, 540);
  addRoom(state, 'Bedroom 3', 'bedroom', 0.75, ['twin beds'], 200, 120);
  addRoom(state, 'Primary Bath', 'bathroom', 0.85, ['shower', 'tub'], 380, 400);
  addRoom(state, 'Hall Bath', 'bathroom', 0.8, ['shower', 'toilet'], 380, 120);
  addEdge(state, 'Entryway', 'Hallway', 'archway', 'north');
  addEdge(state, 'Hallway', 'Living Room', 'archway', 'west');
  addEdge(state, 'Living Room', 'Kitchen', 'open-plan', 'north');
  addEdge(state, 'Kitchen', 'Dining Room', 'archway', 'east');
  addEdge(state, 'Hallway', 'Primary Bedroom', 'doorway', 'east');
  addEdge(state, 'Hallway', 'Bedroom 2', 'doorway', 'south');
  addEdge(state, 'Hallway', 'Bedroom 3', 'doorway', 'north');
  addEdge(state, 'Primary Bedroom', 'Primary Bath', 'doorway', 'south');
  addEdge(state, 'Hallway', 'Hall Bath', 'doorway', 'east');
  state.locationRoomId = 'living-room';
  state.heading = 'east';

  const svg = generateFloorPlanSVG(state, { debug: true });
  assert(svg.includes('Entryway'), 'entryway rendered');
  assert(svg.includes('Primary Bedroom'), 'primary bedroom rendered');
  assert((svg.match(/data-room-id=/g) || []).length === 10, 'all 10 rooms rendered');
  assert(svg.includes('data-edge='), 'edges rendered');
  writeFileSync(path.join(OUTPUT_DIR, '3bed-house.svg'), svg);

  const diag = diagnoseHomeState(state);
  assert(diag.ok, 'diagnostics OK');
  assert(diag.roomCount === 10, '10 rooms counted');
  assert(diag.edgeCount === 9, '9 edges counted');
  assert(diag.isolatedRooms === 0, 'no isolated rooms');
}

// ── Test: Stress test (20 rooms) ──────────────────────────────────────────
console.log('\n▸ Stress test (20 rooms)');
{
  const state = makeState();
  const types = ['bedroom', 'bathroom', 'kitchen', 'living room', 'office', 'hallway', 'closet', 'pantry'];
  for (let i = 0; i < 20; i++) {
    addRoom(state, `Room ${i + 1}`, types[i % types.length], 0.5 + Math.random() * 0.5,
      [`feat-${i}`], 100 + (i % 5) * 180, 100 + Math.floor(i / 5) * 140);
  }
  for (let i = 0; i < 19; i++) {
    addEdge(state, `Room ${i + 1}`, `Room ${i + 2}`, 'doorway');
  }
  state.locationRoomId = 'room-1';

  const t0 = performance.now();
  const svg = generateFloorPlanSVG(state, { debug: true });
  const elapsed = performance.now() - t0;

  assert(elapsed < 100, `renders in ${elapsed.toFixed(1)}ms (< 100ms)`);
  assert((svg.match(/data-room-id=/g) || []).length === 20, 'all 20 rooms rendered');

  const sizeKb = (Buffer.byteLength(svg) / 1024).toFixed(1);
  assert(Number(sizeKb) < 100, `SVG size ${sizeKb}KB (< 100KB)`);
  writeFileSync(path.join(OUTPUT_DIR, 'stress-20.svg'), svg);

  console.log(`    Size: ${sizeKb}KB, Time: ${elapsed.toFixed(1)}ms`);
}

// ── Test: Debug mode vs non-debug ─────────────────────────────────────────
console.log('\n▸ Debug mode toggle');
{
  const state = makeState();
  addRoom(state, 'Test Room', 'bedroom', 0.7, [], 300, 300);

  const debugSvg = generateFloorPlanSVG(state, { debug: true });
  const cleanSvg = generateFloorPlanSVG(state, { debug: false });

  assert(debugSvg.includes('<!-- Room:'), 'debug mode has comments');
  assert(!cleanSvg.includes('<!-- Room:'), 'non-debug mode has no debug comments');
  assert(debugSvg.includes('debug-text'), 'debug mode has debug text class');
  assert(!cleanSvg.includes('debug-text'), 'non-debug mode has no debug text class');
  assert(debugSvg.length > cleanSvg.length, 'debug SVG is larger');
}

// ── Test: Animation toggle ────────────────────────────────────────────────
console.log('\n▸ Animation toggle');
{
  const state = makeState();
  addRoom(state, 'Test Room', 'bedroom', 0.7, [], 300, 300);

  const animSvg = generateFloorPlanSVG(state, { animate: true });
  const staticSvg = generateFloorPlanSVG(state, { animate: false });

  assert(animSvg.includes('@keyframes'), 'animated SVG has keyframes');
  assert(!staticSvg.includes('@keyframes'), 'static SVG has no keyframes');
}

// ── Test: Diagnostics ─────────────────────────────────────────────────────
console.log('\n▸ Diagnostics');
{
  // Missing room reference
  const state = makeState();
  addRoom(state, 'A', 'room', 0.8, [], 200, 200);
  state.edges.push({
    key: 'a::missing',
    fromId: 'a',
    toId: 'missing',
    pathType: 'doorway',
    anchorFromId: null,
    anchorDirection: null,
    updatedAt: Date.now(),
  });

  const diag = diagnoseHomeState(state);
  assert(!diag.ok, 'detects missing room reference');
  assert(diag.issues.some(i => i.msg.includes('missing')), 'reports missing room');
}
{
  // Overlapping rooms
  const state = makeState();
  addRoom(state, 'A', 'room', 0.8, [], 200, 200);
  addRoom(state, 'B', 'room', 0.8, [], 210, 205);

  const diag = diagnoseHomeState(state);
  assert(diag.issues.some(i => i.msg.includes('overlap')), 'detects overlapping rooms');
}
{
  // Self-loop edge
  const state = makeState();
  addRoom(state, 'A', 'room', 0.8, [], 200, 200);
  state.edges.push({
    key: 'a::a',
    fromId: 'a',
    toId: 'a',
    pathType: 'doorway',
    anchorFromId: null,
    anchorDirection: null,
    updatedAt: Date.now(),
  });

  const diag = diagnoseHomeState(state);
  assert(diag.issues.some(i => i.msg.includes('self-loop')), 'detects self-loop');
}
{
  // Invalid position
  const state = makeState();
  addRoom(state, 'Bad', 'room', 0.8, [], NaN, undefined);

  const diag = diagnoseHomeState(state);
  assert(diag.issues.some(i => i.msg.includes('invalid position')), 'detects invalid position');
}

// ── Test: SVG well-formedness ─────────────────────────────────────────────
console.log('\n▸ SVG well-formedness');
{
  const state = makeState();
  addRoom(state, 'Room <script>', 'room', 0.8, ['feat & "stuff"'], 200, 200);

  const svg = generateFloorPlanSVG(state);
  assert(!svg.includes('<script>'), 'HTML entities are escaped in names');
  assert(svg.includes('&lt;script&gt;'), 'angle brackets properly escaped');
  assert(svg.includes('&amp;'), 'ampersand properly escaped');
}

// ── Test: svgToDataUrl ────────────────────────────────────────────────────
console.log('\n▸ Data URL generation');
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const url = svgToDataUrl(svg);
  assert(url.startsWith('data:image/svg+xml;charset=utf-8,'), 'correct data URL prefix');
  assert(url.includes(encodeURIComponent('<svg')), 'SVG content encoded');
}

// ── Test: All room types render without error ─────────────────────────────
console.log('\n▸ All room types');
{
  const state = makeState();
  const types = ['kitchen', 'bathroom', 'bedroom', 'primary bedroom', 'guest bedroom',
    'office', 'home office', 'living room', 'family room', 'dining room', 'hallway',
    'entryway', 'garage', 'laundry', 'laundry room', 'pantry', 'closet', 'basement',
    'attic', 'den', 'patio', 'balcony', 'mudroom', 'utility', 'unknown-type'];

  for (let i = 0; i < types.length; i++) {
    addRoom(state, `${types[i]} Room`, types[i], 0.8, [], 100 + (i % 6) * 160, 100 + Math.floor(i / 6) * 130);
  }

  let threw = false;
  try {
    const svg = generateFloorPlanSVG(state);
    assert(svg.includes('</svg>'), 'all room types render without error');
    writeFileSync(path.join(OUTPUT_DIR, 'all-types.svg'), svg);
  } catch (e) {
    threw = true;
    assert(false, `all room types threw: ${e.message}`);
  }
}

// ── Test: All path types render ────────────────────────────────────────────
console.log('\n▸ All path types');
{
  const state = makeState();
  const pathTypes = ['doorway', 'archway', 'hallway', 'stairs', 'open-plan', 'path'];
  for (let i = 0; i < pathTypes.length; i++) {
    addRoom(state, `Room ${i}A`, 'room', 0.8, [], 100 + i * 200, 200);
    addRoom(state, `Room ${i}B`, 'room', 0.8, [], 100 + i * 200, 340);
    state.edges.push({
      key: `room-${i}a::room-${i}b`,
      fromId: `room-${i}a`, toId: `room-${i}b`,
      pathType: pathTypes[i],
      anchorFromId: `room-${i}a`, anchorDirection: 'south',
      updatedAt: Date.now(),
    });
  }

  const svg = generateFloorPlanSVG(state, { debug: false });
  assert(svg.includes('data-type="door"'), 'doorway renders as door');
  assert(svg.includes('data-type="archway"'), 'archway renders');
  assert(svg.includes('data-type="stairs"'), 'stairs renders');
  assert(svg.includes('data-type="open-plan"'), 'open-plan renders');
  writeFileSync(path.join(OUTPUT_DIR, 'all-path-types.svg'), svg);
}

// ── Test: Door wall spreading ─────────────────────────────────────────────
console.log('\n▸ Door wall spreading');
{
  const state = makeState();
  addRoom(state, 'Center', 'hallway', 0.9, [], 300, 300);
  addRoom(state, 'North 1', 'bedroom', 0.8, [], 300, 160);
  addRoom(state, 'North 2', 'bathroom', 0.8, [], 300, 20);
  state.edges.push(
    { key: 'center::north-1', fromId: 'center', toId: 'north-1', pathType: 'doorway', anchorFromId: 'center', anchorDirection: 'north', updatedAt: Date.now() },
    { key: 'center::north-2', fromId: 'center', toId: 'north-2', pathType: 'doorway', anchorFromId: 'center', anchorDirection: 'north', updatedAt: Date.now() },
  );

  const svg = generateFloorPlanSVG(state, { debug: true });
  // The two doors on center's north wall should be at different X positions
  const northWallDoors = [...svg.matchAll(/translate\(([\d.]+),([\d.]+)\) rotate\(0\)" data-type="door"/g)];
  assert(northWallDoors.length >= 2, `found ${northWallDoors.length} north wall doors (expect >=2)`);
  if (northWallDoors.length >= 2) {
    const x1 = parseFloat(northWallDoors[0][1]);
    const x2 = parseFloat(northWallDoors[1][1]);
    assert(Math.abs(x1 - x2) > 5, `north wall doors spread apart (x1=${x1}, x2=${x2})`);
  }
  writeFileSync(path.join(OUTPUT_DIR, 'door-spreading.svg'), svg);
}

// ── Test: Long room names truncation ──────────────────────────────────────
console.log('\n▸ Long room names');
{
  const state = makeState();
  addRoom(state, 'Very Long Room Name That Should Be Truncated', 'bedroom', 0.8, ['feature1', 'feature2', 'feature3', 'feature4'], 300, 200);

  const svg = generateFloorPlanSVG(state, { debug: false });
  assert(svg.includes('\u2026'), 'long name is truncated with ellipsis');
  assert(!svg.includes('Very Long Room Name That Should Be Truncated'), 'full long name is NOT in output');
  writeFileSync(path.join(OUTPUT_DIR, 'long-names.svg'), svg);
}

// ── Test: Compass heading rotation ────────────────────────────────────────
console.log('\n▸ Compass headings');
{
  const state = makeState();
  addRoom(state, 'Test', 'room', 0.8, [], 200, 200);

  for (const heading of ['north', 'east', 'south', 'west']) {
    state.heading = heading;
    const svg = generateFloorPlanSVG(state, { debug: false });
    assert(svg.includes('class="compass"'), `compass present for heading ${heading}`);
    assert(svg.includes('>N<'), `N label present for heading ${heading}`);
    assert(svg.includes('>E<'), `E label present for heading ${heading}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log(`SVG files written to: ${OUTPUT_DIR}/`);

if (failCount > 0) {
  process.exit(1);
}
