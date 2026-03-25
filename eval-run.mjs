#!/usr/bin/env node
/**
 * Evaluation Runner
 *
 * Runs the video replay pipeline against multiple test videos,
 * scores each against ground truth, and produces a summary report.
 *
 * Usage:
 *   node eval-run.mjs                    # Run all test videos
 *   node eval-run.mjs 01-studio          # Run a specific test
 *   node eval-run.mjs --score-only       # Score existing results without re-running
 *   node eval-run.mjs --list             # List available test videos
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
import { scoreResult, formatScoreReport } from './eval-score.mjs';

// ── Config ──────────────────────────────────────────────────────────────
const VIDEOS_DIR = path.join(__dirname, 'test-videos');
const GROUND_TRUTH_DIR = path.join(VIDEOS_DIR, 'ground-truth');
const OUTPUT_DIR = path.join(__dirname, 'test-output', 'eval');
const FRAME_INTERVAL_SEC = 3; // Faster to catch more rooms in longer walkthroughs
const MAX_FRAMES = 80;
const FRAME_WIDTH = 512;
const JPEG_QUALITY = 8;

const LIVE_SYSTEM_PROMPT = `
You are ScanPilot, a home-mapping AI that builds floor plans from video walkthroughs.

YOUR #1 GOAL: Discover and map EVERY room in the home. Room count is the most important metric.

RULES:
1. Use ONLY tool calls. Never speak or describe — just call tools.
2. Every frame MUST produce at least one tool call.
3. Prioritize discovering NEW rooms over re-describing rooms you already mapped.
4. When the camera moves through a doorway, archway, or opening — IMMEDIATELY call move_between_rooms.
5. Number duplicate room types: "Bedroom 1", "Bedroom 2", "Bathroom 1", "Bathroom 2", etc.
6. Look for rooms visible through doorways/openings — call connect_rooms even for rooms you haven't entered yet.

TOOL PRIORITY (most to least important):
1. upsert_room — Create rooms. Name every distinct space. Include hallways, closets, pantries, laundry rooms, balconies, stairs.
2. move_between_rooms — Record transitions. ALWAYS include pathType (doorway, archway, hallway, stairs, open-plan).
3. connect_rooms — Link rooms you can see but haven't walked between.
4. place_feature — Log visible furniture, appliances, fixtures (sink, refrigerator, oven, toilet, shower, bed, sofa, TV, washer, dryer, fireplace).
5. set_user_location — Update your current position.

Room types: kitchen, bedroom, bathroom, living room, dining room, hallway, entryway, office, closet, laundry room, garage, outdoor, studio, pantry, stairs, balcony.

REMEMBER: Your score depends on finding ALL rooms. A 3-bed home should have 3 bedrooms. Missing a room is worse than a false positive.
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
];

// ── Helpers (from test-video-replay.mjs) ─────────────────────────────────

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Room sizes by type (width, height in SVG coordinate space)
const ROOM_SIZES = {
  'living room': { w: 180, h: 120 },
  'family room': { w: 180, h: 120 },
  'kitchen': { w: 160, h: 110 },
  'dining room': { w: 150, h: 100 },
  'bedroom': { w: 150, h: 110 },
  'primary bedroom': { w: 170, h: 120 },
  'office': { w: 130, h: 100 },
  'bathroom': { w: 100, h: 80 },
  'closet': { w: 80, h: 70 },
  'hallway': { w: 120, h: 60 },
  'entryway': { w: 110, h: 80 },
  'garage': { w: 180, h: 130 },
  'laundry room': { w: 100, h: 80 },
  'pantry': { w: 80, h: 70 },
  'stairs': { w: 80, h: 100 },
  'outdoor': { w: 160, h: 100 },
  'balcony': { w: 140, h: 70 },
  'studio': { w: 200, h: 140 },
};
const DEFAULT_ROOM_SIZE = { w: 140, h: 90 };

function getRoomSize(roomType) {
  if (!roomType) return DEFAULT_ROOM_SIZE;
  return ROOM_SIZES[roomType.toLowerCase().trim()] || DEFAULT_ROOM_SIZE;
}

// Direction vectors for room placement
const DIRECTION_VECTORS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  straight: { dx: 0, dy: -1 },
  back: { dx: 0, dy: 1 },
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
};

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

  // Check if a position would overlap with an existing room
  _hasCollision(x, y, w, h, excludeId) {
    for (const [id, room] of this.rooms) {
      if (id === excludeId) continue;
      const rs = getRoomSize(room.roomType);
      const overlapX = Math.abs(room.x - x) < (rs.w + w) / 2 + 10;
      const overlapY = Math.abs(room.y - y) < (rs.h + h) / 2 + 10;
      if (overlapX && overlapY) return true;
    }
    return false;
  }

  // Find a non-overlapping position near the target
  _findFreePosition(targetX, targetY, w, h, excludeId) {
    if (!this._hasCollision(targetX, targetY, w, h, excludeId)) {
      return { x: targetX, y: targetY };
    }
    // Try spiral outward
    const offsets = [
      { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 },
      { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 },
    ];
    for (let dist = 1; dist <= 3; dist++) {
      for (const off of offsets) {
        const nx = targetX + off.dx * (w + 20) * dist;
        const ny = targetY + off.dy * (h + 20) * dist;
        if (!this._hasCollision(nx, ny, w, h, excludeId)) {
          return { x: nx, y: ny };
        }
      }
    }
    // Give up and place it anyway
    return { x: targetX + (w + 20), y: targetY };
  }

  upsertRoom({ name, roomType, notes, confidence }) {
    const normalizedName = (name || '').trim();
    if (!normalizedName) return null;
    const id = slugify(normalizedName);
    let room = this.rooms.get(id);
    if (!room) {
      const size = getRoomSize(roomType);
      // Default position — will be updated when connections are made
      const idx = this.rooms.size;
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      const defaultX = 300 + col * 200;
      const defaultY = 300 + row * 160;
      const pos = this._findFreePosition(defaultX, defaultY, size.w, size.h, null);
      room = {
        id, name: normalizedName,
        roomType: roomType || 'room',
        notes: notes || '',
        confidence: typeof confidence === 'number' ? confidence : 0.6,
        features: [],
        x: pos.x, y: pos.y,
        w: size.w, h: size.h,
        positionSource: 'grid',
      };
      this.rooms.set(id, room);
      this.events.push(`Mapped room: ${room.name}`);
    } else {
      room.roomType = roomType || room.roomType;
      room.notes = notes || room.notes;
      if (typeof confidence === 'number') room.confidence = Math.max(0.1, Math.min(1, confidence));
      // Update size if roomType changed
      const size = getRoomSize(room.roomType);
      room.w = size.w;
      room.h = size.h;
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
      return existing;
    }
    const edge = {
      key, fromId: from.id, toId: to.id,
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
      case 'upsert_room': return this.upsertRoom(args);
      case 'move_between_rooms': {
        const from = this.upsertRoom({ name: args.fromRoom });
        const to = this.upsertRoom({ name: args.toRoom });
        if (!from || !to || from.id === to.id) return null;
        // Directional placement: position "to" room based on direction from "from" room
        const dir = args.directionHint || args.moveType || 'east';
        const vec = DIRECTION_VECTORS[dir] || DIRECTION_VECTORS.east;
        if (to.positionSource === 'grid') {
          // Place relative to "from" room
          const gap = 30;
          const targetX = from.x + vec.dx * (from.w / 2 + to.w / 2 + gap);
          const targetY = from.y + vec.dy * (from.h / 2 + to.h / 2 + gap);
          const pos = this._findFreePosition(targetX, targetY, to.w, to.h, to.id);
          to.x = pos.x;
          to.y = pos.y;
          to.positionSource = 'directional';
        }
        this.upsertEdge({
          fromRoom: args.fromRoom, toRoom: args.toRoom,
          pathType: args.pathType || 'doorway',
          anchorFromId: from.id, anchorDirection: args.directionHint || null,
        });
        this.locationRoomId = to.id;
        this.transitionCount++;
        this.events.push(`Moved: ${from.name} → ${to.name}`);
        return { from: from.name, to: to.name };
      }
      case 'connect_rooms':
        return this.upsertEdge({ fromRoom: args.fromRoom, toRoom: args.toRoom, pathType: args.pathType });
      case 'set_user_location': {
        const room = this.upsertRoom({ name: args.room });
        if (room) { this.locationRoomId = room.id; this.events.push(`Location set: ${room.name}`); }
        return room;
      }
      case 'place_feature': {
        const room = this.upsertRoom({ name: args.room });
        if (room && args.feature) {
          const label = args.positionHint ? `${args.feature} (${args.positionHint})` : args.feature;
          if (!room.features.includes(label)) { room.features.push(label); room.features = room.features.slice(-15); }
          this.events.push(`Feature: ${label} in ${room.name}`);
        }
        return room;
      }
      default:
        // Gracefully handle any unknown tool calls (e.g. log_scan_event)
        if (args.summary) this.events.push(`Event: ${args.summary}`);
        return { ok: true };
    }
  }
}

// ── Frame extraction ─────────────────────────────────────────────────────

function extractFrames(videoPath, frameDir) {
  mkdirSync(frameDir, { recursive: true });
  // Clean old frames
  for (const f of readdirSync(frameDir)) {
    if (f.endsWith('.jpg')) unlinkSync(path.join(frameDir, f));
  }

  const cmd = [
    'ffmpeg', '-y', '-i', `"${videoPath}"`,
    '-vf', `fps=1/${FRAME_INTERVAL_SEC},scale=${FRAME_WIDTH}:-1`,
    '-q:v', String(JPEG_QUALITY),
    '-frames:v', String(MAX_FRAMES),
    `"${path.join(frameDir, 'frame_%04d.jpg')}"`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe', timeout: 60000 });

  return readdirSync(frameDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(frameDir, f));
}

// ── Gemini Live replay ───────────────────────────────────────────────────

async function runReplay(frames, testName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  const model = process.env.REPLAY_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
  const homeState = new HomeState();
  const transcripts = [];

  console.log(`  Connecting to Gemini Live (${model})...`);
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });

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
      onopen() { sessionReady = true; },
      onmessage(msg) {
        if (msg.toolCall) {
          const results = [];
          for (const fc of msg.toolCall.functionCalls || []) {
            console.log(`    Tool: ${fc.name}(${JSON.stringify(fc.args)})`);
            const result = homeState.handleToolCall(fc.name, fc.args || {});
            results.push({ id: fc.id, name: fc.name, response: result || { ok: true } });
          }
          session.sendToolResponse({ functionResponses: results });
        }
        if (msg.serverContent?.outputTranscription?.text) {
          const text = msg.serverContent.outputTranscription.text.trim();
          if (text) transcripts.push(text);
        }
        if (msg.serverContent?.turnComplete) {
          if (frameIndex < frames.length) {
            frameSendTimer = setTimeout(() => sendNextFrame(), 1000);
          } else {
            setTimeout(() => { session.close(); }, 3000);
          }
        }
      },
      onerror(err) { console.error(`  Session error: ${err.message || err}`); },
      onclose() {
        if (frameSendTimer) clearTimeout(frameSendTimer);
        resolveSession();
      },
    },
  });

  // Build current state summary for context
  function stateContext() {
    const rooms = [...homeState.rooms.values()].map(r => r.name);
    const loc = homeState.locationRoomId
      ? homeState.rooms.get(homeState.locationRoomId)?.name || 'unknown'
      : 'not set';
    return `Current location: ${loc}. Rooms mapped so far: [${rooms.join(', ')}].`;
  }

  function sendNextFrame() {
    if (frameIndex >= frames.length) return;
    const framePath = frames[frameIndex];
    const base64 = readFileSync(framePath).toString('base64');
    const frameNum = frameIndex + 1;
    console.log(`  [Frame ${frameNum}/${frames.length}]`);
    session.sendRealtimeInput({ video: { mimeType: 'image/jpeg', data: base64 } });
    frameIndex++;

    const ctx = stateContext();
    let prompt;
    if (frameIndex === 1) {
      prompt = `FRAME 1/${frames.length}. ${ctx} What room is this? Call upsert_room, set_user_location, and place_feature for every visible feature. Tools only.`;
    } else if (frameIndex % 5 === 0) {
      prompt = `FRAME ${frameIndex}/${frames.length}. ${ctx} CHECKPOINT: Have you found ALL rooms? Look for doorways, openings, or rooms visible in the background. Call connect_rooms for any room you can see from here. If this is a new room, call upsert_room + move_between_rooms.`;
    } else {
      prompt = `FRAME ${frameIndex}/${frames.length}. ${ctx} New room or same? If different: move_between_rooms + upsert_room. If same: place_feature for new features. Always call at least one tool.`;
    }
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: prompt }] }], turnComplete: true });
  }

  await new Promise(r => {
    const check = () => { if (sessionReady) r(); else setTimeout(check, 100); };
    check();
  });

  sendNextFrame();
  await sessionDone;
  return { homeState, transcripts };
}

// ── Test discovery ───────────────────────────────────────────────────────

function discoverTests(filter) {
  const tests = [];
  if (!existsSync(VIDEOS_DIR)) return tests;

  const files = readdirSync(VIDEOS_DIR).filter(f => f.endsWith('.mp4')).sort();
  for (const file of files) {
    const name = file.replace('.mp4', '');
    if (filter && !name.includes(filter)) continue;

    const videoPath = path.join(VIDEOS_DIR, file);
    const truthPath = path.join(GROUND_TRUTH_DIR, `${name}.json`);
    const hasTruth = existsSync(truthPath);

    tests.push({ name, videoPath, truthPath, hasTruth });
  }
  return tests;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const tests = discoverTests();
    console.log('\nAvailable test videos:');
    for (const t of tests) {
      const truth = t.hasTruth ? '✓ ground truth' : '✗ no ground truth';
      console.log(`  ${t.name} [${truth}]`);
    }
    if (tests.length === 0) console.log('  (none found — place .mp4 files in test-videos/)');
    return;
  }

  const scoreOnly = args.includes('--score-only');
  const filter = args.find(a => !a.startsWith('--'));

  const tests = discoverTests(filter);
  if (tests.length === 0) {
    console.error(`No test videos found${filter ? ` matching "${filter}"` : ''}. Place .mp4 files in test-videos/`);
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const allScores = [];

  for (const test of tests) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Running: ${test.name}`);
    console.log(`${'─'.repeat(60)}`);

    const resultPath = path.join(OUTPUT_DIR, `${test.name}-result.json`);
    let result;

    if (scoreOnly && existsSync(resultPath)) {
      console.log('  Using existing result (--score-only)');
      result = JSON.parse(readFileSync(resultPath, 'utf-8'));
    } else if (scoreOnly) {
      console.log('  No existing result, skipping');
      continue;
    } else {
      // Extract frames
      const frameDir = path.join(OUTPUT_DIR, `${test.name}-frames`);
      console.log(`  Extracting frames from ${test.videoPath}...`);
      const frames = extractFrames(test.videoPath, frameDir);
      console.log(`  Got ${frames.length} frames`);

      // Run replay
      const { homeState, transcripts } = await runReplay(frames, test.name);

      // Generate SVG
      const svg = generateFloorPlanSVG(homeState, { debug: true, animate: true, title: `${test.name} Floor Plan` });
      writeFileSync(path.join(OUTPUT_DIR, `${test.name}-floorplan.svg`), svg);

      // Build result
      const diag = diagnoseHomeState(homeState);
      result = {
        timestamp: new Date().toISOString(),
        testName: test.name,
        rooms: [...homeState.rooms.values()].map(r => ({
          id: r.id, name: r.name, roomType: r.roomType, confidence: r.confidence, features: r.features,
        })),
        edges: homeState.edges.map(e => ({
          key: e.key, fromId: e.fromId, toId: e.toId, pathType: e.pathType,
        })),
        toolCalls: homeState.toolCalls,
        events: homeState.events,
        transcripts,
        diagnostics: diag,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2));

      console.log(`  Rooms: ${homeState.rooms.size}, Edges: ${homeState.edges.length}, Tool calls: ${homeState.toolCalls.length}`);
    }

    // Score against ground truth
    if (test.hasTruth) {
      const truth = JSON.parse(readFileSync(test.truthPath, 'utf-8'));
      const scores = scoreResult(result, truth);
      allScores.push({ name: test.name, scores });
      console.log(formatScoreReport(test.name, scores));
    } else {
      console.log('  (no ground truth file — skipping scoring)');
    }
  }

  // Summary
  if (allScores.length > 0) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  EVAL SUMMARY');
    console.log(`${'═'.repeat(60)}`);
    let totalScore = 0;
    for (const { name, scores } of allScores) {
      console.log(`  ${name.padEnd(25)} ${scores.overall}/100`);
      totalScore += scores.overall;
    }
    const avg = Math.round(totalScore / allScores.length);
    console.log(`${'─'.repeat(60)}`);
    console.log(`  ${'Average'.padEnd(25)} ${avg}/100`);
    console.log(`${'═'.repeat(60)}\n`);

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      tests: allScores.map(({ name, scores }) => ({ name, overall: scores.overall, scores })),
      average: avg,
    };
    writeFileSync(path.join(OUTPUT_DIR, 'eval-summary.json'), JSON.stringify(summary, null, 2));
    console.log(`Summary saved to: ${path.join(OUTPUT_DIR, 'eval-summary.json')}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
