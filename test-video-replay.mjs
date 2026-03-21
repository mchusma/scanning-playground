/**
 * Video Replay Test for Floor Plan Scanner
 *
 * Downloads a home walkthrough video (or uses a local file), extracts frames,
 * and replays them through the Gemini Live API to test end-to-end floor plan
 * generation.
 *
 * Usage:
 *   node test-video-replay.mjs [video-url-or-path]
 *
 * Prerequisites:
 *   - ffmpeg installed (brew install ffmpeg)
 *   - GEMINI_API_KEY in .env or environment
 *
 * If no video argument is given, it will use a sample from Pexels.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { GoogleGenAI, Modality } from '@google/genai';
import { generateFloorPlanSVG, diagnoseHomeState } from './public/svg-export.js';

// ── Config ──────────────────────────────────────────────────────────────
const FRAME_DIR = path.join(__dirname, 'test-video-frames');
const OUTPUT_DIR = path.join(__dirname, 'test-output');
const FRAME_INTERVAL_SEC = 2.5; // Match app's FRAME_SEND_INTERVAL_MS
const FRAME_SEND_DELAY_MS = 2500;
const MAX_FRAMES = 60; // Cap at ~2.5 min of video
const FRAME_WIDTH = 512;
const JPEG_QUALITY = 8; // ffmpeg quality scale (2=best, 31=worst), ~60% quality

// Same system prompt and tools as app.js
// Modified system prompt for video-only replay (no live audio conversation)
const LIVE_SYSTEM_PROMPT = `
You are ScanPilot, a home-mapping AI that analyzes video frames from a home walkthrough.

IMPORTANT: The user is sending you video frames from a pre-recorded home tour. They cannot hear or respond to your questions. You must analyze the video frames yourself and map what you see.

Your job:
1) Look at each video frame carefully and identify what room you're in.
2) When you see a new room, call upsert_room with the room type and name.
3) When the video moves from one room to another, call move_between_rooms.
4) When you see features (appliances, furniture, fixtures), call place_feature.
5) Keep track of your current location with set_user_location.
6) Use connect_rooms when you can see into adjacent rooms.

Rules:
- DO NOT ask questions or wait for responses. The user cannot respond.
- Proactively identify rooms from the video frames.
- Call tools immediately when you identify a room or transition.
- Use your best judgment about room types based on what you see.
- Keep responses very brief (1 sentence max).
- Every frame should trigger at least one tool call.
- Common room types: kitchen, bedroom, bathroom, living room, dining room, hallway, entryway, office, closet, laundry room.
`;

const TOOL_DECLARATIONS = [
  {
    name: 'upsert_room',
    description: 'Create or update a room in the rough home map.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Room name' },
        roomType: { type: 'string', description: 'Category: kitchen, bedroom, bathroom, hallway, etc.' },
        notes: { type: 'string', description: 'Short description' },
        confidence: { type: 'number', description: '0 to 1' },
      },
      required: ['name'],
    },
  },
  {
    name: 'move_between_rooms',
    description: 'Record a traversed move from one room to another.',
    parameters: {
      type: 'object',
      properties: {
        fromRoom: { type: 'string' },
        toRoom: { type: 'string' },
        moveType: { type: 'string', description: 'straight, left, right, back, unknown' },
        directionHint: { type: 'string', description: 'north, east, south, west' },
        pathType: { type: 'string', description: 'doorway, archway, hallway, stairs, open-plan' },
      },
      required: ['fromRoom', 'toRoom'],
    },
  },
  {
    name: 'connect_rooms',
    description: 'Add a walkable relationship between two rooms.',
    parameters: {
      type: 'object',
      properties: {
        fromRoom: { type: 'string' },
        toRoom: { type: 'string' },
        pathType: { type: 'string' },
      },
      required: ['fromRoom', 'toRoom'],
    },
  },
  {
    name: 'set_user_location',
    description: 'Set the room where the user is currently standing.',
    parameters: {
      type: 'object',
      properties: { room: { type: 'string' } },
      required: ['room'],
    },
  },
  {
    name: 'place_feature',
    description: 'Attach a feature or fixture to a room.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        feature: { type: 'string' },
        positionHint: { type: 'string' },
      },
      required: ['room', 'feature'],
    },
  },
  {
    name: 'log_scan_event',
    description: 'Record a notable mapping milestone.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['summary'],
    },
  },
];

// ── Home state management (simplified from app.js) ──────────────────────

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

class HomeState {
  constructor() {
    this.rooms = new Map();
    this.edges = [];
    this.locationRoomId = null;
    this.heading = 'north';
    this.transitionCount = 0;
    this.toolCalls = [];
    this.events = [];
  }

  upsertRoom({ name, roomType, notes, confidence }) {
    const normalizedName = (name || '').trim();
    if (!normalizedName) return null;

    const id = slugify(normalizedName);
    let room = this.rooms.get(id);

    if (!room) {
      // Position rooms in a grid layout for simplicity
      const idx = this.rooms.size;
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      room = {
        id,
        name: normalizedName,
        roomType: roomType || 'room',
        notes: notes || '',
        confidence: typeof confidence === 'number' ? confidence : 0.6,
        features: [],
        x: 200 + col * 180,
        y: 200 + row * 140,
      };
      this.rooms.set(id, room);
      this.events.push(`Mapped room: ${room.name}`);
    } else {
      room.roomType = roomType || room.roomType;
      room.notes = notes || room.notes;
      if (typeof confidence === 'number') {
        room.confidence = Math.max(0.1, Math.min(1, confidence));
      }
    }
    return room;
  }

  upsertEdge({ fromRoom, toRoom, pathType, anchorFromId, anchorDirection }) {
    const from = this.upsertRoom({ name: fromRoom });
    const to = this.upsertRoom({ name: toRoom });
    if (!from || !to || from.id === to.id) return null;

    const key = [from.id, to.id].sort().join('::');
    const existing = this.edges.find(e => e.key === key);
    if (existing) {
      existing.pathType = pathType || existing.pathType;
      if (anchorFromId) existing.anchorFromId = anchorFromId;
      if (anchorDirection) existing.anchorDirection = anchorDirection;
      return existing;
    }

    const edge = {
      key,
      fromId: from.id,
      toId: to.id,
      pathType: pathType || 'path',
      anchorFromId: anchorFromId || null,
      anchorDirection: anchorDirection || null,
      updatedAt: Date.now(),
    };
    this.edges.push(edge);
    this.events.push(`Linked ${from.name} → ${to.name}`);
    return edge;
  }

  handleToolCall(name, args) {
    this.toolCalls.push({ name, args, at: Date.now() });

    switch (name) {
      case 'upsert_room':
        return this.upsertRoom(args);

      case 'move_between_rooms': {
        const from = this.upsertRoom({ name: args.fromRoom });
        const to = this.upsertRoom({ name: args.toRoom });
        if (!from || !to || from.id === to.id) return null;

        this.upsertEdge({
          fromRoom: args.fromRoom,
          toRoom: args.toRoom,
          pathType: args.pathType || 'doorway',
          anchorFromId: from.id,
          anchorDirection: args.directionHint || null,
        });

        this.locationRoomId = to.id;
        this.transitionCount++;
        this.events.push(`Moved: ${from.name} → ${to.name}`);
        return { from: from.name, to: to.name };
      }

      case 'connect_rooms':
        return this.upsertEdge({
          fromRoom: args.fromRoom,
          toRoom: args.toRoom,
          pathType: args.pathType,
        });

      case 'set_user_location': {
        const room = this.upsertRoom({ name: args.room });
        if (room) {
          this.locationRoomId = room.id;
          this.events.push(`Location set: ${room.name}`);
        }
        return room;
      }

      case 'place_feature': {
        const room = this.upsertRoom({ name: args.room });
        if (room && args.feature) {
          const label = args.positionHint ? `${args.feature} (${args.positionHint})` : args.feature;
          if (!room.features.includes(label)) {
            room.features.push(label);
            room.features = room.features.slice(-5);
          }
          this.events.push(`Feature: ${label} in ${room.name}`);
        }
        return room;
      }

      case 'log_scan_event':
        this.events.push(`Event: ${args.summary}`);
        return { ok: true };

      default:
        return null;
    }
  }
}

// ── Video frame extraction ──────────────────────────────────────────────

function downloadVideo(urlOrPath) {
  const videoPath = path.join(__dirname, 'test-video-input.mp4');

  if (existsSync(urlOrPath)) {
    const resolvedInput = path.resolve(urlOrPath);
    const resolvedTarget = path.resolve(videoPath);
    console.log(`Using local video: ${resolvedInput}`);
    if (resolvedInput !== resolvedTarget) {
      execSync(`cp "${resolvedInput}" "${resolvedTarget}"`);
    }
    return resolvedTarget;
  }

  console.log(`Downloading video from: ${urlOrPath}`);
  try {
    execSync(`curl -L -o "${videoPath}" "${urlOrPath}"`, {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch (err) {
    console.error('Failed to download video. You can manually place a video file at:');
    console.error(`  ${videoPath}`);
    console.error('Or provide a direct download URL as an argument.');
    process.exit(1);
  }
  return videoPath;
}

function extractFrames(videoPath) {
  mkdirSync(FRAME_DIR, { recursive: true });

  // Clean old frames
  for (const f of readdirSync(FRAME_DIR)) {
    if (f.endsWith('.jpg')) unlinkSync(path.join(FRAME_DIR, f));
  }

  console.log(`Extracting frames every ${FRAME_INTERVAL_SEC}s at ${FRAME_WIDTH}px width...`);

  const cmd = [
    'ffmpeg', '-y', '-i', `"${videoPath}"`,
    '-vf', `fps=1/${FRAME_INTERVAL_SEC},scale=${FRAME_WIDTH}:-1`,
    '-q:v', String(JPEG_QUALITY),
    '-frames:v', String(MAX_FRAMES),
    `"${path.join(FRAME_DIR, 'frame_%04d.jpg')}"`,
  ].join(' ');

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 60000 });
  } catch (err) {
    console.error('ffmpeg failed:', err.stderr?.toString() || err.message);
    process.exit(1);
  }

  const frames = readdirSync(FRAME_DIR)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(FRAME_DIR, f));

  console.log(`Extracted ${frames.length} frames`);
  return frames;
}

function loadFrameAsBase64(framePath) {
  const buffer = readFileSync(framePath);
  return buffer.toString('base64');
}

// ── Gemini Live session ─────────────────────────────────────────────────

async function runReplay(frames) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set. Add it to .env or environment.');
    process.exit(1);
  }

  // Only native-audio models support Live/bidi — use AUDIO modality and capture transcripts
  const model = process.env.REPLAY_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
  const homeState = new HomeState();
  const transcripts = [];

  console.log(`\nConnecting to Gemini Live (model: ${model})...`);

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });

  // Track session state
  let sessionReady = false;
  let frameIndex = 0;
  let frameSendTimer = null;
  let resolveSession;
  const sessionDone = new Promise(r => { resolveSession = r; });

  const session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      systemInstruction: LIVE_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    },
    callbacks: {
      onopen() {
        console.log('Session opened');
        sessionReady = true;
      },

      onmessage(msg) {
        // Handle tool calls
        if (msg.toolCall) {
          const results = [];
          for (const fc of msg.toolCall.functionCalls || []) {
            console.log(`  Tool: ${fc.name}(${JSON.stringify(fc.args)})`);
            const result = homeState.handleToolCall(fc.name, fc.args || {});
            results.push({
              id: fc.id,
              name: fc.name,
              response: result || { ok: true },
            });
          }
          // Send tool responses back
          session.sendToolResponse({ functionResponses: results });
        }

        // Handle text responses (model thinking — suppress verbose output)
        if (msg.serverContent?.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.text) {
              transcripts.push(part.text);
            }
            // Audio data is ignored (we only care about tool calls + transcripts)
          }
        }

        // Handle output audio transcription (spoken words)
        if (msg.serverContent?.outputTranscription?.text) {
          const text = msg.serverContent.outputTranscription.text.trim();
          if (text) {
            transcripts.push(text);
          }
        }

        // Check for turn completion
        if (msg.serverContent?.turnComplete) {
          // Send next frame after a short delay
          if (frameIndex < frames.length) {
            frameSendTimer = setTimeout(() => sendNextFrame(), 1000);
          } else {
            // All frames sent, wait a bit for final responses
            setTimeout(() => {
              session.close();
            }, 3000);
          }
        }
      },

      onerror(err) {
        console.error('Session error:', err.message || err);
      },

      onclose() {
        console.log('Session closed');
        if (frameSendTimer) clearTimeout(frameSendTimer);
        resolveSession();
      },
    },
  });

  function sendNextFrame() {
    if (frameIndex >= frames.length) return;

    const framePath = frames[frameIndex];
    const base64 = loadFrameAsBase64(framePath);
    const frameNum = frameIndex + 1;
    const timestamp = (frameIndex * FRAME_INTERVAL_SEC).toFixed(1);

    console.log(`\n[Frame ${frameNum}/${frames.length} @ ${timestamp}s] ${path.basename(framePath)}`);

    session.sendRealtimeInput({
      video: { mimeType: 'image/jpeg', data: base64 },
    });

    frameIndex++;

    // Send a text prompt with each frame to drive tool usage
    let prompt;
    if (frameIndex === 1) {
      prompt = "This is a video walkthrough of a home. Look at this first frame. Identify what room this is and call upsert_room and set_user_location. Describe any features you see and call place_feature for each.";
    } else if (frameIndex % 4 === 0) {
      prompt = "Look at this frame. Have we moved to a different room? If so, call move_between_rooms. What features do you see? Call place_feature for any new ones.";
    } else {
      prompt = "Next frame. Identify the room and any new features. Use tools to update the map.";
    }

    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: prompt }] }],
      turnComplete: true,
    });
  }

  // Wait for session to be ready, then start sending frames
  await new Promise(r => {
    const check = () => {
      if (sessionReady) r();
      else setTimeout(check, 100);
    };
    check();
  });

  // Send initial greeting
  console.log('\nStarting frame replay...\n');
  sendNextFrame();

  // Wait for session to complete
  await sessionDone;

  return { homeState, transcripts };
}

// ── Output generation ───────────────────────────────────────────────────

function generateOutputs(homeState, transcripts) {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Generate SVG
  const svg = generateFloorPlanSVG(homeState, {
    debug: true,
    animate: true,
    title: 'Video Replay Floor Plan',
  });

  const svgPath = path.join(OUTPUT_DIR, 'video-replay-floorplan.svg');
  writeFileSync(svgPath, svg);
  console.log(`\nSVG floor plan: ${svgPath}`);

  // Diagnostics
  const diag = diagnoseHomeState(homeState);
  console.log(`\nDiagnostics:`);
  console.log(`  Rooms: ${diag.roomCount}`);
  console.log(`  Edges: ${diag.edgeCount}`);
  console.log(`  Connected: ${diag.connectedRooms}`);
  console.log(`  Isolated: ${diag.isolatedRooms}`);
  console.log(`  OK: ${diag.ok}`);
  if (diag.issues.length > 0) {
    for (const issue of diag.issues) {
      console.log(`  [${issue.level}] ${issue.msg}`);
    }
  }

  // Save full report
  const report = {
    timestamp: new Date().toISOString(),
    rooms: [...homeState.rooms.values()].map(r => ({
      id: r.id,
      name: r.name,
      roomType: r.roomType,
      confidence: r.confidence,
      features: r.features,
    })),
    edges: homeState.edges.map(e => ({
      key: e.key,
      fromId: e.fromId,
      toId: e.toId,
      pathType: e.pathType,
    })),
    toolCalls: homeState.toolCalls,
    events: homeState.events,
    transcripts,
    diagnostics: diag,
  };

  const reportPath = path.join(OUTPUT_DIR, 'video-replay-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Replay complete!`);
  console.log(`  Total tool calls: ${homeState.toolCalls.length}`);
  console.log(`  Rooms discovered: ${homeState.rooms.size}`);
  console.log(`  Connections: ${homeState.edges.length}`);
  console.log(`  Events: ${homeState.events.length}`);
  console.log(`${'─'.repeat(50)}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];

  // Check for existing frames first
  if (!arg && existsSync(FRAME_DIR)) {
    const existing = readdirSync(FRAME_DIR).filter(f => f.endsWith('.jpg')).sort();
    if (existing.length > 0) {
      console.log(`Found ${existing.length} existing frames in ${FRAME_DIR}`);
      const frames = existing.map(f => path.join(FRAME_DIR, f));
      const { homeState, transcripts } = await runReplay(frames);
      generateOutputs(homeState, transcripts);
      return;
    }
  }

  // Need a video source
  if (!arg) {
    console.log(`
Video Replay Test for Floor Plan Scanner
=========================================

Usage:
  node test-video-replay.mjs <video-file-or-url>

Examples:
  # Use a local video file
  node test-video-replay.mjs ~/Downloads/house-tour.mp4

  # Download from Pexels (find a video, right-click download link)
  node test-video-replay.mjs "https://www.pexels.com/download/video/7578552/"

  # Use pre-extracted frames (place .jpg files in test-video-frames/)
  mkdir -p test-video-frames
  ffmpeg -i video.mp4 -vf "fps=0.4,scale=512:-1" -q:v 8 test-video-frames/frame_%04d.jpg
  node test-video-replay.mjs

Prerequisites:
  - ffmpeg installed (brew install ffmpeg)
  - GEMINI_API_KEY in .env file

Tip: Search pexels.com/search/videos/house+tour/ for free walkthrough videos.
    `);
    process.exit(0);
  }

  // Download/copy video
  const videoPath = downloadVideo(arg);

  // Extract frames
  const frames = extractFrames(videoPath);
  if (frames.length === 0) {
    console.error('No frames extracted. Check the video file.');
    process.exit(1);
  }

  // Run replay
  const { homeState, transcripts } = await runReplay(frames);
  generateOutputs(homeState, transcripts);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
