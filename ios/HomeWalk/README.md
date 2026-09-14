# HomeWalk

HomeWalk is a SwiftUI + ARKit capture app for an iPhone without LiDAR. Confirm the property, then walk and talk continuously. The recording is evidence for post-processing; the app does not segment the home into rooms during the walk. `WalkCaptureView` is the product path. The older corner-tap `CaptureView` and room-boundary geometry remain for existing captures and tests.

## Replay a recorded walk in Simulator

From the repository root:

```bash
npm run simulator:replay
```

This prepares a private fixture from the newest local capture that has video, timestamped poses, and GPS; matches nearby cached property priors; builds and opens **HomeWalk iPhone 17**; and checks the entire replay before presenting it. It requires Xcode, Node, and `ffmpeg`/`ffprobe`. It runs locally with no model or backend calls.

Confirm the cached property, then **Start walk**. The recorded camera and audio play while original ARKit poses feed the current `CaptureSession`. Use play/pause, the scrubber, ±15 seconds, restart, and 1×/4×/16× speed. Seeking backward rebuilds capture state, including speech chips. **Done walking** opens the current capture result; **Replay again** restarts it.

The available whole-home recording has 368 poses over 137.5 seconds. Its video ends at 80.025 seconds: the player becomes black and labels the missing video while the remaining audio and poses continue. Its precise video start anchor was lost, so alignment uses the recorded Start-walk timestamp and may be off by a fraction of a second. Speech chips replay the saved recognition events; the complete audio is played but is not newly transcribed.

The source's final grid rotation is undone when reconstructing world coordinates, then today's capture engine estimates its own grid. Old room/door taps are omitted, matching the capture-only app. This tests capture ingestion, timing, geometry, speech feedback, and navigation. It does not exercise a live ARKit session, camera encoding, or the future LLM room-assembly pipeline.

The map starts from the recorded GPS camera fix and ARKit's compass-aligned frame. It keeps the footprint's real bearing until a measured wall grid is available; a later grid correction rotates both the footprint and its GPS offset about the camera fix. Capture and review maps are north-up, with the capture map marking Start and the phone's facing direction. The provisional whole-walk box never shifts the property to improve containment. GPS accuracy still limits entrance placement: starting at the front door is a useful check, not an exact surveyed doorway coordinate.

Generated media, source hashes, `validation.json`, and `result.homewalk/` live under gitignored `test-output/replay/<source-session-id>/`. Source captures remain unchanged; replay outputs have fresh session IDs and `captureMode: "replay"`.

Useful commands:

```bash
npm run simulator:replay -- --no-build  # relaunch the already-built app
npm run simulator:replay -- --capture <capture-folder> --priors <priors-folder>
npm run replay:prepare                # prepare media/data only
npm run test:replay                   # fixture-conversion tests

# After installing the supplied whole-home fixture on this Simulator:
TEST_RUNNER_HOMEWALK_REPLAY_UI_TEST=1 xcodebuild \
  -project ios/HomeWalk/HomeWalk.xcodeproj -scheme HomeWalk \
  -destination 'platform=iOS Simulator,name=HomeWalk iPhone 17' \
  -parallel-testing-enabled NO -only-testing:HomeWalkUITests/HomeWalkUITests/testRecordedReplayScrubbingAndVideoGap test
```

`ReplayTests` covers deterministic seeking, world-coordinate fidelity, original timestamps, and the pose/speech tail after video ends. The optional real-media UI test checks scrubbing, accelerated playback, gap labeling, and Review; it skips during ordinary UI runs without the private fixture flag.

## Start a capture

1. Complete onboarding and allow camera/microphone access. Allow location for compass-aligned tracking and speech recognition for live prompt feedback.
2. Run `npm run dev` from the repository root on the Mac. Keep the phone and Mac on the same Wi-Fi.
3. On **Your property**, enter the address. Under **Connect to your Mac**, enter the server's LAN address, including port `8787` if needed. The address and host are remembered.
4. Tap **Find property**. Check the aerial, building outline, footprint area and extents, and available listing facts. Unknown fields remain unknown; cached listing facts are unverified. Confirm **Yes, this is my house**.
5. Point the phone at the floor, then **Start walk**. Hold it at chest height, move close to walls, name rooms aloud as you enter, and describe what you show. Finish with **Done walking** after the whole home.

There are no room-naming or Through-a-door controls on the walk screen. The nine prompt chips can be completed only by speech; tapping one displays its hint. When speech recognition is unavailable, keep talking: the audio recording remains the source for post-processing.

The confirmed footprint and property details are stored in `document.site` before capture. `/site?address=...` returns cached priors, looking up the footprint and aerial without model calls if the cache is absent. It does not fetch missing listing facts. `/site/aerial?address=...` serves the cached outline overlay.

## Captured evidence and recovery

- Camera poses, yaw, height, and optional floor hits are sampled roughly three times per second. Geometry uses the camera path, not crosshair intersections with an infinite floor plane. GPS/compass snapshots are recorded once per second in optional `geoSamples`, including original sensor timestamps to identify stale fixes.
- A floor must be 0.7–2.2 m below the camera. With location permission, ARKit uses gravity-and-heading alignment: world +X is east and −Z is north. Plan coordinates are meters: `x = dot(world - origin, xAxis)`, `y = dot(world - origin, zAxis)`.
- Yaw/path evidence aligns the plan grid; Swift and JavaScript geometry share fixture parity tests. The whole walk is stored as one provisional room named **Whole walk — awaiting assembly**. Its bounds describe the walked area, not finished room dimensions.
- ARKit frames are encoded as portrait H.264 in `walk-video.mov`, targeting 15 fps with a bounded queue and ten-second fragments. Audio is saved separately as `walk-audio.m4a`. On-device transcript and captured-item chips remain supporting evidence.
- Media paths and first-frame/audio clock anchors are persisted at recording start, then checkpointed every five seconds. Tracking transitions, AR interruptions, and app state changes are timestamped events.
- **Done walking** waits for queued frames and movie finalization before opening Review. Brief AR interruptions preserve the writer and timeline gaps. Automatic screen locking is disabled during recording. Backgrounding ends and saves the walk because the camera cannot continue there.
- Opening an interrupted capture recovers playable media duration when a stored start anchor exists. Original recordings are preserved. Recovery cannot restore missing frames or invent absent anchors. Review shows recording failures.
- **Start another walk** creates a new capture, preventing recordings in an existing capture from being overwritten.

## Build and test

Open `ios/HomeWalk/HomeWalk.xcodeproj`, select the **HomeWalk** scheme, and choose an iPhone Simulator or device. ARKit is unavailable in Simulator; a draggable meter grid supplies synthetic poses and video has a placeholder file.

From `ios/HomeWalk`:

```bash
xcodebuild -project HomeWalk.xcodeproj -scheme HomeWalk \
  -destination 'platform=iOS Simulator,name=HomeWalk iPhone 17' test

xcodebuild -project HomeWalk.xcodeproj -scheme HomeWalk \
  -destination 'generic/platform=iOS' -configuration Debug build
```

If Simulator cannot launch, boot it with `xcrun simctl boot 'HomeWalk iPhone 17'`. Physical builds require signing and Developer Mode. Do not interrupt a device build while codesigning. Validate camera interruptions, recording duration, speech/audio, and footprint alignment on a physical iPhone.

`FixtureExportTests` regenerates the shared fixture when `TEST_RUNNER_HOMEWALK_FIXTURE_DIR` points at the repository's `test-fixtures` directory. Run `npm test` from the root for web geometry, SVG, relay, and property endpoint checks.

## Review, export, and debug

Review retains 2D/3D editing and tape comparisons for legacy segmented captures. Export shares a `.homewalk` folder with JSON, SVG, checklist, manifest, video, and audio. Drop it on `/homewalk-review.html` or run `node eval-capture.mjs <folder>` on the Mac.

Enable **Debug HUD** under Captures → About this build for Tune, Map, and the optional live link. The live link sends snapshots to the Mac and accepts settings, alignment, and reboxing commands; customer recording does not require streaming. **Check door** is debug-only and only relevant to captures containing doorways. Captures and generated outputs belong under gitignored `test-output/`; never commit private recordings or property addresses.


## Adjust a plan and continue the conversation

From native Review, tap **Adjust plan or ask for changes**. The editor runs through the local Mac server (`npm run dev`), using the remembered server address; Simulator defaults to `localhost:8787`. The browser version is `/homewalk-adjust.html`, also linked from capture review.

Tap a room to rename it, drag a wall, snap nearby rooms together, merge a rectangular pair, or add a divider. Shared walls update both rooms and keep doorways attached. Invalid overlaps, collapsed rooms, and detached doors are rejected. Undo reverses a complete gesture; previous versions and Reset remain available. The simple editor currently requires rectangular room outlines and rectangular merges.

**Assemble rooms from this walk** supplies the recording to the model for timestamped room segments and evidence-backed connections. Geometry remains deterministic camera-path envelopes. All poses, including the unassigned tail, are retained. This is a draft assembly: hallways that turn or revisit different areas can have overlapping bounds. Warnings identify unresolved overlaps and footprint departures; these are not final room measurements.

After assembly, keep chatting or attach photos/videos. A clear correction becomes a preview; an ambiguous attachment prompts a specific question. Follow-up questions preserve the pending preview. **Keep changes** applies a revision; **Discard** leaves the accepted plan untouched. Explicit hypothetical layouts are labelled separately. The model cannot alter raw camera poses or the GPS/footprint anchor. Ordinary chat cannot silently rerun whole-house segmentation over manual edits.

The plan, conversation and supplied media are sent to Gemini only when the user sends a request or requests assembly. The default remains `gemini-3.8-flash` (`POSTWALK_MODEL` overrides it). Revisions, original source, attachments, evidence notes, and token usage persist locally in ignored `test-output/plan-assistant/<sessionID>/`; temporary Gemini Files uploads are deleted after each call. Limits: 12 attachments, 90 MB per file, 180 MB total. There is no dollar-cost estimate yet.

Run `npm run test:assistant` for shared-wall, doorway, segmentation, attachment/conversation, version and stale-edit regression checks. With the local server running, the opt-in native editor test is:

```sh
TEST_RUNNER_HOMEWALK_ASSISTANT_UI_TEST=1 xcodebuild \
  -project ios/HomeWalk/HomeWalk.xcodeproj -scheme HomeWalk \
  -destination 'platform=iOS Simulator,id=1FFBD0E9-F960-4750-A126-B52B4F50C743' \
  -parallel-testing-enabled NO \
  -only-testing:HomeWalkUITests/HomeWalkUITests/testPlanAssistantOpensFromReview test
```

Simulator can open an existing saved capture directly with launch arguments `--review-capture <sessionID>`. Physical-device photo selection, large uploads, and connectivity still need a device check.
