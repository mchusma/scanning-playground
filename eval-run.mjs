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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
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
1. upsert_room — Create rooms. Name every distinct space. Include hallways, closets, pantries, laundry rooms, balconies, stairs. ALWAYS set roomType.
2. move_between_rooms — Record transitions. ALWAYS include pathType and directionHint.
3. connect_rooms — Link rooms you can see but haven't walked between.
4. place_feature — Log visible furniture, appliances, fixtures. Key features to look for: sink, refrigerator, oven, dishwasher, toilet, shower, bathtub, bed, sofa/couch, TV, washer, dryer, fireplace, island, countertop.
5. set_user_location — ONLY call this when you CHANGE rooms. Do NOT call it every frame for the same room.

IMPORTANT: Do NOT waste tool calls by calling set_user_location repeatedly for the same room. Only call it when your location actually changes.

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

  // Infer roomType from room name when not explicitly provided
  _inferRoomType(name, explicitType) {
    if (explicitType && explicitType !== 'room') return explicitType;
    const lower = name.toLowerCase();
    const typeMap = [
      [/kitchen/i, 'kitchen'],
      [/living\s*room|family\s*room|great\s*room|lounge/i, 'living room'],
      [/dining/i, 'dining room'],
      [/bed\s*room|master\s*bed/i, 'bedroom'],
      [/bath\s*room|ensuite|powder\s*room|half\s*bath/i, 'bathroom'],
      [/hallway|corridor|hall\b/i, 'hallway'],
      [/entry|foyer|lobby/i, 'entryway'],
      [/closet|wardrobe/i, 'closet'],
      [/office|study|den/i, 'office'],
      [/laundry|utility/i, 'laundry room'],
      [/garage/i, 'garage'],
      [/pantry/i, 'pantry'],
      [/stair/i, 'stairs'],
      [/balcony|patio|deck|terrace|outdoor/i, 'outdoor'],
      [/mudroom/i, 'mudroom'],
    ];
    for (const [regex, type] of typeMap) {
      if (regex.test(lower)) return type;
    }
    return explicitType || 'room';
  }

  upsertRoom({ name, roomType, notes, confidence }) {
    const normalizedName = (name || '').trim();
    if (!normalizedName) return null;
    const id = slugify(normalizedName);
    const inferredType = this._inferRoomType(normalizedName, roomType);
    let room = this.rooms.get(id);
    if (!room) {
      const size = getRoomSize(inferredType);
      // Default position — will be updated when connections are made
      const idx = this.rooms.size;
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      const defaultX = 300 + col * 200;
      const defaultY = 300 + row * 160;
      const pos = this._findFreePosition(defaultX, defaultY, size.w, size.h, null);
      room = {
        id, name: normalizedName,
        roomType: inferredType,
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
      room.roomType = inferredType !== 'room' ? inferredType : room.roomType;
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

/**
 * Extract frames using a hybrid approach:
 * 1. Scene-change detection (catches room transitions)
 * 2. Regular interval sampling (fills gaps where scene detection misses)
 * 3. Deduplication by timestamp to avoid redundant frames
 */
function extractFrames(videoPath, frameDir) {
  mkdirSync(frameDir, { recursive: true });
  // Clean old frames
  for (const f of readdirSync(frameDir)) {
    if (f.endsWith('.jpg')) unlinkSync(path.join(frameDir, f));
  }

  // Step 1: Get video duration
  let duration = 0;
  try {
    const probe = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    duration = parseFloat(probe) || 0;
  } catch { /* fallback to uniform extraction */ }

  // Step 2: Extract scene-change frames (threshold 0.25 = moderate sensitivity)
  const sceneDir = path.join(frameDir, 'scene');
  mkdirSync(sceneDir, { recursive: true });
  try {
    execSync([
      'ffmpeg', '-y', '-i', `"${videoPath}"`,
      '-vf', `select='gt(scene\\,0.25)',scale=${FRAME_WIDTH}:-1`,
      '-vsync', 'vfr',
      '-q:v', String(JPEG_QUALITY),
      '-frames:v', String(Math.floor(MAX_FRAMES * 0.6)),
      `"${path.join(sceneDir, 'scene_%04d.jpg')}"`,
    ].join(' '), { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    console.log('  Scene detection failed, falling back to uniform extraction');
  }

  const sceneFrames = existsSync(sceneDir)
    ? readdirSync(sceneDir).filter(f => f.endsWith('.jpg')).length
    : 0;

  // Step 3: Extract uniform interval frames (fills gaps)
  const uniformDir = path.join(frameDir, 'uniform');
  mkdirSync(uniformDir, { recursive: true });
  // Use wider interval if we got many scene frames
  const uniformInterval = sceneFrames > 10 ? FRAME_INTERVAL_SEC * 2 : FRAME_INTERVAL_SEC;
  const uniformMax = Math.max(10, MAX_FRAMES - sceneFrames);
  execSync([
    'ffmpeg', '-y', '-i', `"${videoPath}"`,
    '-vf', `fps=1/${uniformInterval},scale=${FRAME_WIDTH}:-1`,
    '-q:v', String(JPEG_QUALITY),
    '-frames:v', String(uniformMax),
    `"${path.join(uniformDir, 'frame_%04d.jpg')}"`,
  ].join(' '), { stdio: 'pipe', timeout: 60000 });

  // Step 4: Merge and sort all frames by timestamp
  // For scene frames, extract timestamps
  const allFrames = [];

  // Add scene-change frames with estimated timestamps
  if (sceneFrames > 0) {
    const sceneFiles = readdirSync(sceneDir).filter(f => f.endsWith('.jpg')).sort();
    // Estimate timestamps based on frame order and video duration
    for (let i = 0; i < sceneFiles.length; i++) {
      const srcPath = path.join(sceneDir, sceneFiles[i]);
      const ts = duration > 0 ? (i / sceneFiles.length) * duration : i * 2;
      allFrames.push({ path: srcPath, timestamp: ts, type: 'scene' });
    }
  }

  // Add uniform frames with known timestamps
  const uniformFiles = readdirSync(uniformDir).filter(f => f.endsWith('.jpg')).sort();
  for (let i = 0; i < uniformFiles.length; i++) {
    const srcPath = path.join(uniformDir, uniformFiles[i]);
    const ts = i * uniformInterval;
    allFrames.push({ path: srcPath, timestamp: ts, type: 'uniform' });
  }

  // Sort by timestamp and deduplicate (remove frames within 1.5s of each other)
  allFrames.sort((a, b) => a.timestamp - b.timestamp);
  const dedupedFrames = [];
  let lastTs = -999;
  for (const frame of allFrames) {
    if (frame.timestamp - lastTs >= 1.5) {
      dedupedFrames.push(frame);
      lastTs = frame.timestamp;
    }
  }

  // Limit to MAX_FRAMES
  const finalFrames = dedupedFrames.slice(0, MAX_FRAMES);

  // Copy to output dir with sequential names
  const outputPaths = [];
  for (let i = 0; i < finalFrames.length; i++) {
    const outPath = path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.jpg`);
    if (finalFrames[i].path !== outPath) {
      execSync(`cp "${finalFrames[i].path}" "${outPath}"`, { stdio: 'pipe' });
    }
    outputPaths.push(outPath);
  }

  // Cleanup temp dirs
  try {
    for (const f of readdirSync(sceneDir)) unlinkSync(path.join(sceneDir, f));
    for (const f of readdirSync(uniformDir)) unlinkSync(path.join(uniformDir, f));
    rmdirSync(sceneDir); rmdirSync(uniformDir);
  } catch {}

  const scenePct = sceneFrames > 0 ? Math.round((finalFrames.filter(f => f.type === 'scene').length / finalFrames.length) * 100) : 0;
  console.log(`  Extracted ${finalFrames.length} frames (${scenePct}% from scene detection, ${100 - scenePct}% uniform)`);

  return outputPaths;
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
    const remaining = frames.length - frameIndex;
    let prompt;
    if (frameIndex === 1) {
      prompt = `FRAME 1/${frames.length}. ${ctx} What room is this? Call upsert_room, set_user_location, and place_feature for every visible feature. Tools only.`;
    } else if (remaining <= 3) {
      // Final frames — push for completeness
      prompt = `FRAME ${frameIndex}/${frames.length}. FINAL FRAMES! ${ctx} This is one of the last frames. Call connect_rooms for ALL visible doorways/openings. Call place_feature for any features not yet logged. Make sure every room you've seen is connected.`;
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

  // Post-processing: merge duplicate rooms and fix types
  consolidateRooms(homeState);

  // Pass 2: Review with regular Gemini API for corrections
  await reviewPass(homeState, frames, apiKey);

  // Final step: force-directed layout to clean up room positions
  forceDirectedLayout(homeState);

  return { homeState, transcripts };
}

/**
 * Force-directed layout algorithm.
 * Pulls connected rooms together, pushes overlapping rooms apart,
 * and respects directional hints from edges.
 */
function forceDirectedLayout(homeState) {
  const rooms = [...homeState.rooms.values()];
  const edges = homeState.edges;
  if (rooms.length < 2) return;

  console.log('  Running force-directed layout...');

  // Parameters
  const ITERATIONS = 200;
  const SPRING_K = 0.06;        // Spring constant — pulls connected rooms together
  const REPULSION_K = 15000;    // Repulsion constant — pushes all rooms apart (higher = more spread)
  const DAMPING = 0.90;         // Velocity damping per iteration
  const MIN_DIST = 30;          // Minimum gap between rooms
  const DIRECTION_BIAS = 0.25;  // How much to weight directional hints

  // Initialize velocities
  for (const room of rooms) {
    room._vx = 0;
    room._vy = 0;
  }

  // Pre-compute ideal distances for each edge based on room sizes
  const edgeTargets = edges.map(edge => {
    const from = homeState.rooms.get(edge.fromId);
    const to = homeState.rooms.get(edge.toId);
    if (!from || !to) return null;

    // Ideal distance: rooms should be touching (half-widths + gap)
    const dir = edge.anchorDirection;
    let idealDist;
    if (dir === 'north' || dir === 'south' || dir === 'straight' || dir === 'back' || dir === 'up' || dir === 'down') {
      idealDist = from.h / 2 + to.h / 2 + MIN_DIST;
    } else if (dir === 'east' || dir === 'west' || dir === 'left' || dir === 'right') {
      idealDist = from.w / 2 + to.w / 2 + MIN_DIST;
    } else {
      // No direction — use average
      idealDist = (from.w + from.h + to.w + to.h) / 4 + MIN_DIST;
    }

    return { from, to, idealDist, dir, edge };
  }).filter(Boolean);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Reset forces
    for (const room of rooms) {
      room._fx = 0;
      room._fy = 0;
    }

    // 1. Repulsion between ALL room pairs (prevent overlaps)
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // Minimum separation based on room sizes
        const minSep = (a.w + b.w) / 2 + MIN_DIST;
        const minSepY = (a.h + b.h) / 2 + MIN_DIST;
        const effectiveMin = Math.sqrt(minSep * minSep + minSepY * minSepY) / 2;

        // Stronger repulsion when rooms are close/overlapping
        const force = REPULSION_K / (dist * dist + 100);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        a._fx -= fx;
        a._fy -= fy;
        b._fx += fx;
        b._fy += fy;

        // Extra push if rooms actually overlap
        if (Math.abs(dx) < (a.w + b.w) / 2 + 5 && Math.abs(dy) < (a.h + b.h) / 2 + 5) {
          const pushX = dx > 0 ? minSep - Math.abs(dx) : -(minSep - Math.abs(dx));
          const pushY = dy > 0 ? minSepY - Math.abs(dy) : -(minSepY - Math.abs(dy));
          a._fx -= pushX * 0.1;
          a._fy -= pushY * 0.1;
          b._fx += pushX * 0.1;
          b._fy += pushY * 0.1;
        }
      }
    }

    // 2. Spring forces along edges (pull connected rooms together)
    for (const { from, to, idealDist, dir } of edgeTargets) {
      let dx = to.x - from.x;
      let dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      // Spring force proportional to displacement from ideal distance
      const displacement = dist - idealDist;
      const force = SPRING_K * displacement;
      let fx = (dx / dist) * force;
      let fy = (dy / dist) * force;

      // Directional bias: if we know the direction, bias the spring
      if (dir && DIRECTION_VECTORS[dir]) {
        const vec = DIRECTION_VECTORS[dir];
        // Add a gentle pull in the expected direction
        fx += vec.dx * Math.abs(displacement) * DIRECTION_BIAS;
        fy += vec.dy * Math.abs(displacement) * DIRECTION_BIAS;
      }

      from._fx += fx;
      from._fy += fy;
      to._fx -= fx;
      to._fy -= fy;
    }

    // 3. Centering force — pull rooms toward center of mass to prevent long chains
    let cx = 0, cy = 0;
    for (const room of rooms) { cx += room.x; cy += room.y; }
    cx /= rooms.length;
    cy /= rooms.length;
    const CENTER_K = 0.01;
    for (const room of rooms) {
      room._fx += (cx - room.x) * CENTER_K;
      room._fy += (cy - room.y) * CENTER_K;
    }

    // 4. Apply forces with damping
    let maxMove = 0;
    for (const room of rooms) {
      room._vx = (room._vx + room._fx) * DAMPING;
      room._vy = (room._vy + room._fy) * DAMPING;

      // Clamp velocity to prevent instability
      const speed = Math.sqrt(room._vx * room._vx + room._vy * room._vy);
      if (speed > 30) {
        room._vx = (room._vx / speed) * 30;
        room._vy = (room._vy / speed) * 30;
      }

      room.x += room._vx;
      room.y += room._vy;
      maxMove = Math.max(maxMove, Math.abs(room._vx), Math.abs(room._vy));
    }

    // Early convergence
    if (maxMove < 0.5 && iter > 20) break;
  }

  // Clean up temp properties
  for (const room of rooms) {
    delete room._vx;
    delete room._vy;
    delete room._fx;
    delete room._fy;
    // Round coordinates
    room.x = Math.round(room.x);
    room.y = Math.round(room.y);
  }

  // Normalize: shift all rooms so minimum x,y is at a reasonable origin
  const minX = Math.min(...rooms.map(r => r.x - r.w / 2));
  const minY = Math.min(...rooms.map(r => r.y - r.h / 2));
  const offsetX = 100 - minX;
  const offsetY = 100 - minY;
  for (const room of rooms) {
    room.x += offsetX;
    room.y += offsetY;
  }

  console.log(`  Layout complete: ${rooms.length} rooms positioned`);
}

/**
 * Pass 2: Use regular Gemini API to review the discovered map.
 * Sends a subset of key frames + the current map state, asks model
 * to identify missing rooms, wrong connections, and duplicate rooms.
 */
async function reviewPass(homeState, frames, apiKey) {
  console.log('  Running review pass...');
  const ai = new GoogleGenAI({ apiKey });

  // Select key frames: first, last, and evenly spaced
  const keyFrameIndices = [];
  const numKeyFrames = Math.min(12, frames.length);
  for (let i = 0; i < numKeyFrames; i++) {
    keyFrameIndices.push(Math.floor(i * (frames.length - 1) / (numKeyFrames - 1)));
  }
  const keyFrames = keyFrameIndices.map(i => ({
    inlineData: {
      mimeType: 'image/jpeg',
      data: readFileSync(frames[i]).toString('base64'),
    },
  }));

  // Build current state summary
  const roomsList = [...homeState.rooms.values()].map(r =>
    `- ${r.name} (${r.roomType}): features=[${r.features.slice(0, 5).join(', ')}]`
  ).join('\n');
  const edgesList = homeState.edges.map(e => {
    const from = homeState.rooms.get(e.fromId)?.name || e.fromId;
    const to = homeState.rooms.get(e.toId)?.name || e.toId;
    return `- ${from} ↔ ${to} (${e.pathType})`;
  }).join('\n');

  const reviewPrompt = `You are reviewing a home floor plan that was automatically generated from a video walkthrough.

Here are ${keyFrames.length} frames from the walkthrough, followed by the current map.

CURRENT MAP:
Rooms (${homeState.rooms.size}):
${roomsList}

Connections (${homeState.edges.length}):
${edgesList}

Analyze the frames and the map. Return a JSON object with corrections:
{
  "missingRooms": [{"name": "Room Name", "roomType": "type", "connectsTo": "Adjacent Room", "pathType": "doorway"}],
  "missingConnections": [{"from": "Room A", "to": "Room B", "pathType": "doorway"}],
  "missingFeatures": [{"room": "Room Name", "feature": "feature name"}],
  "roomTypeCorrections": [{"room": "Room Name", "correctType": "type"}]
}

IMPORTANT: Do NOT merge or remove existing rooms. Only ADD missing rooms, connections, and features.
Only include corrections you are confident about based on what you see in the frames. Return ONLY the JSON.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [...keyFrames, { text: reviewPrompt }],
        },
      ],
      config: { temperature: 0.2 },
    });

    const text = response.text || '';
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('  Review pass: no valid JSON response');
      return;
    }

    const corrections = JSON.parse(jsonMatch[0]);
    let applied = 0;

    // Apply missing rooms
    for (const room of corrections.missingRooms || []) {
      if (room.name && !homeState.rooms.has(slugify(room.name))) {
        homeState.upsertRoom({ name: room.name, roomType: room.roomType, confidence: 0.5 });
        if (room.connectsTo) {
          homeState.upsertEdge({ fromRoom: room.connectsTo, toRoom: room.name, pathType: room.pathType || 'doorway' });
        }
        console.log(`    + Added missing room: ${room.name}`);
        applied++;
      }
    }

    // Apply missing connections
    for (const conn of corrections.missingConnections || []) {
      if (conn.from && conn.to) {
        const fromId = slugify(conn.from);
        const toId = slugify(conn.to);
        if (homeState.rooms.has(fromId) && homeState.rooms.has(toId)) {
          const key = [fromId, toId].sort().join('::');
          if (!homeState.edges.some(e => e.key === key)) {
            homeState.upsertEdge({ fromRoom: conn.from, toRoom: conn.to, pathType: conn.pathType || 'doorway' });
            console.log(`    + Added connection: ${conn.from} ↔ ${conn.to}`);
            applied++;
          }
        }
      }
    }

    // Apply missing features
    for (const feat of corrections.missingFeatures || []) {
      const room = homeState.rooms.get(slugify(feat.room));
      if (room && feat.feature && !room.features.some(f => f.toLowerCase().includes(feat.feature.toLowerCase()))) {
        room.features.push(feat.feature);
        applied++;
      }
    }

    // Apply room type corrections
    for (const fix of corrections.roomTypeCorrections || []) {
      const room = homeState.rooms.get(slugify(fix.room));
      if (room && fix.correctType) {
        room.roomType = fix.correctType;
        applied++;
      }
    }

    console.log(`  Review pass: ${applied} corrections applied`);
  } catch (err) {
    console.log(`  Review pass failed: ${err.message}`);
  }
}

/**
 * Post-processing: merge rooms that are likely duplicates.
 * E.g., "Bedroom 1" and "Master Bedroom" in the same home, or
 * rooms with no connections that share features with a connected room.
 */
function consolidateRooms(homeState) {
  const rooms = [...homeState.rooms.values()];

  // Find potential duplicate pairs — VERY conservative merging.
  // Only merge rooms that are clearly the same physical room, e.g.:
  // - "Bathroom" and "Bathroom 1" (unnumbered + numbered)
  // - "Bedroom" and "Master Bedroom" ONLY if one has no connections (orphan)
  const merges = [];

  function stripNumber(name) { return name.replace(/\s*\d+\s*$/, '').trim(); }
  function getNumber(name) { const m = name.match(/(\d+)\s*$/); return m ? parseInt(m[1]) : null; }

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      if (a.roomType !== b.roomType) continue;

      const aStripped = stripNumber(a.name).toLowerCase();
      const bStripped = stripNumber(b.name).toLowerCase();
      const aNum = getNumber(a.name);
      const bNum = getNumber(b.name);

      // Only merge if stripped names are IDENTICAL (e.g., "Bathroom" and "Bathroom 1")
      // AND one has no number while the other does
      if (aStripped !== bStripped) continue;
      if (aNum !== null && bNum !== null) continue; // Both numbered = different rooms

      // Also require that one room is an orphan (no connections) or has very few
      const aConns = homeState.edges.filter(e => e.fromId === a.id || e.toId === a.id);
      const bConns = homeState.edges.filter(e => e.fromId === b.id || e.toId === b.id);
      if (aConns.length > 1 && bConns.length > 1) continue; // Both well-connected = probably different

      const [keep, remove] = aConns.length >= bConns.length ? [a, b] : [b, a];
      merges.push({ keep: keep.id, remove: remove.id, reason: `same name pattern, orphan merge` });
    }
  }

  // Apply merges
  for (const { keep, remove, reason } of merges) {
    const keepRoom = homeState.rooms.get(keep);
    const removeRoom = homeState.rooms.get(remove);
    if (!keepRoom || !removeRoom) continue;

    console.log(`  Consolidating: "${removeRoom.name}" → "${keepRoom.name}" (${reason})`);

    // Merge features
    for (const feat of removeRoom.features) {
      if (!keepRoom.features.includes(feat)) keepRoom.features.push(feat);
    }
    keepRoom.confidence = Math.max(keepRoom.confidence, removeRoom.confidence);

    // Redirect edges
    for (const edge of homeState.edges) {
      if (edge.fromId === remove) edge.fromId = keep;
      if (edge.toId === remove) edge.toId = keep;
    }
    // Remove self-loops and duplicate edges
    homeState.edges = homeState.edges.filter(e => e.fromId !== e.toId);
    const seenEdges = new Set();
    homeState.edges = homeState.edges.filter(e => {
      const key = [e.fromId, e.toId].sort().join('::');
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      e.key = key;
      return true;
    });

    // Remove the duplicate room
    homeState.rooms.delete(remove);
    if (homeState.locationRoomId === remove) homeState.locationRoomId = keep;
    homeState.events.push(`Merged "${removeRoom.name}" into "${keepRoom.name}"`);
  }
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

// ── Asset Inventory ──────────────────────────────────────────────────────

function generateAssetInventory(homeState, testName) {
  const rooms = [...homeState.rooms.values()];
  const edges = homeState.edges;

  // Categorize features
  const CATEGORIES = {
    'Appliances': ['refrigerator', 'fridge', 'oven', 'stove', 'microwave', 'dishwasher', 'washer', 'dryer', 'garbage disposal'],
    'Plumbing': ['sink', 'toilet', 'shower', 'bathtub', 'tub', 'faucet'],
    'Furniture': ['sofa', 'couch', 'bed', 'desk', 'table', 'chair', 'dresser', 'nightstand', 'bookshelf', 'cabinet', 'shelving'],
    'Electronics': ['tv', 'television', 'light fixture', 'lamp', 'recessed lighting', 'ceiling fan'],
    'Fixtures': ['countertop', 'counter', 'island', 'fireplace', 'window', 'door', 'mirror', 'railing'],
    'Storage': ['closet', 'pantry', 'cabinet', 'shelving', 'hanging rods'],
  };

  function categorize(feature) {
    const lower = feature.toLowerCase().replace(/\s*\([^)]*\)\s*/g, '').trim();
    for (const [cat, keywords] of Object.entries(CATEGORIES)) {
      if (keywords.some(k => lower.includes(k))) return cat;
    }
    return 'Other';
  }

  const inventory = {
    name: testName,
    timestamp: new Date().toISOString(),
    summary: {
      totalRooms: rooms.length,
      totalConnections: edges.length,
      totalFeatures: rooms.reduce((sum, r) => sum + r.features.length, 0),
    },
    rooms: rooms.map(r => ({
      name: r.name,
      type: r.roomType,
      confidence: r.confidence,
      features: r.features,
    })),
    connections: edges.map(e => ({
      from: homeState.rooms.get(e.fromId)?.name || e.fromId,
      to: homeState.rooms.get(e.toId)?.name || e.toId,
      type: e.pathType,
    })),
    assetsByCategory: {},
    assetsByRoom: {},
  };

  // Build asset categorization
  for (const room of rooms) {
    const roomAssets = [];
    for (const feature of room.features) {
      const cat = categorize(feature);
      const clean = feature.replace(/\s*\([^)]*\)\s*$/, '').trim();
      roomAssets.push({ name: clean, category: cat, room: room.name });

      if (!inventory.assetsByCategory[cat]) inventory.assetsByCategory[cat] = [];
      inventory.assetsByCategory[cat].push({ name: clean, room: room.name });
    }
    if (roomAssets.length > 0) {
      inventory.assetsByRoom[room.name] = roomAssets;
    }
  }

  // Summary counts
  inventory.summary.byCategory = {};
  for (const [cat, items] of Object.entries(inventory.assetsByCategory)) {
    inventory.summary.byCategory[cat] = items.length;
  }

  return inventory;
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

      // Generate SVGs — clean version for viewing + debug version for analysis
      const svg = generateFloorPlanSVG(homeState, { debug: false, animate: false, title: `${test.name} Floor Plan` });
      writeFileSync(path.join(OUTPUT_DIR, `${test.name}-floorplan.svg`), svg);
      const svgDebug = generateFloorPlanSVG(homeState, { debug: true, animate: false, title: `${test.name} Floor Plan (Debug)` });
      writeFileSync(path.join(OUTPUT_DIR, `${test.name}-floorplan-debug.svg`), svgDebug);

      // Generate asset inventory
      const inventory = generateAssetInventory(homeState, test.name);
      writeFileSync(path.join(OUTPUT_DIR, `${test.name}-inventory.json`), JSON.stringify(inventory, null, 2));

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
