# Gemini Live Home Scan Demo

## HomeWalk native iPhone app

The native capture prototype lives in [`ios/HomeWalk`](ios/HomeWalk). It is a non-LiDAR ARKit (Simulator: meter-grid) walk-and-talk capture app: confirm the property address and footprint, then record the whole home continuously with video, audio, timestamped poses, and GPS/compass evidence. Prompts respond to speech; room segmentation and floor-plan assembly happen after the walk. Export the capture locally for processing.

Replay the previous real walk in Simulator with video, audio, and ARKit movement:

```bash
npm run simulator:replay
```

Confirm the property, tap **Start walk**, then play, pause, scrub, or change speed. Replay preparation and validation are local; see [the replay instructions](ios/HomeWalk/README.md#replay-a-recorded-walk-in-simulator) for media gaps, test coverage, and generated outputs.

Run it in the Simulator from this Mac:

```bash
open ios/HomeWalk/HomeWalk.xcodeproj
```

Choose the **HomeWalk** scheme and an iPhone Simulator, then Run. Full install notes, including remaining steps for a cable-connected iPhone, are in [`ios/HomeWalk/README.md`](ios/HomeWalk/README.md).

Simulator results are not a physical-house capture. ARKit world tracking only runs on a real iPhone. Start the Mac server with `npm run dev`; on the phone’s **Your property** screen, enter its LAN address under **Connect to your Mac**, look up the property, and confirm it before walking. **Done walking** waits for video finalization; backgrounding saves and ends the capture.

### Reviewing a phone capture on this Mac

Export from the app's review screen (share sheet → AirDrop the `.homewalk` folder to this Mac), then either:

```bash
node eval-capture.mjs ~/Downloads/HomeWalk-Walkthrough.homewalk          # table: measured vs tape, snaps, door drift
node eval-capture.mjs ~/Downloads/HomeWalk-Walkthrough.homewalk --svg plan.svg
```

or build the annotated plan from the tape:

```bash
node postwalk.mjs ~/Downloads/HomeWalk-Walkthrough.homewalk        # needs GEMINI_API_KEY, ffmpeg
```

which re-derives the rooms from the stored poses, muxes audio onto the video, and asks `gemini-3.8-flash` to watch the tape alongside the measured plan (with the phone path stamped with video times). Output in `test-output/postwalk/<sessionID>/`: `plan.svg`/`plan.png` with feature pins, openings and zone splits placed from where the phone was at each timestamp, `plan-enriched.json`, `report.md` (rooms, layout assessment, suggested corrections, features, openings, guidebook, inventory, maintenance, transcript), `proxy.mp4`. The model never edits geometry; its proposals are drawn dashed and listed. Drop that folder on the review page to click pins and seek the video.

**Ground it on the real house.** Freestanding homes first:

```bash
node property-priors.mjs "<street address, zip>"                 # writes test-output/reference/<slug>/
node postwalk-site.mjs test-output/postwalk/<sessionID> test-output/reference/<slug>
```

`property-priors` pulls the building footprint from OpenStreetMap (matched by house number; in Orange County it is the county's own building layer), a USGS NAIP aerial with the outline drawn, and the listing/assessor facts (beds, baths, living area, lot, year, storeys, garage, pool, rooms mentioned, any floor-plan URL) via Gemini with Google Search — verify those; grounding metadata is not always returned. `postwalk-site` rotates the footprint to its wall grid, rotates the walked plan to its own grid, and asks the model to pick one of four grid-consistent orientations and a position from cues in the video (patio doors, windows, gate direction, street/pool sides), then sketches the un-walked rooms from the listing's room list as dashed *expected* boxes inside the footprint. Output: `site-plan.png` (footprint + measured rooms + expected rooms), `site-report.md`, `site-fit.json`. The address is only written inside the gitignored output folder.

Or run `npm run dev` and open [the review page](http://localhost:8787/homewalk-review.html) — or watch a walk as it happens on [the live page](http://localhost:8787/homewalk-live.html) with the app's debug link on (see the iOS README) —, drop the folder on it, type tape measurements per room and download the updated `plan.json`. The page plays `walk-video.mov` / `walk-audio.m4a` and seeks to room events. `?sample=1` loads a fixture generated from the iOS model (`test-fixtures/homewalk-sample.homewalk`).

## IMG_2735 floor-plan comparison

Run `npm run dev`, then open [the comparison lab](http://localhost:8787/plan-lab.html).
It compares direct video-to-layout inference, evidence-first inference with rectangle fitting,
and an independent manual frame interpretation. All three have editable 2D layouts,
an isometric extrusion, video evidence links, and SVG/JSON downloads.

Prepare your own narrated video as `test-output/walkthrough-2735/video.mp4`, then run `npm run experiment:2735`. An optional `manual-input.json` in that folder supplies the third comparison.
Private experiment notes, footage, interpretations, and results stay local and are excluded from git.

A realtime walkthrough demo where a user walks through their home, talks naturally, and sees a rough spatial graph update live.

## What it does

- Connects to **Gemini Live API** with a server-minted ephemeral token.
- Streams periodic camera frames from the browser to the model.
- Streams **live microphone audio** (16k PCM) to Gemini and plays back **native model audio** (24k PCM) in realtime.
- Captures input/output transcriptions for live captions and debug visibility.
- Lets the model call mapping tools to:
  - create/update rooms,
  - log traversed room-to-room moves with turn direction (`left/right/straight/back`),
  - connect rooms,
  - place room features,
  - set current user location.
- Renders a dynamic floor graph and profile timeline in real time.
- Includes a debug console (toggleable in UI) with live tool calls, heading updates, and placement decisions.

## Prereqs

- Node.js 20+
- Gemini API key with Live API access

## Run

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env`.
`LIVE_MODEL` defaults to:

`gemini-3.1-flash-live-preview`

3. Start the app:

```bash
npm run dev
```

4. Open:

`http://localhost:8787`

## Notes

- The default model is set via `LIVE_MODEL` and can be changed in UI before starting a session.
- On startup, the app fetches account-supported `bidiGenerateContent` models and auto-selects a recommended **native-audio** model.
- Live sessions run in **audio response mode** (`responseModalities: ['AUDIO']`), with audio input/output transcription enabled.
- If tool calls are sparse in a given turn, the client applies a transcript-based fallback parser to keep room/move mapping progressing.
- This is intentionally a **rough-map** demo, not exact floorplan geometry.
- For best realtime media support, use Chrome-based browsers.

## Quick test checklist

1. Start server: `npm run dev`
2. Open `http://localhost:8787`
3. Click **Start Live Scan** and allow camera + microphone permissions
4. Say: "I'm in the kitchen" then "I'm moving to the hallway"
5. Confirm:
   - You hear model audio replies
   - `Home Profile Build` increments rooms/links/moves
   - `Debug Console` shows non-zero audio chunk counters and tool activity


### HomeWalk plan adjustments

Open `/homewalk-adjust.html` or use **Adjust plan or ask for changes** from iPhone Review. The local server provides shared-wall editing, room assembly drafts, ongoing Gemini conversation, and supplementary photo/video evidence. Model edits are previewed before applying, with version history and Undo. See [the native guide](ios/HomeWalk/README.md#adjust-a-plan-and-continue-the-conversation) for setup, current geometry limits, and tests.
