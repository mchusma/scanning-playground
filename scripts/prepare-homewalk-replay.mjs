import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const probe = file => readProbe(file);
function readProbe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,width,height', '-of', 'json', file], { encoding: 'utf8' }));
}

export function makeReplayFixture(document, priors, media) {
  const poses = [...document.rooms.flatMap(r => r.walkPoses ?? []), ...(document.inProgress?.walkPoses ?? [])]
    .sort((a, b) => a.t - b.t).filter((p, i, all) => !i || p.t !== all[i - 1].t);
  if (!document.floor || !poses.length) throw new Error('Replay needs a confirmed floor and timestamped walkPoses.');
  const start = document.events.find(e => e.type === 'walkStarted')?.timestamp ?? poses[0].t;
  const audioStart = document.media?.audioStartedAt ?? start;
  const videoStart = document.media?.videoStartedAt ?? start;
  const videoOffset = videoStart - start;
  const audioOffset = audioStart - start;
  const end = Math.max(poses.at(-1).t, ...document.rooms.map(r => r.walkEndedAt ?? start), audioStart + media.audioDuration, videoStart + media.videoDuration);
  const fp = priors.footprint;
  if (!fp) throw new Error('Property priors need a footprint.');
  const facts = priors.facts ?? {};
  const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const speech = [
    ...(document.capturedItems ?? []).map(i => ({ t: i.timestamp, startedAt: i.timestamp, text: i.transcript, isFinal: false })),
    ...(document.transcript ?? []).map(t => ({ t: t.endedAt, startedAt: t.startedAt, text: t.text, isFinal: true })),
  ].filter(e => e.text?.trim()).sort((a, b) => a.t - b.t);
  return {
    schemaVersion: 1, sourceSessionID: document.sessionID, title: 'Recorded home walk',
    startUnix: start, duration: end - start, videoDuration: media.videoDuration, audioDuration: media.audioDuration,
    videoOffset, audioOffset,
    videoTimingEstimated: document.media?.videoStartedAt == null,
    timingNote: document.media?.videoStartedAt == null
      ? 'The source video has no precise start anchor. Video is aligned to Start walk; sub-second A/V alignment is approximate.'
      : 'Audio and video use the source capture clock anchors.',
    sourceFloor: document.floor, sourceGeo: document.geo ?? null, poses, speech,
    site: {
      address: priors.address, footprintEastNorth: fp.polygonEastNorthM.map(p => ({ x: p.east, y: p.north })),
      centroidLatitude: fp.centroid.lat, centroidLongitude: fp.centroid.lon,
      wallBearingDegrees: fp.dominantWallBearingDeg, areaSquareMeters: fp.areaM2, source: fp.source,
      widthEastWestMeters: fp.bboxEastWestM, depthNorthSouthMeters: fp.bboxNorthSouthM,
      aerialPath: 'aerial-overlay.png',
      propertyFacts: {
        bedrooms: numeric(facts.bedrooms), bathrooms: numeric(facts.bathrooms), livingAreaSqFt: numeric(facts.livingAreaSqFt),
        storeys: numeric(facts.storeys), propertyType: facts.propertyType ?? null,
        roomsMentioned: facts.roomsMentioned ?? [], verified: false,
      },
    },
  };
}

export function prepareReplay({ capture, priors, out } = {}) {
  if (!capture) {
    const root = path.join(repo, 'test-output/captures');
    const candidates = fs.readdirSync(root).map(name => path.join(root, name)).filter(dir => {
      try { const d = read(path.join(dir, 'plan.json')); return d.geo && d.rooms.some(r => r.walkPoses?.length) && fs.existsSync(path.join(dir, 'walk-video.mov')); } catch { return false; }
    }).sort((a, b) => read(path.join(b, 'plan.json')).createdAt - read(path.join(a, 'plan.json')).createdAt);
    capture = candidates[0];
  }
  if (!capture) throw new Error('No capture with video, GPS, and timestamped poses found. Pass --capture <folder>.');
  capture = path.resolve(capture);
  const source = read(path.join(capture, 'plan.json'));
  if (!priors) {
    const root = path.join(repo, 'test-output/reference');
    const candidates = fs.readdirSync(root).map(name => path.join(root, name)).flatMap(dir => {
      try {
        const p = read(path.join(dir, 'priors.json'));
        const c = p.footprint.centroid;
        const distance = Math.hypot((c.lat - source.geo.latitude) * 111320, (c.lon - source.geo.longitude) * 111320 * Math.cos(c.lat * Math.PI / 180));
        return [{ dir, distance }];
      } catch { return []; }
    }).sort((a, b) => a.distance - b.distance);
    if (candidates[0]?.distance < 200) priors = candidates[0].dir;
  }
  if (!priors) throw new Error('No matching cached property found. Pass --priors <folder>.');
  priors = path.resolve(priors);
  out = path.resolve(out ?? path.join(repo, 'test-output/replay', source.sessionID));
  // Preparation writes only a dedicated derived folder, never the input capture.
  for (const input of [capture, priors]) {
    if (out === input || input.startsWith(out + path.sep) || out.startsWith(input + path.sep)) throw new Error('Replay output must be separate from captures and priors.');
  }
  fs.mkdirSync(out, { recursive: true });
  const video = path.join(capture, 'walk-video.mov');
  const audio = path.join(capture, 'walk-audio.m4a');
  const videoDuration = Number(probe(video).format.duration), audioDuration = Number(probe(audio).format.duration);
  const fixture = makeReplayFixture(source, read(path.join(priors, 'priors.json')), { videoDuration, audioDuration });
  fixture.sourceHashes = { plan: hash(path.join(capture, 'plan.json')), video: hash(video), audio: hash(audio) };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...fixture, proxyVersion: 1 })).digest('hex');
  const marker = path.join(out, '.proxy-fingerprint');
  const proxy = path.join(out, 'replay.mp4');
  if (!fs.existsSync(proxy) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== fingerprint) {
    const videoDelay = Math.max(0, fixture.videoOffset), audioDelay = Math.max(0, fixture.audioOffset);
    const filter = `[0:v]trim=start=${Math.max(0, -fixture.videoOffset)},setpts=PTS-STARTPTS,scale=720:-2,fps=10,tpad=start_duration=${videoDelay}:stop_mode=add:stop_duration=${fixture.duration}:color=black,trim=duration=${fixture.duration}[v];[1:a]atrim=start=${Math.max(0, -fixture.audioOffset)},asetpts=PTS-STARTPTS,adelay=${Math.round(audioDelay * 1000)}:all=1,apad,atrim=duration=${fixture.duration}[a]`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', audio, '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', proxy], { stdio: 'inherit' });
    fs.writeFileSync(marker, fingerprint);
  }
  fs.copyFileSync(video, path.join(out, 'walk-video.mov'));
  fs.copyFileSync(audio, path.join(out, 'walk-audio.m4a'));
  const aerial = path.join(priors, 'aerial-overlay.png');
  if (fs.existsSync(aerial)) fs.copyFileSync(aerial, path.join(out, 'aerial-overlay.png'));
  else fixture.site.aerialPath = null;
  fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'README.md'), `# Local recorded-capture replay\n\nSource: ${source.sessionID}. ${fixture.poses.length} real ARKit poses; ${(fixture.duration).toFixed(2)} seconds. Video exists for ${videoDuration.toFixed(2)} seconds; the proxy is black afterwards while recorded audio and poses continue.\n\n${fixture.timingNote}\n\nSpeech feedback replays ${fixture.speech.length} saved recognition events. The audio has not been re-transcribed. Original room taps are ignored by the continuous-capture replay. Cached property facts remain unverified.\n\nPrivate media: keep this folder out of Git. Original capture files are unchanged; hashes are in fixture.json.\n`);
  return { out, fixture };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { out, fixture } = prepareReplay({ capture: option('--capture'), priors: option('--priors'), out: option('--out') });
  console.log(`Replay ready: ${out}\n${fixture.poses.length} poses, ${fixture.duration.toFixed(1)} s; video ends at ${(fixture.videoOffset + fixture.videoDuration).toFixed(1)} s.`);
}
