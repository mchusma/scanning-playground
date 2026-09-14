import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareReplay } from './prepare-homewalk-replay.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const run = (cmd, argv, options = {}) => execFileSync(cmd, argv, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
console.log('Preparing the local recorded-walk fixture…');
const { out, fixture } = prepareReplay({ capture: option('--capture'), priors: option('--priors'), out: option('--out') });
const deviceName = option('--device') ?? 'HomeWalk iPhone 17';
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
const device = Object.values(devices.devices).flat().find(d => d.name === deviceName || d.udid === deviceName);
if (!device) throw new Error(`Simulator ${deviceName} is unavailable. Choose one with --device <name-or-id>.`);
if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
const buildArgs = ['-project', 'ios/HomeWalk/HomeWalk.xcodeproj', '-scheme', 'HomeWalk', '-configuration', 'Debug', '-destination', `platform=iOS Simulator,id=${device.udid}`];
if (!args.includes('--no-build')) {
  console.log('Building the Simulator app…');
  const log = fs.openSync(path.join(out, 'simulator-build.log'), 'w');
  try { run('xcodebuild', [...buildArgs, 'build'], { stdio: ['ignore', log, log] }); }
  catch { throw new Error(`Simulator build failed. See ${path.join(out, 'simulator-build.log')}`); }
  finally { fs.closeSync(log); }
}
const settings = JSON.parse(run('xcodebuild', [...buildArgs, '-showBuildSettings', '-json'])).find(t => t.target === 'HomeWalk').buildSettings;
const bundle = settings.PRODUCT_BUNDLE_IDENTIFIER;
run('xcrun', ['simctl', 'install', device.udid, path.join(settings.TARGET_BUILD_DIR, settings.FULL_PRODUCT_NAME)]);
const container = run('xcrun', ['simctl', 'get_app_container', device.udid, bundle, 'data']).trim();
const localFixture = path.join(container, 'Documents', 'ReplayFixture');
fs.mkdirSync(localFixture, { recursive: true });
for (const name of ['fixture.json', 'replay.mp4', 'walk-video.mov', 'walk-audio.m4a', 'aerial-overlay.png']) {
  const file = path.join(out, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(localFixture, name));
}
const check = path.join(localFixture, 'last-replay-checks.json');
fs.rmSync(check, { force: true });
console.log('Checking the complete recorded walk through the capture engine…');
run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, bundle, '--replay', localFixture, '--replay-validate']);
const deadline = Date.now() + 30_000;
while (!fs.existsSync(check) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
if (!fs.existsSync(check)) throw new Error('Replay validation did not finish; inspect the Simulator for the error.');
const report = JSON.parse(fs.readFileSync(check, 'utf8'));
fs.copyFileSync(check, path.join(out, 'validation.json'));
if (!report.passed) throw new Error(`Replay validation failed. See ${path.join(out, 'validation.json')}`);
const result = path.join(container, 'Documents', 'HomeWalkCaptures', report.replaySessionID);
fs.cpSync(result, path.join(out, 'result.homewalk'), { recursive: true });
run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, bundle, '--replay', localFixture]);
run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid]);
console.log(`Simulator ready. Confirm the property, then tap Start walk.\n${report.outputPoseCount}/${report.sourcePoseCount} poses preserved; maximum position error ${report.maximumWorldPositionErrorMeters.toExponential(2)} m.\nVideo ends at ${report.videoAvailableUntil.toFixed(1)} s; replay continues to ${report.duration.toFixed(1)} s.\nReport: ${path.join(out, 'validation.json')}\nResult: ${path.join(out, 'result.homewalk')}`);
