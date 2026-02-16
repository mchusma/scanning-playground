# Gemini Live Home Scan Demo

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

`gemini-2.5-flash-native-audio-preview-12-2025`

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
