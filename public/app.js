import { GoogleGenAI, Modality } from '/genai/index.patched.mjs';
import { generateFloorPlanSVG, svgToPng, downloadFile } from './svg-export.js';

const els = {
  modelInput: document.getElementById('modelInput'),
  homeLabelInput: document.getElementById('homeLabelInput'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  sendBtn: document.getElementById('sendBtn'),
  manualInput: document.getElementById('manualInput'),
  voiceToggle: document.getElementById('voiceToggle'),
  debugToggle: document.getElementById('debugToggle'),
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  frameCounter: document.getElementById('frameCounter'),
  cameraVideo: document.getElementById('cameraVideo'),
  interimSpeech: document.getElementById('interimSpeech'),
  conversation: document.getElementById('conversation'),
  floorCanvas: document.getElementById('floorCanvas'),
  locationPill: document.getElementById('locationPill'),
  statsPill: document.getElementById('statsPill'),
  roomsList: document.getElementById('roomsList'),
  timeline: document.getElementById('timeline'),
  debugCard: document.getElementById('debugCard'),
  debugState: document.getElementById('debugState'),
  debugMetrics: document.getElementById('debugMetrics'),
  debugLog: document.getElementById('debugLog'),
  exportSvgBtn: document.getElementById('exportSvgBtn'),
  exportPngBtn: document.getElementById('exportPngBtn'),
};

const floorCtx = els.floorCanvas.getContext('2d');
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');

const CARDINAL_DIRECTIONS = ['north', 'east', 'south', 'west'];
const CARDINAL_VECTORS = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

const state = {
  connected: false,
  session: null,
  ai: null,
  videoStream: null,
  micStream: null,
  frameTimer: null,
  framesSent: 0,
  micContext: null,
  micSourceNode: null,
  micProcessorNode: null,
  micSilenceGainNode: null,
  playbackContext: null,
  playbackCursorTime: 0,
  playbackSources: new Set(),
  assistantDraft: '',
  messages: [],
  timeline: [],
  home: {
    rooms: new Map(),
    edges: [],
    locationRoomId: null,
    heading: 'north',
    transitionCount: 0,
    lastTransition: null,
  },
  debug: {
    enabled: true,
    entries: [],
    totalToolCalls: 0,
    movementDecisions: 0,
    autoMapActions: 0,
    audioInChunks: 0,
    audioOutChunks: 0,
    audioOutSeconds: 0,
    lastInputTranscript: '',
    lastOutputTranscript: '',
  },
  parser: {
    recentSignatures: [],
  },
  modelSupport: {
    available: [],
    recommended: null,
  },
};

const DEFAULT_STATUS = 'Ready to connect.';
const MAX_TIMELINE = 40;
const MAX_MESSAGES = 80;
const MAX_DEBUG_ENTRIES = 100;
const FRAME_SEND_INTERVAL_MS = 2500;
const ROOM_LINK_DISTANCE = 190;
const AUDIO_FALLBACK_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const AUDIO_CHUNK_SAMPLE_RATE = 24000;
const MIC_TARGET_SAMPLE_RATE = 16000;
const MIC_PROCESSOR_BUFFER_SIZE = 4096;
const TRANSCRIPT_SIGNATURE_CACHE_LIMIT = 120;
const ROOM_ALIAS_MAP = {
  kitchen: 'Kitchen',
  'family room': 'Family Room',
  'living room': 'Living Room',
  lounge: 'Living Room',
  'dining room': 'Dining Room',
  bedroom: 'Bedroom',
  'primary bedroom': 'Primary Bedroom',
  'master bedroom': 'Primary Bedroom',
  'guest bedroom': 'Guest Bedroom',
  bathroom: 'Bathroom',
  bath: 'Bathroom',
  restroom: 'Bathroom',
  washroom: 'Bathroom',
  'powder room': 'Bathroom',
  hallway: 'Hallway',
  hall: 'Hallway',
  office: 'Office',
  'home office': 'Office',
  garage: 'Garage',
  'laundry room': 'Laundry Room',
  laundry: 'Laundry Room',
  entryway: 'Entryway',
  foyer: 'Entryway',
  mudroom: 'Mudroom',
  pantry: 'Pantry',
  closet: 'Closet',
  basement: 'Basement',
  attic: 'Attic',
  den: 'Den',
  playroom: 'Playroom',
  patio: 'Patio',
  balcony: 'Balcony',
};
const ROOM_ALIASES = Object.keys(ROOM_ALIAS_MAP).sort((a, b) => b.length - a.length);

const LIVE_SYSTEM_PROMPT = `
You are ScanPilot, a live home-mapping guide.

Goals:
1) Ask concise, useful questions while the user walks through their home.
2) Keep the conversation natural and encouraging.
3) Continuously update the spatial profile by calling tools.

Rules:
- Ask one short question at a time.
- Every time the user moves from one room to another, call move_between_rooms.
- When any room is mentioned, call upsert_room.
- Keep the current room updated with set_user_location.
- If movement wording includes orientation, map it to moveType: left, right, straight, or back.
- Use directionHint only when the user clearly gives cardinal direction (north/east/south/west).
- Use connect_rooms for non-traversed adjacency facts (for example "the kitchen is next to the dining room").
- Use set_user_location only for corrections or if current room is explicitly restated.
- When a user mentions a room detail, call upsert_room and place_feature as needed.
- If you infer a key detail from context, log it with log_scan_event.
- Prefer fast iteration over certainty; rough mapping is expected.
- Keep responses under 2 short sentences unless the user asks for detail.
- Speak naturally and briefly.
- Stay focused on home walkthrough mapping; do not pivot to shopping/order tasks.
`;

const TOOL_DECLARATIONS = [
  {
    name: 'upsert_room',
    description:
      'Create or update a room in the rough home map. Use for new rooms, renamed rooms, or confidence updates.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Room name, for example Kitchen or Hallway.' },
        roomType: {
          type: 'string',
          description:
            'Optional category, for example kitchen, bedroom, bathroom, hallway, utility.',
        },
        notes: { type: 'string', description: 'Short description of what defines this room.' },
        confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'move_between_rooms',
    description:
      'Record a traversed move from one room to another and update relative layout direction.',
    parameters: {
      type: 'object',
      properties: {
        fromRoom: { type: 'string', description: 'Starting room of this move.' },
        toRoom: { type: 'string', description: 'Destination room of this move.' },
        moveType: {
          type: 'string',
          description: 'One of: straight, left, right, back, unknown.',
        },
        directionHint: {
          type: 'string',
          description: 'Optional absolute direction if explicitly known: north, east, south, west.',
        },
        pathType: {
          type: 'string',
          description: 'doorway, archway, hallway, stairs, open-plan, etc.',
        },
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
        pathType: {
          type: 'string',
          description: 'doorway, archway, stairs, hallway, open-plan, etc.',
        },
      },
      required: ['fromRoom', 'toRoom'],
    },
  },
  {
    name: 'set_user_location',
    description: 'Set the room where the user is currently standing.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
      },
      required: ['room'],
    },
  },
  {
    name: 'place_feature',
    description:
      'Attach a feature or fixture to a room, like island, tub, sink, fireplace, pantry, window wall.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        feature: { type: 'string' },
        positionHint: {
          type: 'string',
          description: 'Optional relative position, for example north wall, left side, center.',
        },
      },
      required: ['room', 'feature'],
    },
  },
  {
    name: 'log_scan_event',
    description: 'Record a notable mapping or inference milestone.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
      },
      required: ['summary'],
    },
  },
];

function setStatus(kind, text) {
  els.statusBadge.className = 'status';
  if (kind === 'live') {
    els.statusBadge.classList.add('status-live');
    els.statusBadge.textContent = 'live';
  } else if (kind === 'error') {
    els.statusBadge.classList.add('status-error');
    els.statusBadge.textContent = 'error';
  } else {
    els.statusBadge.classList.add('status-idle');
    els.statusBadge.textContent = 'idle';
  }
  els.statusText.textContent = text;
}

function addMessage(role, text) {
  if (!text || !text.trim()) {
    return;
  }
  state.messages.push({ role, text: text.trim(), at: new Date() });
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
  renderConversation();
}

function addEvent(summary, kind = 'scan') {
  state.timeline.unshift({
    summary,
    kind,
    at: new Date(),
  });
  if (state.timeline.length > MAX_TIMELINE) {
    state.timeline.length = MAX_TIMELINE;
  }
  renderTimeline();
}

function formatDebugData(data) {
  if (!data) {
    return '';
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch (_error) {
    return String(data);
  }
}

function renderDebugPanel() {
  if (!els.debugCard || !els.debugLog || !els.debugMetrics || !els.debugState) {
    return;
  }

  els.debugCard.classList.toggle('is-hidden', !state.debug.enabled);
  els.debugState.textContent = state.debug.enabled ? 'on' : 'off';

  const transition = state.home.lastTransition;
  const transitionLabel = transition
    ? `${transition.moveType} ${transition.fromId} -> ${transition.toId} (${transition.direction})`
    : 'none';
  const inputPreview = state.debug.lastInputTranscript
    ? ` · Last input: "${state.debug.lastInputTranscript.slice(0, 60)}"`
    : '';
  const outputPreview = state.debug.lastOutputTranscript
    ? ` · Last output: "${state.debug.lastOutputTranscript.slice(0, 60)}"`
    : '';

  els.debugMetrics.textContent = `Tools: ${state.debug.totalToolCalls} · Placement decisions: ${state.debug.movementDecisions} · Auto-map actions: ${state.debug.autoMapActions} · Audio in chunks: ${state.debug.audioInChunks} · Audio out chunks: ${state.debug.audioOutChunks} (${state.debug.audioOutSeconds.toFixed(1)}s) · Last transition: ${transitionLabel}${inputPreview}${outputPreview}`;

  els.debugLog.innerHTML = '';
  for (const entry of state.debug.entries) {
    const row = document.createElement('div');
    row.className = 'debug-row';

    const title = document.createElement('strong');
    title.textContent = entry.kind;

    const stamp = document.createElement('small');
    stamp.textContent = `${entry.at.toLocaleTimeString()} · ${entry.message}`;

    row.append(title, stamp);

    if (entry.dataText) {
      const code = document.createElement('code');
      code.textContent = entry.dataText;
      row.appendChild(code);
    }

    els.debugLog.appendChild(row);
  }
}

function debugLog(kind, message, data) {
  const payload = {
    kind,
    message,
    at: new Date(),
    dataText: formatDebugData(data),
  };

  state.debug.entries.unshift(payload);
  if (state.debug.entries.length > MAX_DEBUG_ENTRIES) {
    state.debug.entries.length = MAX_DEBUG_ENTRIES;
  }

  renderDebugPanel();
}

function renderConversation() {
  els.conversation.innerHTML = '';
  for (const message of state.messages) {
    const node = document.createElement('div');
    node.className = `msg msg-${message.role}`;
    node.textContent = message.text;
    els.conversation.appendChild(node);
  }
  if (state.assistantDraft.trim()) {
    const draft = document.createElement('div');
    draft.className = 'msg msg-draft';
    draft.textContent = state.assistantDraft.trim();
    els.conversation.appendChild(draft);
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function renderTimeline() {
  els.timeline.innerHTML = '';
  for (const event of state.timeline) {
    const node = document.createElement('div');
    node.className = 'event';

    const time = document.createElement('small');
    time.textContent = `${event.at.toLocaleTimeString()} · ${event.kind}`;

    const text = document.createElement('div');
    text.textContent = event.summary;

    node.append(time, text);
    els.timeline.appendChild(node);
  }
}

function renderRooms() {
  const rooms = [...state.home.rooms.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  els.roomsList.innerHTML = '';

  const totalFeatures = rooms.reduce((sum, room) => sum + room.features.length, 0);
  els.statsPill.textContent = `${rooms.length} rooms · ${state.home.edges.length} links · ${state.home.transitionCount} moves · ${totalFeatures} features`;

  for (const room of rooms) {
    const item = document.createElement('article');
    const isActive = room.id === state.home.locationRoomId;
    item.className = `room-chip${isActive ? ' active' : ''}`;

    const title = document.createElement('strong');
    title.textContent = room.name;

    const meta = document.createElement('span');
    const confidence = Math.max(0, Math.min(100, Math.round((room.confidence || 0) * 100)));
    const featuresText = room.features.length ? ` · ${room.features.join(', ')}` : '';
    meta.textContent = `${room.roomType || 'room'} · ${confidence}%${featuresText}`;

    item.append(title, meta);
    els.roomsList.appendChild(item);
  }

  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event';
    empty.textContent = 'No rooms mapped yet. Start scanning and describe where you are.';
    els.roomsList.appendChild(empty);
  }

  const locationRoom = state.home.locationRoomId
    ? state.home.rooms.get(state.home.locationRoomId)
    : null;
  els.locationPill.textContent = locationRoom
    ? `Location: ${locationRoom.name} · heading ${state.home.heading}`
    : 'Location: unknown';
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function clampToCanvas(x, y, marginX = 90, marginY = 80) {
  return {
    x: Math.max(marginX, Math.min(els.floorCanvas.width - marginX, x)),
    y: Math.max(marginY, Math.min(els.floorCanvas.height - marginY, y)),
  };
}

function pickRoomPosition() {
  const { width, height } = els.floorCanvas;
  const radius = Math.min(width, height) * 0.28;
  const angle = Math.random() * Math.PI * 2;
  const point = {
    x: width / 2 + Math.cos(angle) * radius * (0.55 + Math.random() * 0.45),
    y: height / 2 + Math.sin(angle) * radius * (0.55 + Math.random() * 0.45),
  };
  return clampToCanvas(point.x, point.y);
}

function normalizeCardinal(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('n')) {
    return 'north';
  }
  if (trimmed.startsWith('e')) {
    return 'east';
  }
  if (trimmed.startsWith('s')) {
    return 'south';
  }
  if (trimmed.startsWith('w')) {
    return 'west';
  }
  return null;
}

function normalizeMoveType(value) {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const text = value.trim().toLowerCase();
  if (!text) {
    return 'unknown';
  }

  if (text.includes('left')) {
    return 'left';
  }
  if (text.includes('right')) {
    return 'right';
  }
  if (text.includes('back') || text.includes('reverse') || text.includes('u-turn')) {
    return 'back';
  }
  if (
    text.includes('straight') ||
    text.includes('ahead') ||
    text.includes('forward') ||
    text.includes('continue')
  ) {
    return 'straight';
  }

  return 'unknown';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTranscriptText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rememberTranscriptSignature(signature) {
  if (state.parser.recentSignatures.includes(signature)) {
    return false;
  }
  state.parser.recentSignatures.push(signature);
  if (state.parser.recentSignatures.length > TRANSCRIPT_SIGNATURE_CACHE_LIMIT) {
    state.parser.recentSignatures.splice(
      0,
      state.parser.recentSignatures.length - TRANSCRIPT_SIGNATURE_CACHE_LIMIT,
    );
  }
  return true;
}

function extractRoomMentions(text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) {
    return [];
  }

  const matches = [];
  for (const alias of ROOM_ALIASES) {
    const regex = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'g');
    let match = regex.exec(normalized);
    while (match) {
      matches.push({
        index: match.index,
        roomName: ROOM_ALIAS_MAP[alias],
      });
      match = regex.exec(normalized);
    }
  }

  matches.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const rooms = [];
  for (const match of matches) {
    if (seen.has(match.roomName)) {
      continue;
    }
    seen.add(match.roomName);
    rooms.push(match.roomName);
  }
  return rooms;
}

function autoMapFromTranscript(rawText, source = 'transcript') {
  const normalized = normalizeTranscriptText(rawText);
  if (normalized.length < 4) {
    return;
  }

  const signature = `${source}:${normalized}`;
  if (!rememberTranscriptSignature(signature)) {
    return;
  }

  const mentionedRooms = extractRoomMentions(normalized);
  if (mentionedRooms.length === 0) {
    return;
  }

  for (const roomName of mentionedRooms) {
    upsertRoom({ name: roomName });
  }

  let action = 'upsert';
  let result = null;
  const moveType = normalizeMoveType(normalized);
  const hasFromTo = /\bfrom\b/.test(normalized) && /\bto\b/.test(normalized);
  const hasMoveCue =
    hasFromTo || /\b(go|going|move|moving|walk|walking|head|headed|enter|entered|toward|towards|into)\b/.test(normalized);
  const hasLocationCue = /\b(i(?:'m| am)|we(?:'re| are)|currently|now|standing|inside|in|at)\b/.test(
    normalized,
  );

  if (hasFromTo && mentionedRooms.length >= 2) {
    result = moveBetweenRooms({
      fromRoom: mentionedRooms[0],
      toRoom: mentionedRooms[mentionedRooms.length - 1],
      moveType,
    });
    action = 'move';
  } else if (hasMoveCue) {
    const toRoom = mentionedRooms[mentionedRooms.length - 1];
    const currentRoom = state.home.locationRoomId
      ? state.home.rooms.get(state.home.locationRoomId)?.name
      : null;

    if (currentRoom && slugify(currentRoom) !== slugify(toRoom)) {
      result = moveBetweenRooms({
        fromRoom: currentRoom,
        toRoom,
        moveType,
      });
      action = 'move';
    } else if (mentionedRooms.length >= 2) {
      result = moveBetweenRooms({
        fromRoom: mentionedRooms[0],
        toRoom,
        moveType,
      });
      action = 'move';
    } else {
      result = setUserLocation({ room: toRoom });
      action = 'locate';
    }
  } else if (hasLocationCue || !state.home.locationRoomId) {
    const targetRoom = mentionedRooms[0];
    const currentRoom = state.home.locationRoomId
      ? state.home.rooms.get(state.home.locationRoomId)?.name
      : null;
    if (
      currentRoom &&
      slugify(currentRoom) !== slugify(targetRoom) &&
      /\b(now|currently|inside|in|at|entered|arrived)\b/.test(normalized)
    ) {
      result = moveBetweenRooms({
        fromRoom: currentRoom,
        toRoom: targetRoom,
        moveType: moveType === 'unknown' ? 'straight' : moveType,
      });
      action = 'move';
    } else {
      result = setUserLocation({ room: targetRoom });
      action = 'locate';
    }
  }

  if (/\b(next to|adjacent to|connected to)\b/.test(normalized) && mentionedRooms.length >= 2) {
    upsertEdge({
      fromRoom: mentionedRooms[0],
      toRoom: mentionedRooms[1],
      pathType: 'adjacent',
    });
    action = action === 'upsert' ? 'connect' : `${action}+connect`;
  }

  state.debug.autoMapActions += 1;
  debugLog('auto-map', `Parsed ${source}`, {
    text: rawText,
    rooms: mentionedRooms,
    action,
    result,
  });
  renderRooms();
}

function rotateCardinal(baseDirection, offset) {
  const index = CARDINAL_DIRECTIONS.indexOf(baseDirection);
  if (index < 0) {
    return 'north';
  }
  const next = (index + offset + CARDINAL_DIRECTIONS.length) % CARDINAL_DIRECTIONS.length;
  return CARDINAL_DIRECTIONS[next];
}

function deriveHeadingFromMove(currentHeading, moveType) {
  switch (moveType) {
    case 'left':
      return rotateCardinal(currentHeading, -1);
    case 'right':
      return rotateCardinal(currentHeading, 1);
    case 'back':
      return rotateCardinal(currentHeading, 2);
    case 'straight':
      return currentHeading;
    default:
      return currentHeading;
  }
}

function buildDirectionPriority(preferredDirection) {
  const preferred = normalizeCardinal(preferredDirection) || 'north';
  return [
    preferred,
    rotateCardinal(preferred, -1),
    rotateCardinal(preferred, 1),
    rotateCardinal(preferred, 2),
  ];
}

function directionFromDelta(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? 'east' : 'west';
  }
  return dy >= 0 ? 'south' : 'north';
}

function oppositeDirection(direction) {
  return rotateCardinal(direction, 2);
}

function getEdgeBetween(roomAId, roomBId) {
  return state.home.edges.find(
    (edge) =>
      (edge.fromId === roomAId && edge.toId === roomBId) ||
      (edge.fromId === roomBId && edge.toId === roomAId),
  );
}

function getNeighborDirectionForRoom(roomId, edge) {
  const from = state.home.rooms.get(edge.fromId);
  const to = state.home.rooms.get(edge.toId);
  if (!from || !to) {
    return null;
  }

  if (edge.anchorFromId && edge.anchorDirection) {
    if (edge.anchorFromId === roomId) {
      return edge.anchorDirection;
    }
    return oppositeDirection(edge.anchorDirection);
  }

  if (from.id === roomId) {
    return directionFromDelta(to.x - from.x, to.y - from.y);
  }
  if (to.id === roomId) {
    return directionFromDelta(from.x - to.x, from.y - to.y);
  }
  return null;
}

function countRoomLinks(roomId) {
  let count = 0;
  for (const edge of state.home.edges) {
    if (edge.fromId === roomId || edge.toId === roomId) {
      count += 1;
    }
  }
  return count;
}

function computePlacementScore(x, y, fromRoomId, toRoomId) {
  let minDistance = Number.POSITIVE_INFINITY;

  for (const room of state.home.rooms.values()) {
    if (room.id === fromRoomId || room.id === toRoomId) {
      continue;
    }
    const dx = room.x - x;
    const dy = room.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    minDistance = Math.min(minDistance, distance);
  }

  if (!Number.isFinite(minDistance)) {
    minDistance = 280;
  }

  const centerDx = x - els.floorCanvas.width / 2;
  const centerDy = y - els.floorCanvas.height / 2;
  const centerPenalty = Math.sqrt(centerDx * centerDx + centerDy * centerDy) * 0.06;

  return minDistance - centerPenalty;
}

function placeRoomRelative(fromRoom, toRoom, preferredDirection) {
  const priority = buildDirectionPriority(preferredDirection || state.home.heading);
  const occupied = new Set();
  const candidates = [];

  for (const edge of state.home.edges) {
    const dir = getNeighborDirectionForRoom(fromRoom.id, edge);
    if (dir) {
      occupied.add(dir);
    }
  }

  let best = null;
  for (const direction of priority) {
    const vector = CARDINAL_VECTORS[direction] || CARDINAL_VECTORS.north;
    const candidate = clampToCanvas(
      fromRoom.x + vector.x * ROOM_LINK_DISTANCE,
      fromRoom.y + vector.y * ROOM_LINK_DISTANCE,
    );

    const collisionPenalty = occupied.has(direction) ? 105 : 0;
    const score = computePlacementScore(candidate.x, candidate.y, fromRoom.id, toRoom.id) - collisionPenalty;
    candidates.push({
      direction,
      score: Number(score.toFixed(2)),
      occupied: occupied.has(direction),
      x: Math.round(candidate.x),
      y: Math.round(candidate.y),
    });

    if (!best || score > best.score) {
      best = {
        direction,
        x: candidate.x,
        y: candidate.y,
        score,
      };
    }
  }

  if (!best) {
    return null;
  }

  const oldX = toRoom.x;
  const oldY = toRoom.y;
  toRoom.x = best.x;
  toRoom.y = best.y;
  toRoom.vx += (best.x - oldX) * 0.018;
  toRoom.vy += (best.y - oldY) * 0.018;
  toRoom.positionSource = 'transition';
  toRoom.spawnedAt = Date.now();

  return {
    direction: best.direction,
    candidates,
  };
}

// Infer roomType from name when not explicitly provided
function inferRoomType(name, explicitType) {
  if (explicitType && explicitType !== 'room') return explicitType;
  const lower = name.toLowerCase();
  const typeMap = [
    [/kitchen/i, 'kitchen'], [/living\s*room|family\s*room|great\s*room/i, 'living room'],
    [/dining/i, 'dining room'], [/bed\s*room|master\s*bed/i, 'bedroom'],
    [/bath\s*room|ensuite|powder\s*room/i, 'bathroom'], [/hallway|corridor|hall\b/i, 'hallway'],
    [/entry|foyer|lobby/i, 'entryway'], [/closet|wardrobe/i, 'closet'],
    [/office|study|den/i, 'office'], [/laundry|utility/i, 'laundry room'],
    [/garage/i, 'garage'], [/pantry/i, 'pantry'], [/stair/i, 'stairs'],
    [/balcony|patio|deck|terrace|outdoor/i, 'outdoor'],
  ];
  for (const [regex, type] of typeMap) { if (regex.test(lower)) return type; }
  return explicitType || 'room';
}

function upsertRoom({ name, roomType, notes, confidence }) {
  const normalizedName = (name || '').trim();
  if (!normalizedName) {
    return null;
  }

  const id = slugify(normalizedName);
  const inferredType = inferRoomType(normalizedName, roomType);
  let room = state.home.rooms.get(id);

  if (!room) {
    const initialPos = pickRoomPosition();
    const now = Date.now();
    room = {
      id,
      name: normalizedName,
      roomType: inferredType,
      notes: notes || '',
      confidence: typeof confidence === 'number' ? confidence : 0.6,
      features: [],
      x: initialPos.x,
      y: initialPos.y,
      vx: 0,
      vy: 0,
      createdAt: now,
      spawnedAt: now,
      highlightedUntil: now + 900,
      positionSource: 'organic',
      lastSeen: now,
    };
    state.home.rooms.set(id, room);
    addEvent(`Mapped room: ${room.name}`, 'map');
  } else {
    room.roomType = inferredType !== 'room' ? inferredType : room.roomType;
    room.notes = notes || room.notes;
    if (typeof confidence === 'number') {
      room.confidence = Math.max(0.1, Math.min(1, confidence));
    }
    room.lastSeen = Date.now();
  }

  return room;
}

function upsertEdge({
  fromRoom,
  toRoom,
  pathType,
  anchorFromId = null,
  anchorDirection = null,
}) {
  const from = upsertRoom({ name: fromRoom });
  const to = upsertRoom({ name: toRoom });
  if (!from || !to || from.id === to.id) {
    return null;
  }

  const existing = getEdgeBetween(from.id, to.id);
  if (existing) {
    existing.pathType = pathType || existing.pathType;
    if (anchorFromId) {
      existing.anchorFromId = anchorFromId;
    }
    if (anchorDirection) {
      existing.anchorDirection = anchorDirection;
    }
    existing.updatedAt = Date.now();
    return existing;
  }

  const edge = {
    key: [from.id, to.id].sort().join('::'),
    fromId: from.id,
    toId: to.id,
    pathType: pathType || 'path',
    anchorFromId,
    anchorDirection,
    updatedAt: Date.now(),
  };
  state.home.edges.push(edge);
  addEvent(`Linked ${from.name} to ${to.name}`, 'map');
  return edge;
}

function placeFeature({ room, feature, positionHint }) {
  const target = upsertRoom({ name: room });
  if (!target || !feature) {
    return null;
  }

  const featureLabel = positionHint ? `${feature} (${positionHint})` : feature;
  if (!target.features.includes(featureLabel)) {
    target.features.push(featureLabel);
    target.features = target.features.slice(-5);
    target.lastSeen = Date.now();
    addEvent(`Placed feature in ${target.name}: ${featureLabel}`, 'feature');
  }
  return target;
}

function setUserLocation({ room }) {
  const target = upsertRoom({ name: room });
  if (!target) {
    return null;
  }

  const now = Date.now();
  const isSameRoom = state.home.locationRoomId === target.id;
  target.highlightedUntil = now + 900;
  target.lastSeen = now;
  state.home.locationRoomId = target.id;
  if (!isSameRoom) {
    addEvent(`You are now in ${target.name}`, 'location');
  }
  return target;
}

function moveBetweenRooms({ fromRoom, toRoom, moveType, directionHint, pathType }) {
  const from = upsertRoom({ name: fromRoom });
  const to = upsertRoom({ name: toRoom });
  if (!from || !to || from.id === to.id) {
    return null;
  }
  const now = Date.now();
  if (
    state.home.lastTransition &&
    state.home.lastTransition.fromId === from.id &&
    state.home.lastTransition.toId === to.id &&
    now - state.home.lastTransition.at < 6000
  ) {
    state.home.locationRoomId = to.id;
    to.lastSeen = now;
    to.highlightedUntil = now + 900;
    return {
      ok: true,
      deduped: true,
      from: from.name,
      to: to.name,
    };
  }

  const normalizedMove = normalizeMoveType(moveType);
  const absoluteDirection = normalizeCardinal(directionHint);
  const inferredDirection =
    absoluteDirection || deriveHeadingFromMove(state.home.heading, normalizedMove);

  const existingLinksToTarget = countRoomLinks(to.id);
  let placementDirection = inferredDirection;
  let placementCandidates = [];
  let placementMode = 'inferred';

  if (to.positionSource !== 'transition' || existingLinksToTarget <= 1) {
    const placement = placeRoomRelative(from, to, inferredDirection);
    if (placement?.direction) {
      placementDirection = placement.direction;
      placementCandidates = placement.candidates || [];
      placementMode = 'relative-placement';
    }
  } else {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    placementDirection = directionFromDelta(dx, dy);
    placementMode = 'existing-room';
  }

  const edge = upsertEdge({
    fromRoom: from.name,
    toRoom: to.name,
    pathType: pathType || 'doorway',
    anchorFromId: from.id,
    anchorDirection: placementDirection,
  });

  if (edge) {
    edge.anchorFromId = from.id;
    edge.anchorDirection = placementDirection;
  }

  state.home.locationRoomId = to.id;
  state.home.heading = placementDirection || state.home.heading;
  state.home.transitionCount += 1;
  state.home.lastTransition = {
    fromId: from.id,
    toId: to.id,
    moveType: normalizedMove,
    direction: state.home.heading,
    at: now,
  };

  to.lastSeen = now;
  to.highlightedUntil = now + 1000;

  state.debug.movementDecisions += 1;
  debugLog('movement', 'Resolved move_between_rooms', {
    from: from.name,
    to: to.name,
    moveType: normalizedMove,
    directionHint: absoluteDirection,
    inferredDirection,
    placementDirection,
    placementMode,
    existingLinksToTarget,
    headingAfter: state.home.heading,
    candidates: placementCandidates,
  });

  addEvent(
    `Moved ${normalizedMove} from ${from.name} to ${to.name} (${state.home.heading}).`,
    'move',
  );

  return {
    ok: true,
    from: from.name,
    to: to.name,
    moveType: normalizedMove,
    heading: state.home.heading,
    connection: edge?.key || null,
  };
}

function applyToolCall(functionCall) {
  const args = functionCall?.args || {};
  const callName = functionCall?.name || 'unknown';
  state.debug.totalToolCalls += 1;
  debugLog('tool-call', `Received ${callName}`, {
    id: functionCall?.id || null,
    args,
  });

  try {
    switch (callName) {
      case 'upsert_room': {
        const room = upsertRoom({
          name: String(args.name || ''),
          roomType: typeof args.roomType === 'string' ? args.roomType : undefined,
          notes: typeof args.notes === 'string' ? args.notes : undefined,
          confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        });
        return room
          ? { ok: true, roomId: room.id, roomName: room.name }
          : { ok: false, error: 'invalid room payload' };
      }
      case 'move_between_rooms': {
        const result = moveBetweenRooms({
          fromRoom: String(args.fromRoom || ''),
          toRoom: String(args.toRoom || ''),
          moveType: typeof args.moveType === 'string' ? args.moveType : 'unknown',
          directionHint: typeof args.directionHint === 'string' ? args.directionHint : undefined,
          pathType: typeof args.pathType === 'string' ? args.pathType : undefined,
        });
        return result || { ok: false, error: 'invalid movement payload' };
      }
      case 'connect_rooms': {
        const edge = upsertEdge({
          fromRoom: String(args.fromRoom || ''),
          toRoom: String(args.toRoom || ''),
          pathType: typeof args.pathType === 'string' ? args.pathType : undefined,
        });
        return edge
          ? { ok: true, connection: edge.key }
          : { ok: false, error: 'invalid connection payload' };
      }
      case 'place_feature': {
        const room = placeFeature({
          room: String(args.room || ''),
          feature: String(args.feature || ''),
          positionHint: typeof args.positionHint === 'string' ? args.positionHint : undefined,
        });
        return room
          ? { ok: true, roomId: room.id }
          : { ok: false, error: 'invalid feature payload' };
      }
      case 'set_user_location': {
        const room = setUserLocation({ room: String(args.room || '') });
        return room ? { ok: true, roomId: room.id } : { ok: false, error: 'invalid location payload' };
      }
      case 'log_scan_event': {
        const summary = String(args.summary || '').trim();
        if (!summary) {
          return { ok: false, error: 'missing summary' };
        }
        const confidence =
          typeof args.confidence === 'number'
            ? Math.max(0, Math.min(100, Math.round(args.confidence * 100)))
            : null;
        addEvent(
          confidence === null ? summary : `${summary} (${confidence}% confidence)`,
          'inference',
        );
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown tool ${functionCall?.name || 'unknown'}` };
    }
  } finally {
    renderRooms();
  }
}

function flushAssistantDraft() {
  const text = state.assistantDraft.trim();
  if (!text) {
    return;
  }
  state.assistantDraft = '';
  addMessage('model', text);
}

function appendAssistantChunk(chunk) {
  if (!chunk || !chunk.trim()) {
    return;
  }
  if (state.assistantDraft.endsWith(chunk)) {
    return;
  }
  state.assistantDraft += chunk;
  renderConversation();
}

function base64ToUint8Array(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i += 1) {
    bytes[i] = binString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function downsampleFloat32(input, inputRate, targetRate) {
  if (targetRate >= inputRate) {
    return input;
  }

  const ratio = inputRate / targetRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    output[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return output;
}

function floatTo16BitPcmBase64(floatSamples, inputRate, targetRate) {
  const mono = downsampleFloat32(floatSamples, inputRate, targetRate);
  const pcmBytes = new Uint8Array(mono.length * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let i = 0; i < mono.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(i * 2, int16, true);
  }
  return uint8ArrayToBase64(pcmBytes);
}

function parseMimeSampleRate(mimeType, fallbackRate) {
  if (typeof mimeType !== 'string') {
    return fallbackRate;
  }
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  if (!rateMatch) {
    return fallbackRate;
  }
  const parsed = Number(rateMatch[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackRate;
}

function getPlaybackContext() {
  if (!state.playbackContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      throw new Error('Web Audio API is unavailable in this browser.');
    }
    state.playbackContext = new Context();
    state.playbackCursorTime = state.playbackContext.currentTime;
  }
  return state.playbackContext;
}

async function ensurePlaybackContextResumed() {
  const context = getPlaybackContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
  return context;
}

function stopPlaybackQueue() {
  for (const source of state.playbackSources) {
    try {
      source.stop();
    } catch (_error) {
      // no-op
    }
  }
  state.playbackSources.clear();
  if (state.playbackContext) {
    state.playbackCursorTime = state.playbackContext.currentTime;
  }
}

function enqueueModelAudio(base64Data, mimeType = `audio/pcm;rate=${AUDIO_CHUNK_SAMPLE_RATE}`) {
  if (!els.voiceToggle.checked || !base64Data) {
    return;
  }

  try {
    const context = getPlaybackContext();
    if (context.state === 'suspended') {
      return;
    }

    const bytes = base64ToUint8Array(base64Data);
    if (bytes.length < 2) {
      return;
    }

    const sampleRate = parseMimeSampleRate(mimeType, AUDIO_CHUNK_SAMPLE_RATE);
    const sampleCount = Math.floor(bytes.length / 2);
    state.debug.audioOutChunks += 1;
    state.debug.audioOutSeconds += sampleCount / sampleRate;
    const floatSamples = new Float32Array(sampleCount);
    const pcmView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < sampleCount; i += 1) {
      floatSamples[i] = pcmView.getInt16(i * 2, true) / 0x8000;
    }

    const audioBuffer = context.createBuffer(1, floatSamples.length, sampleRate);
    audioBuffer.copyToChannel(floatSamples, 0);

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const now = context.currentTime + 0.03;
    const startAt = Math.max(now, state.playbackCursorTime);
    source.start(startAt);
    state.playbackCursorTime = startAt + audioBuffer.duration;
    state.playbackSources.add(source);
    source.onended = () => {
      state.playbackSources.delete(source);
    };
    renderDebugPanel();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to play model audio chunk.';
    debugLog('audio-error', message);
  }
}

async function startMicrophoneStream() {
  if (state.micStream && state.micContext) {
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) {
    throw new Error('Web Audio API is unavailable in this browser.');
  }

  const context = new Context();
  await context.resume();

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(MIC_PROCESSOR_BUFFER_SIZE, 1, 1);
  const silenceGain = context.createGain();
  silenceGain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (!state.connected || !state.session) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    if (!input || input.length === 0) {
      return;
    }
    const base64 = floatTo16BitPcmBase64(input, context.sampleRate, MIC_TARGET_SAMPLE_RATE);
    state.debug.audioInChunks += 1;
    state.session.sendRealtimeInput({
      audio: {
        mimeType: `audio/pcm;rate=${MIC_TARGET_SAMPLE_RATE}`,
        data: base64,
      },
    });
  };

  source.connect(processor);
  processor.connect(silenceGain);
  silenceGain.connect(context.destination);

  state.micStream = stream;
  state.micContext = context;
  state.micSourceNode = source;
  state.micProcessorNode = processor;
  state.micSilenceGainNode = silenceGain;
}

function stopMicrophoneStream() {
  if (state.session && state.connected) {
    try {
      state.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (_error) {
      // no-op
    }
  }

  if (state.micProcessorNode) {
    state.micProcessorNode.onaudioprocess = null;
    try {
      state.micProcessorNode.disconnect();
    } catch (_error) {
      // no-op
    }
  }
  if (state.micSourceNode) {
    try {
      state.micSourceNode.disconnect();
    } catch (_error) {
      // no-op
    }
  }
  if (state.micSilenceGainNode) {
    try {
      state.micSilenceGainNode.disconnect();
    } catch (_error) {
      // no-op
    }
  }
  if (state.micContext) {
    state.micContext.close().catch(() => {});
  }
  if (state.micStream) {
    for (const track of state.micStream.getTracks()) {
      track.stop();
    }
  }

  state.micContext = null;
  state.micSourceNode = null;
  state.micProcessorNode = null;
  state.micSilenceGainNode = null;
  state.micStream = null;
}

async function startCamera() {
  if (state.videoStream) {
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  state.videoStream = stream;
  els.cameraVideo.srcObject = stream;
  await els.cameraVideo.play();
}

function stopCamera() {
  if (!state.videoStream) {
    return;
  }
  for (const track of state.videoStream.getTracks()) {
    track.stop();
  }
  state.videoStream = null;
  els.cameraVideo.srcObject = null;
}

function sendCurrentVideoFrame() {
  if (!state.connected || !state.session) {
    return;
  }

  const video = els.cameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    return;
  }

  const width = 512;
  const height = Math.max(288, Math.round((video.videoHeight / video.videoWidth) * width));
  captureCanvas.width = width;
  captureCanvas.height = height;
  captureCtx.drawImage(video, 0, 0, width, height);

  const base64 = captureCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
  state.session.sendRealtimeInput({
    video: {
      mimeType: 'image/jpeg',
      data: base64,
    },
  });

  state.framesSent += 1;
  els.frameCounter.textContent = `${state.framesSent} frames sent`;
}

function startFramePump() {
  if (state.frameTimer) {
    clearInterval(state.frameTimer);
  }
  state.frameTimer = setInterval(sendCurrentVideoFrame, FRAME_SEND_INTERVAL_MS);
}

function stopFramePump() {
  if (!state.frameTimer) {
    return;
  }
  clearInterval(state.frameTimer);
  state.frameTimer = null;
}

function submitUserText(rawText, source = 'typed') {
  const text = rawText.trim();
  if (!text) {
    return;
  }

  addMessage('user', text);
  addEvent(`You (${source}): ${text}`, 'input');
  autoMapFromTranscript(text, source);

  if (!state.session) {
    setStatus('error', 'No live session. Start scan first.');
    return;
  }

  debugLog('input', `User text (${source})`, { text });
  state.session.sendRealtimeInput({ text });
}

function normalizeModelName(modelName) {
  return String(modelName || '').replace(/^models\//, '').trim();
}

function normalizeModelForAudioRuntime(modelName) {
  const chosen = normalizeModelName(modelName);
  const recommended =
    normalizeModelName(state.modelSupport.recommended) || AUDIO_FALLBACK_MODEL;
  if (!chosen) {
    return recommended;
  }

  const available = state.modelSupport.available.map(normalizeModelName).filter(Boolean);
  const hasCatalog = available.length > 0;
  const isAvailable = !hasCatalog || available.includes(chosen);

  if (!isAvailable) {
    addEvent(
      `Model "${chosen}" is unavailable on this API key. Using "${recommended}".`,
      'system',
    );
    debugLog('model', 'Switched unsupported model to recommended', {
      requestedModel: chosen,
      available,
      fallbackModel: recommended,
    });
    return recommended;
  }

  return chosen;
}

async function fetchConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) {
    throw new Error('Failed to load server config');
  }
  return response.json();
}

async function fetchLiveModels() {
  const response = await fetch('/api/live-models');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load live model list');
  }
  return payload;
}

async function createLiveSession() {
  const requestedModel = normalizeModelForAudioRuntime(els.modelInput.value);
  const tokenResponse = await fetch(`/api/token?model=${encodeURIComponent(requestedModel)}`);
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(tokenPayload.error || 'Could not create token');
  }

  if (els.modelInput.value.trim() !== tokenPayload.model) {
    els.modelInput.value = tokenPayload.model;
  }

  state.ai = new GoogleGenAI({
    apiKey: tokenPayload.token,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  const session = await state.ai.live.connect({
    model: tokenPayload.model,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      temperature: 0.6,
      systemInstruction: LIVE_SYSTEM_PROMPT,
      tools: [
        {
          functionDeclarations: TOOL_DECLARATIONS,
        },
      ],
    },
    callbacks: {
      onopen: () => {
        setStatus('live', 'Connected. Speak and walk naturally.');
        debugLog('session', 'Live session opened', { model: tokenPayload.model });
      },
      onmessage: (message) => {
        const functionCalls =
          message?.toolCall?.functionCalls ||
          message?.toolcall?.functionCalls ||
          message?.serverContent?.toolCall?.functionCalls ||
          [];

        if (message?.goAway) {
          debugLog('session', 'Server sent goAway', message.goAway);
          addEvent('Server requested session wind-down (goAway).', 'system');
        }

        if (message?.serverContent?.interrupted) {
          stopPlaybackQueue();
          addEvent('Model response interrupted by new speech input.', 'system');
        }

        const modelParts = message?.serverContent?.modelTurn?.parts || [];
        for (const part of modelParts) {
          if (part?.inlineData?.data) {
            enqueueModelAudio(part.inlineData.data, part.inlineData.mimeType);
          }
        }

        if (message?.serverContent?.outputTranscription?.text) {
          const transcript = message.serverContent.outputTranscription.text;
          state.debug.lastOutputTranscript = transcript;
          appendAssistantChunk(transcript);
          if (functionCalls.length === 0) {
            autoMapFromTranscript(transcript, 'model-output');
          }
          renderDebugPanel();
        }

        if (message?.serverContent?.inputTranscription?.text) {
          const transcript = message.serverContent.inputTranscription.text;
          state.debug.lastInputTranscript = transcript;
          els.interimSpeech.textContent = transcript;
          autoMapFromTranscript(transcript, 'user-input');
          renderDebugPanel();
        }

        if (functionCalls.length > 0) {
          debugLog('session', 'Received tool calls', {
            count: functionCalls.length,
          });
          const responses = [];
          for (const functionCall of functionCalls) {
            const output = applyToolCall(functionCall);
            responses.push({
              id: functionCall.id,
              name: functionCall.name,
              response: { output },
            });
          }
          if (responses.length > 0 && state.session) {
            debugLog('tool-response', 'Sent tool responses', { responses });
            state.session.sendToolResponse({ functionResponses: responses });
          }
        }

        if (message?.serverContent?.turnComplete) {
          flushAssistantDraft();
          els.interimSpeech.textContent = '';
        }
      },
      onerror: (error) => {
        const msg = error?.message || 'Live session error';
        setStatus('error', msg);
        addEvent(`Live API error: ${msg}`, 'system');
        debugLog('session-error', msg, {
          name: error?.name,
          message: error?.message,
        });
      },
      onclose: (event) => {
        const closeCode = event?.code ?? null;
        const closeReason = event?.reason || 'no reason provided';
        addEvent(
          `Live session closed (code ${closeCode ?? 'n/a'}: ${closeReason}).`,
          'system',
        );
        debugLog('session', 'Live session closed', {
          code: closeCode,
          reason: closeReason,
          wasClean: event?.wasClean ?? null,
        });
        teardownSession();
        setStatus('idle', DEFAULT_STATUS);
      },
    },
  });

  return { session, model: tokenPayload.model, expiresAt: tokenPayload.expiresAt };
}

function teardownSession() {
  state.connected = false;
  stopFramePump();
  stopMicrophoneStream();
  stopPlaybackQueue();
  stopCamera();
  flushAssistantDraft();

  const session = state.session;
  state.session = null;
  state.ai = null;

  if (session) {
    try {
      session.close();
    } catch (_error) {
      // no-op
    }
  }

  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
}

async function startScan() {
  if (state.connected) {
    return;
  }

  els.startBtn.disabled = true;
  setStatus('idle', 'Requesting camera and mic access...');

  try {
    state.debug.autoMapActions = 0;
    state.debug.audioInChunks = 0;
    state.debug.audioOutChunks = 0;
    state.debug.audioOutSeconds = 0;
    state.debug.lastInputTranscript = '';
    state.debug.lastOutputTranscript = '';
    state.parser.recentSignatures = [];
    renderDebugPanel();

    await startCamera();
    await startMicrophoneStream();
    await ensurePlaybackContextResumed();
    const { session, model, expiresAt } = await createLiveSession();
    state.session = session;
    state.connected = true;
    state.framesSent = 0;
    debugLog('session', 'Starting scan session');

    els.frameCounter.textContent = '0 frames sent';
    els.stopBtn.disabled = false;

    startFramePump();

    addMessage('system', `Live scan started with ${model}.`);
    addEvent(`Ephemeral session valid until ${new Date(expiresAt).toLocaleTimeString()}`, 'system');

    const homeLabel = els.homeLabelInput.value.trim();
    const contextPrefix = homeLabel ? `Home context: ${homeLabel}. ` : '';
    session.sendClientContent({
      turns: `${contextPrefix}Start the walkthrough now. Greet the user and ask where they are standing first.`,
      turnComplete: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start scan.';
    teardownSession();
    setStatus('error', message);
    addEvent(`Start failed: ${message}`, 'system');
    debugLog('session-error', 'Start failed', { message });
  }
}

function stopScan() {
  addEvent('Scan stopped by user.', 'system');
  debugLog('session', 'Scan stopped by user');
  teardownSession();
  setStatus('idle', DEFAULT_STATUS);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function simulateLayout() {
  const rooms = [...state.home.rooms.values()];
  if (rooms.length < 2) {
    return;
  }

  const centerX = els.floorCanvas.width / 2;
  const centerY = els.floorCanvas.height / 2;

  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i];
      const b = rooms[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy + 0.1;
      const force = 2800 / distSq;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      a.vx -= nx * force;
      a.vy -= ny * force;
      b.vx += nx * force;
      b.vy += ny * force;
    }
  }

  for (const edge of state.home.edges) {
    const from = state.home.rooms.get(edge.fromId);
    const to = state.home.rooms.get(edge.toId);
    if (!from || !to) {
      continue;
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = dist - ROOM_LINK_DISTANCE;
    const spring = 0.010;
    const nx = dx / dist;
    const ny = dy / dist;

    from.vx += nx * stretch * spring;
    from.vy += ny * stretch * spring;
    to.vx -= nx * stretch * spring;
    to.vy -= ny * stretch * spring;

    if (edge.anchorFromId && edge.anchorDirection) {
      const anchor = state.home.rooms.get(edge.anchorFromId);
      if (!anchor) {
        continue;
      }
      const otherId = edge.fromId === anchor.id ? edge.toId : edge.fromId;
      const other = state.home.rooms.get(otherId);
      const vector = CARDINAL_VECTORS[edge.anchorDirection];
      if (!other || !vector) {
        continue;
      }

      const desiredX = anchor.x + vector.x * ROOM_LINK_DISTANCE;
      const desiredY = anchor.y + vector.y * ROOM_LINK_DISTANCE;
      const driftX = desiredX - other.x;
      const driftY = desiredY - other.y;

      other.vx += driftX * 0.022;
      other.vy += driftY * 0.022;
      anchor.vx -= driftX * 0.004;
      anchor.vy -= driftY * 0.004;
    }
  }

  for (const room of rooms) {
    room.vx += (centerX - room.x) * 0.0010;
    room.vy += (centerY - room.y) * 0.0010;
    room.vx *= 0.84;
    room.vy *= 0.84;
    room.x += room.vx;
    room.y += room.vy;

    const clamped = clampToCanvas(room.x, room.y, 70, 60);
    room.x = clamped.x;
    room.y = clamped.y;
  }
}

function drawFloorGraph() {
  const width = els.floorCanvas.width;
  const height = els.floorCanvas.height;
  floorCtx.clearRect(0, 0, width, height);

  floorCtx.fillStyle = '#f4fbf8';
  floorCtx.fillRect(0, 0, width, height);

  floorCtx.strokeStyle = 'rgba(7, 105, 98, 0.08)';
  floorCtx.lineWidth = 1;
  for (let x = 0; x <= width; x += 40) {
    floorCtx.beginPath();
    floorCtx.moveTo(x, 0);
    floorCtx.lineTo(x, height);
    floorCtx.stroke();
  }
  for (let y = 0; y <= height; y += 40) {
    floorCtx.beginPath();
    floorCtx.moveTo(0, y);
    floorCtx.lineTo(width, y);
    floorCtx.stroke();
  }

  simulateLayout();

  floorCtx.font = '600 12px Sora';
  floorCtx.textAlign = 'center';
  floorCtx.textBaseline = 'middle';

  for (const edge of state.home.edges) {
    const from = state.home.rooms.get(edge.fromId);
    const to = state.home.rooms.get(edge.toId);
    if (!from || !to) {
      continue;
    }

    floorCtx.strokeStyle = 'rgba(24, 103, 178, 0.45)';
    floorCtx.lineWidth = 3;
    floorCtx.beginPath();
    floorCtx.moveTo(from.x, from.y);
    floorCtx.lineTo(to.x, to.y);
    floorCtx.stroke();

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    floorCtx.fillStyle = '#24587a';
    const directionLabel = edge.anchorDirection ? ` · ${edge.anchorDirection}` : '';
    floorCtx.fillText(`${edge.pathType || 'path'}${directionLabel}`, midX, midY - 10);
  }

  for (const room of state.home.rooms.values()) {
    const pulse = room.id === state.home.locationRoomId ? 10 + Math.sin(Date.now() / 180) * 3 : 0;

    const label = room.name;
    const roomType = room.roomType || 'room';
    const confidence = `${Math.max(0, Math.min(100, Math.round((room.confidence || 0) * 100)))}%`;
    floorCtx.font = '700 13px Sora';
    const widthPx = Math.max(122, floorCtx.measureText(label).width + 46);
    const heightPx = 56;

    const ageMs = Date.now() - (room.spawnedAt || room.createdAt || Date.now());
    const t = Math.max(0, Math.min(1, ageMs / 420));
    const scale = 0.82 + (1 - Math.pow(1 - t, 3)) * 0.18;

    if (pulse > 0) {
      floorCtx.fillStyle = 'rgba(15, 157, 135, 0.12)';
      floorCtx.beginPath();
      floorCtx.arc(room.x, room.y, 40 + pulse, 0, Math.PI * 2);
      floorCtx.fill();
    }

    floorCtx.save();
    floorCtx.translate(room.x, room.y);
    floorCtx.scale(scale, scale);

    drawRoundedRect(floorCtx, -widthPx / 2, -heightPx / 2, widthPx, heightPx, 14);

    const highlighted = room.highlightedUntil && room.highlightedUntil > Date.now();
    const isCurrent = room.id === state.home.locationRoomId;
    floorCtx.fillStyle = isCurrent ? '#dcfff3' : '#ffffff';
    floorCtx.fill();

    floorCtx.strokeStyle = isCurrent ? '#0f9d87' : highlighted ? '#2ea58f' : '#94b9ae';
    floorCtx.lineWidth = isCurrent || highlighted ? 2.2 : 1.4;
    floorCtx.stroke();

    floorCtx.fillStyle = '#153632';
    floorCtx.font = '700 13px Sora';
    floorCtx.fillText(label, 0, -9);

    floorCtx.fillStyle = '#3f6b64';
    floorCtx.font = '500 11px "Space Grotesk"';
    floorCtx.fillText(`${roomType} · ${confidence}`, 0, 10);

    floorCtx.restore();
  }

  floorCtx.textAlign = 'left';
  floorCtx.fillStyle = '#3f6f67';
  floorCtx.font = '700 12px Sora';
  floorCtx.fillText(
    `Heading-aware rough graph. Current heading: ${state.home.heading}.`,
    14,
    height - 18,
  );
}

function animationLoop() {
  drawFloorGraph();
  requestAnimationFrame(animationLoop);
}

function bindEvents() {
  els.startBtn.addEventListener('click', startScan);
  els.stopBtn.addEventListener('click', stopScan);

  els.sendBtn.addEventListener('click', () => {
    submitUserText(els.manualInput.value, 'typed');
    els.manualInput.value = '';
    els.manualInput.focus();
  });

  els.manualInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    els.sendBtn.click();
  });

  if (els.voiceToggle) {
    els.voiceToggle.addEventListener('change', async () => {
      if (els.voiceToggle.checked) {
        try {
          await ensurePlaybackContextResumed();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Audio playback unavailable.';
          debugLog('audio-error', message);
        }
      } else {
        stopPlaybackQueue();
      }
    });
  }

  if (els.debugToggle) {
    els.debugToggle.checked = state.debug.enabled;
    els.debugToggle.addEventListener('change', () => {
      state.debug.enabled = Boolean(els.debugToggle.checked);
      renderDebugPanel();
    });
  }

  if (els.exportSvgBtn) {
    els.exportSvgBtn.addEventListener('click', () => {
      const svg = generateFloorPlanSVG(state.home, { debug: state.debug.enabled, animate: false });
      downloadFile(svg, `floor-plan-${Date.now()}.svg`);
      debugLog('export', 'Downloaded SVG floor plan');
    });
  }

  if (els.exportPngBtn) {
    els.exportPngBtn.addEventListener('click', async () => {
      try {
        const svg = generateFloorPlanSVG(state.home, { debug: false, animate: false });
        const pngUrl = await svgToPng(svg, 2);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = `floor-plan-${Date.now()}.png`;
        a.click();
        debugLog('export', 'Downloaded PNG floor plan');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'PNG export failed';
        debugLog('export-error', msg);
      }
    });
  }

  window.addEventListener('beforeunload', teardownSession);
}

async function bootstrap() {
  bindEvents();
  animationLoop();
  renderTimeline();
  renderRooms();
  renderConversation();
  renderDebugPanel();

  setStatus('idle', DEFAULT_STATUS);

  try {
    const config = await fetchConfig();
    els.modelInput.value = normalizeModelName(config.defaultModel) || '';
    if (!config.hasApiKey) {
      setStatus('error', 'Server has no GEMINI_API_KEY. Add it in .env and restart.');
      addEvent('Missing GEMINI_API_KEY on server.', 'system');
      return;
    }

    try {
      const modelData = await fetchLiveModels();
      state.modelSupport.available = Array.isArray(modelData.models)
        ? modelData.models.map(normalizeModelName).filter(Boolean)
        : [];
      state.modelSupport.recommended = normalizeModelName(modelData.recommendedModel);

      if (state.modelSupport.recommended) {
        els.modelInput.value = state.modelSupport.recommended;
      }

      debugLog('model', 'Loaded supported bidi models', {
        available: state.modelSupport.available,
        recommended: state.modelSupport.recommended,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live model list unavailable';
      addEvent(message, 'system');
      debugLog('model-error', message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Config load failed';
    setStatus('error', message);
    addEvent(message, 'system');
  }
}

bootstrap();
