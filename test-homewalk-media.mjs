import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audioInputOffset, audioInputTimingArguments } from './homewalk-media.mjs';

test('audio input shares the video clock for missing and separate anchors', () => {
  assert.equal(audioInputOffset({}), 0);
  assert.equal(audioInputOffset({ videoStartedAt: 100 }), 0);
  assert.equal(audioInputOffset({ videoStartedAt: 100, audioStartedAt: 101 }), 1);
  assert.equal(audioInputOffset({ videoStartedAt: 100, audioStartedAt: 99 }), -1);
});

test('real mux inserts silence for a late mic and trims audio recorded before video', t => {
  if (spawnSync('ffmpeg', ['-version']).error) return t.skip('ffmpeg is required for the media integration check');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homewalk-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const offset of [0.35, -0.35]) {
    const out = path.join(dir, `${offset}.mkv`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:d=2:r=10',
      ...audioInputTimingArguments({ videoStartedAt: 100, audioStartedAt: 100 + offset }),
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-map', '0:v', '-map', '1:a',
      '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-avoid_negative_ts', 'disabled', out]);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:a', '-af', 'aresample=8000:async=1:first_pts=0', '-ac', '1', '-f', 's16le', '-']);
    let first = -1;
    for (let i = 0; i < pcm.length / 2; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > 100) { first = i / 8000; break; }
    assert.ok(Math.abs(first - Math.max(0, offset)) < 0.015, `first audio at ${first}, expected ${Math.max(0, offset)}`);
    assert.ok(Math.abs(pcm.length / 16000 - (1 + offset)) < 0.02, `audio lasts ${pcm.length / 16000}s with offset ${offset}, expected ${1 + offset}s`);
  }
});
