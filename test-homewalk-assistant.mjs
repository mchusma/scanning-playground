import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createPlanAssistant } from './homewalk-assistant.mjs';
import { applyEdits, assembleRooms, boxPolygon, sharedEdges } from './public/homewalk-edits.js';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const room = (id, x, name) => ({ id, name, type: 'other', capturedPoints: [], editedPolygon: boxPolygon({ minX: x, maxX: x + 4, minY: 0, maxY: 4 }), revision: 0, isApproximate: true, createdAt: 100, walkPoses: [{ t: 100, camera: { x: x + 1, y: 1 }, yaw: 0, cameraHeight: 1.4 }], walkPath: [], walkTrail: [] });
const plan = () => ({ sessionID: '33333333-3333-4333-8333-333333333333', rooms: [room(A, 0, 'Kitchen'), room(B, 4, 'Dining')], doorways: [{ id: 'door', wallRoomID: A, wallEdgeIndex: 1, endpointA: { x: 4, y: 1 }, endpointB: { x: 4, y: 2 }, width: 1, connectedRoomIDs: [A, B] }], geo: { cameraPlan: { x: 0, y: 0 } }, site: null, events: [{ type: 'walkStarted', timestamp: 100 }], capturedItems: [], transcript: [], observations: [] });

test('shared-wall move changes both rooms and door; raw poses and geographic anchor stay intact', () => {
  const source = plan(), next = applyEdits(source, [{ type: 'moveWall', roomID: A, side: 'maxX', value: 4.7 }]);
  assert.equal(next.rooms[0].editedPolygon[1].x, 4.7);
  assert.equal(next.rooms[1].editedPolygon[0].x, 4.7);
  assert.equal(next.doorways[0].endpointA.x, 4.7);
  assert.deepEqual(next.rooms.map(r => r.walkPoses), source.rooms.map(r => r.walkPoses));
  assert.deepEqual(next.geo, source.geo);
  assert.equal(source.rooms[0].editedPolygon[1].x, 4);
  assert.throws(() => applyEdits(source, [{ type: 'moveWall', roomID: A, side: 'maxX', value: 7.9 }]), /collapse/);
});
test('snap requires nearby facing walls; merge and split preserve evidence and door ownership', () => {
  const source = plan(); source.doorways = []; source.rooms[1] = room(B, 4.2, 'Dining');
  const snapped = applyEdits(source, [{ type: 'joinRooms', roomID: A, otherRoomID: B }]);
  assert.equal(sharedEdges(snapped, A, 'maxX')[0].roomID, B);
  const merged = applyEdits(snapped, [{ type: 'mergeRooms', roomID: A, otherRoomID: B, name: 'Kitchen / dining' }]);
  assert.equal(merged.rooms.length, 1); assert.equal(merged.rooms[0].walkPoses.length, 2);
  const split = applyEdits(plan(), [{ type: 'splitRoom', roomID: A, axis: 'y', value: 2.5, name: 'Pantry' }]);
  assert.equal(split.rooms.length, 3); assert.equal(split.doorways[0].wallRoomID, A);
  source.rooms[1] = room(B, 12, 'Far away');
  assert.throws(() => applyEdits(source, [{ type: 'joinRooms', roomID: A, otherRoomID: B }]), /too far/);
});
test('room translation respects connected rooms and rejects new overlap with unrelated rooms', () => {
  const source = plan(); source.doorways = [];
  const moved = applyEdits(source, [{ type: 'moveRoom', roomID: A, dx: 0.3, dy: 0 }]);
  assert.equal(moved.rooms[1].editedPolygon[0].x, 4.3);
  source.rooms.push(room('third', 9, 'Hall'));
  assert.throws(() => applyEdits(source, [{ type: 'moveRoom', roomID: B, dx: 2, dy: 0 }]), /overlap/);
});
test('segmentation preserves every pose including unassigned and video-missing tail', () => {
  const source = plan(); source.rooms = [room(A, 0, 'Whole walk')];
  source.rooms[0].walkPoses = Array.from({ length: 138 }, (_, i) => ({ t: 100 + i, camera: { x: i / 20, y: 1 }, cameraHeight: 1.4 }));
  const next = assembleRooms(source, [{ start: 0, end: 40, name: 'Kitchen', confidence: 'high', evidence: 'Video' }, { start: 80, end: 138, name: 'Bedroom', confidence: 'low', evidence: 'Audio only' }]);
  assert.equal(next.rooms.reduce((n, r) => n + r.walkPoses.length, 0), 138);
  assert.equal(next.rooms.find(r => r.name === 'Unassigned walk').walkPoses.length, 40);
  assert.equal(next.rooms.find(r => r.name === 'Bedroom').assembly.confidence, 'low');
  assert.throws(() => assembleRooms(source, [{ start: 0, end: 40, name: 'A', confidence: 'high' }, { start: 30, end: 50, name: 'B', confidence: 'low' }]), /overlap/);
});
test('conversation persists evidence, asks without edits, previews before apply, rejects stale edits, and undoes whole revisions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homewalk-assistant-'));
  const calls = [];
  const app = express(); app.use('/plans', createPlanAssistant({ root, respond: async args => {
    calls.push(structuredClone({ message: args.message, evidenceIDs: args.evidenceIDs, state: args.state }));
    if (args.message.includes('rename')) return { reply: 'Preview: rename Kitchen to Pantry.', intent: 'correction', operations: [{ type: 'renameRoom', roomID: A, name: 'Pantry' }], evidenceNotes: ['The homeowner identified this room.'] };
    return { reply: 'Which room does this photo show?', intent: 'question', operations: [], evidenceNotes: [] };
  } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/plans`;
  const call = async (suffix, body, options = {}) => { const r = await fetch(base + suffix, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, ...options }); return { status: r.status, data: await r.json() }; };
  let state = (await call('', { plan: plan() })).data; const id = `/${state.id}`;
  state = (await call(`${id}/evidence?name=door.png`, null, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('test-image') })).data;
  const evidenceID = state.evidence[0].id;
  state = (await call(`${id}/chat`, { revision: 0, message: '', evidenceIDs: [evidenceID] })).data;
  assert.equal(state.draft, null); assert.equal(state.revision, 0); assert.equal(state.messages[1].text, 'Which room does this photo show?');
  state = (await call(`${id}/chat`, { revision: 0, message: 'rename Kitchen to Pantry', evidenceIDs: [] })).data;
  assert.equal(state.plan.rooms[0].name, 'Kitchen'); assert.equal(state.draft.plan.rooms[0].name, 'Pantry');
  assert.equal(calls[1].state.evidence[0].used, true); assert.equal(calls[1].state.messages.length, 2);
  const draftID = state.draft.id;
  state = (await call(`${id}/chat`, { revision: 0, message: 'Which doorway?', evidenceIDs: [] })).data;
  assert.equal(state.draft.id, draftID, 'clarifying conversation retains the pending preview');
  const reordered = plan(); reordered.rooms = reordered.rooms.map(r => Object.fromEntries(Object.entries(r).reverse()));
  state = (await call('', { plan: reordered })).data;
  assert.equal(state.draft.id, draftID, 'native JSON property order does not overwrite a pending preview');
  assert.equal(state.revision, 0);
  state = (await call(`${id}/draft`, { revision: 0, draftID: state.draft.id, accept: true })).data;
  assert.equal(state.plan.rooms[0].name, 'Pantry'); assert.equal(state.revision, 1);
  assert.equal((await call(`${id}/edit`, { revision: 0, operations: [] })).status, 400);
  state = (await call(`${id}/edit`, { revision: 1, operations: [{ type: 'moveWall', roomID: A, side: 'maxX', value: 4.4 }] })).data;
  state = (await call(`${id}/undo`, { revision: state.revision })).data;
  assert.equal(state.plan.rooms[0].name, 'Pantry'); assert.equal(state.plan.rooms[0].editedPolygon[1].x, 4);
  state = (await call(`${id}/undo`, { revision: state.revision })).data;
  assert.equal(state.plan.rooms[0].name, 'Kitchen'); assert.equal(state.canUndo, false);
  const saved = JSON.parse(await fs.readFile(path.join(root, state.id, 'state.json')));
  assert.equal(saved.source.rooms[0].name, 'Kitchen'); assert.equal(saved.revisions.length, 5);
  assert.equal((await call(`${id}/chat`, { revision: state.revision, message: 'hi', evidenceIDs: ['bad'] })).status, 400);
});

test('reopening during a model turn is serialized, stale clients cannot erase later edits, and proposal labels persist', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homewalk-concurrent-'));
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  let calls = 0;
  const app = express(); app.use('/plans', createPlanAssistant({ root, respond: async () => {
    calls++;
    if (calls === 1) { entered(); await gate; }
    return { reply: 'A label change for this proposed layout.', intent: calls === 1 ? 'proposal' : 'correction', operations: [{ type: 'renameRoom', roomID: A, name: calls === 1 ? 'Proposed kitchen' : 'Kitchen option' }] };
  } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { release(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/plans`;
  const post = async (url, body) => { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  let state = (await post('', { plan: plan() })).data, id = `/${state.id}`;
  const chat = post(`${id}/chat`, { revision: 0, message: 'Propose a different kitchen', evidenceIDs: [] });
  await started;
  assert.equal((await post('', { plan: plan() })).status, 409, 'reopening cannot write stale state during a model turn');
  release(); state = (await chat).data;
  state = (await post(`${id}/draft`, { revision: 0, draftID: state.draft.id, accept: true })).data;
  assert.equal(state.kind, 'proposal'); assert.equal(state.plan.planReview.kind, 'proposal');
  const old = structuredClone(state.plan);
  state = (await post(`${id}/chat`, { revision: 1, message: 'Correct the label', evidenceIDs: [] })).data;
  assert.equal(state.draft.kind, 'proposal', 'a correction to a hypothetical layout remains hypothetical');
  state = (await post(`${id}/draft`, { revision: 1, draftID: state.draft.id, accept: true })).data;
  let reopened = (await post('', { plan: old })).data;
  assert.equal(reopened.revision, 2, 'a known older plan opens the latest revision without restoring itself');
  old.rooms[0].name = 'Unsaved edits on stale client';
  assert.equal((await post('', { plan: old })).status, 400);
  const nativeRoundTrip = structuredClone(state.plan);
  nativeRoundTrip.rooms[0].assembly = { confidence: 'low', evidence: 'model metadata is not an edit' };
  reopened = (await post('', { plan: nativeRoundTrip })).data;
  assert.equal(reopened.revision, 2);
});

test('a valid room translation is not rejected by an intermediate collapsed box', () => {
  const source = plan(); source.rooms = [source.rooms[0]]; source.doorways = [];
  for (const dx of [-4.5, 4.5]) {
    const moved = applyEdits(source, [{ type: 'moveRoom', roomID: A, dx, dy: 0 }]);
    assert.equal(moved.rooms[0].editedPolygon[0].x, dx);
    assert.equal(moved.rooms[0].editedPolygon[1].x, dx + 4);
  }
});
