// Parity: the JS port must reproduce what the Swift engine wrote into the
// fixture when fed the same stored poses and settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rederive, roomBox, pinBoxEdge, snapBoxToNeighbor, dominantAngleOfPath, dominantAngleOfYaws, rotate } from './public/homewalk-geometry.js';

const fixture = JSON.parse(fs.readFileSync('test-fixtures/homewalk-sample.homewalk/plan.json', 'utf8'));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('rederive reproduces the Swift boxes, pins, snaps and doorways from stored poses', () => {
  // Poses in the fixture are already in the aligned frame, so no further rotation should be found.
  const out = rederive(fixture, {}, { align: false });
  for (let i = 0; i < fixture.rooms.length; i++) {
    const a = fixture.rooms[i].editedPolygon, b = out.rooms[i].editedPolygon;
    for (let k = 0; k < 4; k++) assert.ok(close(a[k].x, b[k].x) && close(a[k].y, b[k].y), `${fixture.rooms[i].name} corner ${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
    assert.ok((fixture.rooms[i].wallSnapShift == null) === (out.rooms[i].wallSnapShift == null));
    if (fixture.rooms[i].wallSnapShift != null) assert.ok(close(fixture.rooms[i].wallSnapShift, out.rooms[i].wallSnapShift));
  }
  for (let i = 0; i < fixture.doorways.length; i++) {
    for (const k of ['endpointA', 'endpointB']) {
      assert.ok(close(fixture.doorways[i][k].x, out.doorways[i][k].x) && close(fixture.doorways[i][k].y, out.doorways[i][k].y), `door ${i} ${k}`);
    }
  }
  assert.equal(out.mismatches.length, fixture.mismatches.length);
  assert.notEqual(out, fixture, 'input not mutated');
  assert.deepEqual(fixture.rooms[0].editedPolygon, JSON.parse(fs.readFileSync('test-fixtures/homewalk-sample.homewalk/plan.json', 'utf8')).rooms[0].editedPolygon);
});

test('a different pad changes the box the way Swift would', () => {
  const out = rederive(fixture, { pad: 0.3 }, { align: false });
  const k = out.rooms[0].editedPolygon;
  const xs = k.map(p => p.x), ys = k.map(p => p.y);
  // Kitchen: walked 0..4 × 0..3 at pad 0.3, east wall pinned at the door tap x = 4.
  assert.ok(close(Math.max(...xs) - Math.min(...xs), 4.3));
  assert.ok(close(Math.max(...ys) - Math.min(...ys), 3.6));
  assert.equal(out.settings.pad, 0.3);
});

test('primitives match Swift semantics', () => {
  const kitchen = roomBox([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], 0.5, 1.2);
  assert.deepEqual(kitchen[0], { x: -0.5, y: -0.5 });
  assert.deepEqual(kitchen[2], { x: 4.5, y: 3.5 });
  const pinned = pinBoxEdge(kitchen, { x: 4.0, y: 1.5 });
  assert.equal(pinned[2].x, 4.0, 'east wall pulled to the tap');
  assert.equal(pinBoxEdge(kitchen, { x: 2, y: 1.5 })[2].x, 4.5, 'a point mid-room pins nothing');
  const hall = [{ x: 3.7, y: 0 }, { x: 8.5, y: 0 }, { x: 8.5, y: 3 }, { x: 3.7, y: 3 }];
  const s = snapBoxToNeighbor(hall, pinned);
  assert.ok(close(s.shift, 0.3) && s.box[0].x === 4.0);
  assert.equal(snapBoxToNeighbor([{ x: 2, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 2, y: 3 }], pinned), null, 'deep overlap not hidden');
  const rect = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }].map(p => rotate(p, 25 * Math.PI / 180));
  assert.ok(close(dominantAngleOfPath(rect) * 180 / Math.PI, 25, 0.5));
  const yaws = Array.from({ length: 120 }, (_, i) => 20 * Math.PI / 180 + Math.floor(i % 4) * Math.PI / 2 + (i % 7 - 3) * 0.01);
  assert.ok(close(dominantAngleOfYaws(yaws) * 180 / Math.PI, 20, 1));
  assert.equal(dominantAngleOfYaws(yaws.slice(0, 10)), null);
});

test('old-style capture (walkPath only) re-derives using the last camera point as the door tap', () => {
  const old = structuredClone(fixture);
  for (const r of old.rooms) { delete r.walkPoses; delete r.doorTapPoint; }
  const out = rederive(old, {}, { align: false });
  assert.ok(close(out.rooms[0].editedPolygon[2].x, fixture.rooms[0].editedPolygon[2].x), 'kitchen east wall pinned from walkPath.last');
  assert.ok(out.rooms[1].wallSnapShift != null, 'hallway still snaps');
});
