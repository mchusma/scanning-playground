import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReplayFixture } from './scripts/prepare-homewalk-replay.mjs';

const priors = {
  address: 'Example property',
  footprint: { polygonEastNorthM: [{ east: 0, north: 0 }, { east: 5, north: 0 }, { east: 5, north: 4 }], centroid: { lat: 30, lon: -100 }, dominantWallBearingDeg: 40, areaM2: 10, source: 'fixture' },
  facts: { bedrooms: 3, storeys: null }, derived: { likelyStoreys: 2 },
};
const pose = t => ({ t, camera: { x: t - 100, y: 0 }, cameraHeight: 1.5, yaw: 0 });
const document = {
  sessionID: 'source', floor: { basis: { origin: { x: 0, y: 0, z: 0 } }, gridAngle: 0.7 },
  events: [{ type: 'walkStarted', timestamp: 100 }],
  rooms: [{ walkPoses: [pose(101), pose(102)], walkEndedAt: 105 }, { walkPoses: [pose(102), pose(104)], walkEndedAt: 110 }],
  inProgress: { walkPoses: [] }, media: { audioStartedAt: 100.2 },
  capturedItems: [{ timestamp: 101.5, transcript: 'Here is the front door' }],
  transcript: [{ startedAt: 101, endedAt: 104, text: 'This is the kitchen' }],
};

test('replay retains real pose times, separates media coverage, and marks an estimated video anchor', () => {
  const before = JSON.stringify(document);
  const f = makeReplayFixture(document, priors, { videoDuration: 6, audioDuration: 9 });
  assert.deepEqual(f.poses.map(p => p.t), [101, 102, 104]);
  assert.equal(f.duration, 10);
  assert.equal(f.videoDuration, 6);
  assert.equal(f.videoTimingEstimated, true);
  assert.equal(f.videoOffset, 0);
  assert.ok(Math.abs(f.audioOffset - 0.2) < 1e-6);
  assert.equal(f.site.propertyFacts.storeys, null, 'unverified derived storeys never become a fact');
  assert.deepEqual(f.speech.map(s => [s.t, s.isFinal]), [[101.5, false], [104, true]]);
  assert.equal(JSON.stringify(document), before, 'source data is not modified');
});

test('replay uses precise media anchors when present and rejects un-timestamped legacy captures', () => {
  const f = makeReplayFixture({ ...document, media: { videoStartedAt: 99.9, audioStartedAt: 100.2 } }, priors, { videoDuration: 6, audioDuration: 9 });
  assert.equal(f.videoTimingEstimated, false);
  assert.ok(Math.abs(f.videoOffset + 0.1) < 1e-6);
  assert.throws(() => makeReplayFixture({ ...document, rooms: [], inProgress: {} }, priors, {}), /walkPoses/);
});
