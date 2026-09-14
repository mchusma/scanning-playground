// Relay test: a fake phone sends snapshots, a viewer sees them, settings and
// commands go back to the phone, /live/latest works, and a .jsonl is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket from 'ws';
import { createLiveRelay } from './live-relay.mjs';

const fixture = JSON.parse(fs.readFileSync('test-fixtures/homewalk-sample.homewalk/plan.json', 'utf8'));
const snapshot = {
  type: 'snapshot', t: Date.now() / 1000, sessionID: fixture.sessionID, name: fixture.name, tracking: 'Tracking OK', phase: 'walking', walking: true,
  settings: fixture.settings,
  rooms: fixture.rooms.map(r => ({ id: r.id, name: r.name, type: r.type, polygon: r.editedPolygon, tape: r.tapeSize, snap: r.wallSnapShift })),
  doorways: fixture.doorways.map(d => ({ a: d.endpointA, b: d.endpointB, rooms: d.connectedRoomIDs })),
  inProgress: { label: 'Room 4', samples: [{ x: 10, y: 1 }, { x: 12, y: 1 }], hits: [{ x: 11, y: 2 }], box: [{ x: 9.5, y: 0.5 }, { x: 12.5, y: 0.5 }, { x: 12.5, y: 1.7 }, { x: 9.5, y: 1.7 }], size: { x: 3, y: 1.2 }, rawSize: { x: 2, y: 0 }, poseCount: 12, lastCameraHeight: 1.41, lastYawDegrees: 12 },
  grid: { angleDegrees: 20, applied: 20, yawVotes: 88, pathMeters: 31.5 },
  media: { videoFrames: 300, videoDropped: 1, recording: true },
  checks: [0.19], mismatches: [],
};

const once = (ws, ev) => new Promise(res => ws.once(ev, res));
const nextMessage = ws => new Promise(res => ws.once('message', d => res(JSON.parse(d.toString()))));

test('relay: phone → viewer, viewer/HTTP → phone, latest + jsonl', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homewalk-live-'));
  const app = express();
  const relay = createLiveRelay({ app, logDir });
  const server = app.listen(0);
  relay.attach(server);
  await once(server, 'listening');
  const port = server.address().port;

  const phone = new WebSocket(`ws://127.0.0.1:${port}/live?role=phone`);
  await once(phone, 'open');
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/live?role=viewer`);
  await once(viewer, 'open');

  const seen = nextMessage(viewer);
  const ack = nextMessage(phone);
  phone.send(JSON.stringify(snapshot));
  const got = await seen;
  assert.equal(got.type, 'snapshot');
  assert.equal(got.rooms.length, 3);
  assert.equal((await ack).type, 'ack', 'phone gets an ack so its receive loop sees life');

  const latest = await (await fetch(`http://127.0.0.1:${port}/live/latest`)).json();
  assert.equal(latest.name, fixture.name);
  assert.equal(latest.phones, 1);
  assert.equal(latest.viewers, 1);

  // Viewer pushes settings; phone receives them verbatim.
  const toPhone = nextMessage(phone);
  viewer.send(JSON.stringify({ type: 'settings', settings: { ...fixture.settings, pad: 0.35 }, rebox: true }));
  const s = await toPhone;
  assert.equal(s.type, 'settings');
  assert.equal(s.settings.pad, 0.35);
  assert.equal(s.rebox, true);

  // curl-style push without a browser.
  const toPhone2 = nextMessage(phone);
  const r = await (await fetch(`http://127.0.0.1:${port}/live/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { pad: 0.6 } }) })).json();
  assert.equal(r.sentTo, 1);
  assert.equal((await toPhone2).settings.pad, 0.6);
  const toPhone3 = nextMessage(phone);
  await fetch(`http://127.0.0.1:${port}/live/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alignNow' }) });
  assert.deepEqual(await toPhone3, { type: 'command', name: 'alignNow' });

  // A late viewer gets the latest snapshot immediately.
  const late = new WebSocket(`ws://127.0.0.1:${port}/live?role=viewer`);
  const first = nextMessage(late);
  await once(late, 'open');
  assert.equal((await first).type, 'snapshot');

  await new Promise(r => setTimeout(r, 50));
  const logFile = path.join(logDir, `${fixture.sessionID}.jsonl`);
  assert.ok(fs.existsSync(logFile), 'snapshot logged');
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 1);

  phone.close(); viewer.close(); late.close();
  await new Promise(r => server.close(r));
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('site preview reuses canonical cache and serves facts plus the aerial', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homewalk-property-'));
  const dir = path.join(root, 'reference', '12-test-st-00000');
  fs.mkdirSync(dir, { recursive: true });
  const address = '12 Test St, Example, CA 00000';
  const priors = {
    address,
    footprint: {
      polygonEastNorthM: [{ east: -5, north: -4 }, { east: 5, north: -4 }, { east: 5, north: 4 }, { east: -5, north: 4 }],
      centroid: { lat: 30, lon: -100 }, dominantWallBearingDeg: 40, areaM2: 80,
      bboxEastWestM: 10, bboxNorthSouthM: 8, source: 'test footprint',
    },
    facts: { bedrooms: 3, bathrooms: 2, livingAreaSqFt: 800, storeys: null, roomsMentioned: ['Kitchen', 'Bedroom'] },
    derived: { likelyStoreys: 2 },
  };
  fs.writeFileSync(path.join(dir, 'priors.json'), JSON.stringify(priors));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'aerial-overlay.png'), png);
  const app = express();
  createLiveRelay({ app, logDir: path.join(root, 'live') });
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/site?address=${encodeURIComponent(address)}`);
  assert.equal(response.status, 200, 'canonical address finds the short-address cache without fetching');
  const site = await response.json();
  assert.deepEqual(site.footprintEastNorth[0], { x: -5, y: -4 });
  assert.equal(site.propertyFacts.bedrooms, 3);
  assert.equal(site.propertyFacts.storeys, null, 'never substitute an unsupported derived guess');
  assert.equal(site.propertyFacts.verified, false);
  assert.deepEqual(site.propertyFacts.roomsMentioned, ['Kitchen', 'Bedroom']);
  const aerial = await fetch(base + site.aerialPath);
  assert.equal(aerial.status, 200);
  assert.deepEqual(Buffer.from(await aerial.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/site?address=...`)).status, 400);
  delete priors.facts;
  fs.writeFileSync(path.join(dir, 'priors.json'), JSON.stringify(priors));
  fs.unlinkSync(path.join(dir, 'aerial-overlay.png'));
  const missing = await (await fetch(`${base}/site?address=${encodeURIComponent(address)}`)).json();
  assert.equal(missing.propertyFacts.bedrooms, null);
  assert.deepEqual(missing.propertyFacts.roomsMentioned, []);
  assert.equal(missing.aerialPath, null);
});
