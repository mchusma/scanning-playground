/**
 * SVG Floor Plan Generator
 *
 * Takes the home state (rooms Map + edges array) and produces a standalone SVG string.
 * Designed to be renderable in <img>, UIImageView, Android ImageView, or inline DOM.
 *
 * Debug mode adds data attributes, room IDs, coordinate labels, and edge metadata
 * as SVG comments and semi-transparent overlays.
 */

// ── Room type → fill color ──────────────────────────────────────────────────
const ROOM_COLORS = {
  kitchen: { fill: '#fef3e2', stroke: '#c8956c', icon: '\u{1F373}' }, // 🍳
  bathroom: { fill: '#e2f0fe', stroke: '#6c9dc8', icon: '\u{1F6BF}' }, // 🚿
  bedroom: { fill: '#eee2fe', stroke: '#8e6cc8', icon: '\u{1F6CF}' }, // 🛏
  'primary bedroom': { fill: '#eee2fe', stroke: '#8e6cc8', icon: '\u{1F6CF}' },
  'guest bedroom': { fill: '#eee2fe', stroke: '#8e6cc8', icon: '\u{1F6CF}' },
  office: { fill: '#e2feec', stroke: '#6cc88e', icon: '\u{1F4BB}' }, // 💻
  'home office': { fill: '#e2feec', stroke: '#6cc88e', icon: '\u{1F4BB}' },
  'living room': { fill: '#fefee2', stroke: '#c8c86c', icon: '\u{1F6CB}' }, // 🛋
  'family room': { fill: '#fefee2', stroke: '#c8c86c', icon: '\u{1F6CB}' },
  'dining room': { fill: '#fef2e2', stroke: '#c8a06c', icon: '\u{1F37D}' }, // 🍽
  hallway: { fill: '#f0f0f0', stroke: '#999999', icon: '' },
  entryway: { fill: '#f0f0f0', stroke: '#999999', icon: '\u{1F6AA}' }, // 🚪
  garage: { fill: '#e8e8e8', stroke: '#888888', icon: '\u{1F697}' }, // 🚗
  laundry: { fill: '#e2f8fe', stroke: '#6cb8c8', icon: '' },
  'laundry room': { fill: '#e2f8fe', stroke: '#6cb8c8', icon: '' },
  pantry: { fill: '#fef8e2', stroke: '#c8b86c', icon: '' },
  closet: { fill: '#f5f0f0', stroke: '#aa9999', icon: '' },
  basement: { fill: '#e8e4e0', stroke: '#8a8580', icon: '' },
  attic: { fill: '#f0ece8', stroke: '#a09890', icon: '' },
  den: { fill: '#fefee2', stroke: '#c8c86c', icon: '' },
  patio: { fill: '#e8fee8', stroke: '#88bb88', icon: '' },
  balcony: { fill: '#e8fee8', stroke: '#88bb88', icon: '' },
  mudroom: { fill: '#f0ece8', stroke: '#a09890', icon: '' },
  utility: { fill: '#e8e8e8', stroke: '#888888', icon: '' },
};

const DEFAULT_ROOM_COLOR = { fill: '#f8f8f8', stroke: '#aaaaaa', icon: '' };

// ── Room sizing (pixels in SVG coordinate space) ────────────────────────────
const ROOM_WIDTH = 140;
const ROOM_HEIGHT = 90;
const WALL_THICKNESS = 3;
const DOOR_WIDTH = 28;
const DOOR_ARC_RADIUS = 24;
const PADDING = 40;

// ── SVG icon paths (simple architectural symbols, no emoji) ─────────────────
const ICON_PATHS = {
  kitchen: '<path d="M-6,-6 L-6,6 L6,6 L6,-6 Z M-3,-3 L-3,3 M0,-3 L0,3 M3,-3 L3,3" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  bathroom: '<circle cx="0" cy="-2" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-3,2 L3,2 L2,6 L-2,6 Z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  bedroom: '<rect x="-7" y="-4" width="14" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="-7" y="-4" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1"/>',
  office: '<rect x="-6" y="-5" width="12" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="-3" y1="4" x2="3" y2="4" stroke="currentColor" stroke-width="1.2"/>',
  'living room': '<path d="M-7,-3 L-7,4 L7,4 L7,-3 M-7,-3 C-7,-3 -5,-5 0,-5 C5,-5 7,-3 7,-3" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  garage: '<rect x="-7" y="-4" width="14" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-5,4 L-5,-1 L5,-1 L5,4" fill="none" stroke="currentColor" stroke-width="1"/>',
  entryway: '<path d="M-4,-6 L-4,6 L4,6 L4,-6 Z M-2,-6 L-2,4 Q-2,5 -1,5 L1,5 Q2,5 2,4 L2,-6" fill="none" stroke="currentColor" stroke-width="1.2"/>',
};

/**
 * Escape text for safe SVG embedding
 */
function escSvg(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Get color config for a room type
 */
function getRoomColor(roomType) {
  if (!roomType) return DEFAULT_ROOM_COLOR;
  const key = roomType.toLowerCase().trim();
  return ROOM_COLORS[key] || DEFAULT_ROOM_COLOR;
}

/**
 * Find which wall a door should be on, based on the edge direction.
 * Returns { wall: 'north'|'south'|'east'|'west', position: 0-1 along that wall }
 */
function getDoorWall(room, otherRoom, edge) {
  // Use anchor direction if available
  if (edge.anchorFromId === room.id && edge.anchorDirection) {
    return { wall: edge.anchorDirection, position: 0.5 };
  }
  if (edge.anchorFromId === otherRoom.id && edge.anchorDirection) {
    const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
    return { wall: opposite[edge.anchorDirection] || 'north', position: 0.5 };
  }

  // Fall back to geometric direction
  const dx = otherRoom.x - room.x;
  const dy = otherRoom.y - room.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { wall: dx > 0 ? 'east' : 'west', position: 0.5 };
  }
  return { wall: dy > 0 ? 'south' : 'north', position: 0.5 };
}

/**
 * Get the SVG coordinates for a door opening on a room's wall
 */
function getDoorPosition(roomX, roomY, wall, position) {
  const halfW = ROOM_WIDTH / 2;
  const halfH = ROOM_HEIGHT / 2;
  const offset = (position - 0.5) * (wall === 'north' || wall === 'south' ? ROOM_WIDTH : ROOM_HEIGHT) * 0.6;

  switch (wall) {
    case 'north':
      return { x: roomX + offset, y: roomY - halfH, angle: 0 };
    case 'south':
      return { x: roomX + offset, y: roomY + halfH, angle: 180 };
    case 'east':
      return { x: roomX + halfW, y: roomY + offset, angle: 90 };
    case 'west':
      return { x: roomX - halfW, y: roomY + offset, angle: 270 };
    default:
      return { x: roomX, y: roomY - halfH, angle: 0 };
  }
}

/**
 * Render a door arc symbol (architectural quarter-circle)
 * The white background rect "cuts" through the wall line visually
 */
function renderDoorArc(x, y, angle, pathType) {
  const r = DOOR_ARC_RADIUS;
  const halfDoor = DOOR_WIDTH / 2;

  // White gap to "cut" the wall (drawn on top of room rect border)
  const wallGap = `<rect x="${-halfDoor - 1}" y="${-WALL_THICKNESS}" width="${DOOR_WIDTH + 2}" height="${WALL_THICKNESS * 2 + 1}" fill="#f8faf9"/>`;

  // For archways/open-plan, use a dashed opening
  if (pathType === 'archway' || pathType === 'open-plan') {
    return `<g transform="translate(${x},${y}) rotate(${angle})" data-type="${escSvg(pathType)}">
      ${wallGap}
      <line x1="${-halfDoor}" y1="0" x2="${halfDoor}" y2="0" stroke="#aaa" stroke-width="1.5" stroke-dasharray="3,2"/>
    </g>`;
  }

  // For stairs, use a different symbol
  if (pathType === 'stairs') {
    return `<g transform="translate(${x},${y}) rotate(${angle})" data-type="stairs">
      ${wallGap}
      <line x1="${-halfDoor}" y1="0" x2="${-halfDoor}" y2="-3" stroke="#666" stroke-width="2" stroke-linecap="round"/>
      <line x1="${halfDoor}" y1="0" x2="${halfDoor}" y2="-3" stroke="#666" stroke-width="2" stroke-linecap="round"/>
      <line x1="${-halfDoor + 4}" y1="-1" x2="${halfDoor - 4}" y2="-1" stroke="#888" stroke-width="0.8"/>
      <line x1="${-halfDoor + 4}" y1="-4" x2="${halfDoor - 4}" y2="-4" stroke="#888" stroke-width="0.8"/>
      <line x1="${-halfDoor + 4}" y1="-7" x2="${halfDoor - 4}" y2="-7" stroke="#888" stroke-width="0.8"/>
    </g>`;
  }

  // Standard door: gap in wall + quarter-circle arc showing door swing
  return `<g transform="translate(${x},${y}) rotate(${angle})" data-type="door">
    ${wallGap}
    <line x1="${-halfDoor}" y1="0" x2="${-halfDoor}" y2="-3" stroke="#555" stroke-width="2" stroke-linecap="round"/>
    <line x1="${halfDoor}" y1="0" x2="${halfDoor}" y2="-3" stroke="#555" stroke-width="2" stroke-linecap="round"/>
    <path d="M ${-halfDoor} 0 A ${r} ${r} 0 0 1 ${-halfDoor + r} ${-r}" fill="none" stroke="#888" stroke-width="0.8" stroke-dasharray="2,2"/>
  </g>`;
}

/**
 * Compute the bounding box of all rooms, with padding
 */
function computeBounds(rooms) {
  if (rooms.length === 0) {
    return { minX: 0, minY: 0, maxX: 400, maxY: 300, width: 400, height: 300 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const room of rooms) {
    minX = Math.min(minX, room.x - ROOM_WIDTH / 2);
    minY = Math.min(minY, room.y - ROOM_HEIGHT / 2);
    maxX = Math.max(maxX, room.x + ROOM_WIDTH / 2);
    maxY = Math.max(maxY, room.y + ROOM_HEIGHT / 2);
  }

  minX -= PADDING;
  minY -= PADDING;
  maxX += PADDING;
  maxY += PADDING;

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Render a compass rose at a fixed position
 */
function renderCompass(x, y, heading) {
  const headingAngles = { north: 0, east: 90, south: 180, west: 270 };
  const rotation = headingAngles[heading] || 0;

  return `<g transform="translate(${x},${y})" class="compass">
    <circle r="20" fill="white" stroke="#ccc" stroke-width="1" opacity="0.9"/>
    <g transform="rotate(${-rotation})">
      <polygon points="0,-16 -4,-6 4,-6" fill="#d44" stroke="none"/>
      <polygon points="0,16 -4,6 4,6" fill="#ccc" stroke="none"/>
    </g>
    <text x="0" y="${-16 - 5}" text-anchor="middle" font-size="8" font-weight="700" fill="#d44" font-family="sans-serif">N</text>
    <text x="${20 + 5}" y="3" text-anchor="start" font-size="7" fill="#999" font-family="sans-serif">E</text>
    <text x="0" y="${16 + 10}" text-anchor="middle" font-size="7" fill="#999" font-family="sans-serif">S</text>
    <text x="${-20 - 5}" y="3" text-anchor="end" font-size="7" fill="#999" font-family="sans-serif">W</text>
  </g>`;
}

/**
 * Render the location indicator (person icon)
 */
function renderLocationMarker(x, y) {
  return `<g transform="translate(${x},${y + ROOM_HEIGHT / 2 - 16})" class="location-marker">
    <circle r="10" fill="rgba(15,157,135,0.15)" stroke="none">
      <animate attributeName="r" values="10;14;10" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/>
    </circle>
    <circle cx="0" cy="-3" r="3" fill="#0f9d87"/>
    <path d="M-4,2 Q0,7 4,2" fill="#0f9d87"/>
  </g>`;
}

/**
 * Main SVG generator.
 *
 * @param {object} homeState - { rooms: Map, edges: [], locationRoomId: string|null, heading: string }
 * @param {object} options
 * @param {boolean} options.debug - Show debug overlays (IDs, coordinates, edge data)
 * @param {boolean} options.animate - Include CSS animations
 * @param {string}  options.title - Optional title text
 * @returns {string} Complete SVG markup
 */
export function generateFloorPlanSVG(homeState, options = {}) {
  const { debug = false, animate = true, title = '' } = options;
  const rooms = [...homeState.rooms.values()];
  const edges = homeState.edges || [];
  const locationRoomId = homeState.locationRoomId || null;
  const heading = homeState.heading || 'north';

  if (rooms.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
      <rect width="400" height="200" fill="#f8faf9" rx="8"/>
      <text x="200" y="100" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#888">No rooms mapped yet</text>
    </svg>`;
  }

  const bounds = computeBounds(rooms);
  const svgWidth = Math.max(400, bounds.width);
  const svgHeight = Math.max(300, bounds.height);

  const parts = [];

  // ── SVG header ──────────────────────────────────────────────────────────
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">`);

  // ── Debug: metadata comment ─────────────────────────────────────────────
  if (debug) {
    parts.push(`<!-- SVG Floor Plan Debug Info -->`);
    parts.push(`<!-- Generated: ${new Date().toISOString()} -->`);
    parts.push(`<!-- Rooms: ${rooms.length}, Edges: ${edges.length} -->`);
    parts.push(`<!-- Bounds: ${JSON.stringify(bounds)} -->`);
    parts.push(`<!-- Location: ${locationRoomId || 'none'}, Heading: ${heading} -->`);
  }

  // ── Embedded styles ─────────────────────────────────────────────────────
  parts.push(`<defs><style>
    .room-label { font-family: -apple-system, 'Segoe UI', sans-serif; font-weight: 700; font-size: 13px; fill: #1a3330; }
    .room-type { font-family: -apple-system, 'Segoe UI', sans-serif; font-weight: 500; font-size: 10px; fill: #5a8880; }
    .room-features { font-family: -apple-system, 'Segoe UI', sans-serif; font-weight: 400; font-size: 9px; fill: #7a9a94; }
    .edge-label { font-family: -apple-system, 'Segoe UI', sans-serif; font-weight: 500; font-size: 9px; fill: #4a7a90; }
    .title-text { font-family: -apple-system, 'Segoe UI', sans-serif; font-weight: 700; font-size: 16px; fill: #1a3330; }
    ${debug ? `
    .debug-text { font-family: monospace; font-size: 8px; fill: #c44; opacity: 0.8; }
    .debug-coord { font-family: monospace; font-size: 7px; fill: #888; }
    ` : ''}
    ${animate ? `
    .room-rect { animation: roomFadeIn 0.5s ease-out both; }
    @keyframes roomFadeIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
    ` : ''}
  </style></defs>`);

  // ── Background ──────────────────────────────────────────────────────────
  parts.push(`<rect x="${bounds.minX}" y="${bounds.minY}" width="${svgWidth}" height="${svgHeight}" fill="#f8faf9" rx="0"/>`);

  // ── Grid pattern (clamped to viewBox) ───────────────────────────────────
  const gridSize = 40;
  const gridStartX = Math.ceil(bounds.minX / gridSize) * gridSize;
  const gridStartY = Math.ceil(bounds.minY / gridSize) * gridSize;
  const gridEndX = bounds.minX + svgWidth;
  const gridEndY = bounds.minY + svgHeight;
  parts.push(`<g class="grid" opacity="0.15">`);
  for (let gx = gridStartX; gx <= gridEndX; gx += gridSize) {
    parts.push(`<line x1="${gx}" y1="${bounds.minY}" x2="${gx}" y2="${gridEndY}" stroke="#0a6a60" stroke-width="0.5"/>`);
  }
  for (let gy = gridStartY; gy <= gridEndY; gy += gridSize) {
    parts.push(`<line x1="${bounds.minX}" y1="${gy}" x2="${gridEndX}" y2="${gy}" stroke="#0a6a60" stroke-width="0.5"/>`);
  }
  parts.push(`</g>`);

  // ── Title ───────────────────────────────────────────────────────────────
  if (title) {
    parts.push(`<text x="${bounds.minX + 12}" y="${bounds.minY + 20}" class="title-text">${escSvg(title)}</text>`);
  }

  // ── Pre-compute door positions per wall to avoid overlaps ────────────────
  // Track how many doors are on each wall of each room, so we can spread them
  const wallDoorCounts = new Map(); // "roomId:wall" → count
  function getWallKey(roomId, wall) { return `${roomId}:${wall}`; }
  function nextDoorPosition(roomId, wall) {
    const key = getWallKey(roomId, wall);
    const count = wallDoorCounts.get(key) || 0;
    wallDoorCounts.set(key, count + 1);
    // Spread doors evenly: for 1 door → 0.5, for 2 → 0.35/0.65, for 3 → 0.25/0.5/0.75
    const total = count + 1;
    // We don't know total ahead of time, so use a sliding approach
    // Position based on order: 0.5, 0.3, 0.7, 0.2, 0.8, ...
    const positions = [0.5, 0.3, 0.7, 0.2, 0.8, 0.15, 0.85];
    return positions[count] ?? 0.5;
  }

  // ── Edges (connections between rooms) ───────────────────────────────────
  parts.push(`<g class="edges">`);
  for (const edge of edges) {
    const fromRoom = homeState.rooms.get(edge.fromId);
    const toRoom = homeState.rooms.get(edge.toId);
    if (!fromRoom || !toRoom) continue;

    if (debug) {
      parts.push(`<!-- Edge: ${edge.fromId} -> ${edge.toId} | pathType: ${edge.pathType} | anchor: ${edge.anchorFromId}/${edge.anchorDirection} -->`);
    }

    // Door position on the "from" room wall (spread if multiple doors on same wall)
    const fromDoor = getDoorWall(fromRoom, toRoom, edge);
    const fromDoorPosition = nextDoorPosition(fromRoom.id, fromDoor.wall);
    const fromDoorPos = getDoorPosition(fromRoom.x, fromRoom.y, fromDoor.wall, fromDoorPosition);

    // Door position on the "to" room wall
    const toDoor = getDoorWall(toRoom, fromRoom, edge);
    const toDoorPosition = nextDoorPosition(toRoom.id, toDoor.wall);
    const toDoorPos = getDoorPosition(toRoom.x, toRoom.y, toDoor.wall, toDoorPosition);

    // Draw connection line between the two door positions (not room centers)
    parts.push(`<line x1="${fromDoorPos.x}" y1="${fromDoorPos.y}" x2="${toDoorPos.x}" y2="${toDoorPos.y}" stroke="rgba(24,103,178,0.15)" stroke-width="1" stroke-dasharray="4,4" data-edge="${escSvg(edge.key)}"/>`);

    // Edge label — position near the "from" door, offset away from the wall
    if (edge.pathType && edge.pathType !== 'path') {
      const labelX = (fromDoorPos.x + toDoorPos.x) / 2;
      const labelY = (fromDoorPos.y + toDoorPos.y) / 2;
      // Offset label perpendicular to the connection line
      const dx = toDoorPos.x - fromDoorPos.x;
      const dy = toDoorPos.y - fromDoorPos.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const offsetX = (-dy / len) * 10;
      const offsetY = (dx / len) * 10;
      parts.push(`<text x="${labelX + offsetX}" y="${labelY + offsetY}" text-anchor="middle" class="edge-label">${escSvg(edge.pathType)}</text>`);
    }

    // Door symbols on both room walls
    parts.push(renderDoorArc(fromDoorPos.x, fromDoorPos.y, fromDoorPos.angle, edge.pathType));
    parts.push(renderDoorArc(toDoorPos.x, toDoorPos.y, toDoorPos.angle, edge.pathType));
  }
  parts.push(`</g>`);

  // ── Rooms ───────────────────────────────────────────────────────────────
  parts.push(`<g class="rooms">`);
  for (const room of rooms) {
    const color = getRoomColor(room.roomType);
    const isCurrent = room.id === locationRoomId;
    const halfW = ROOM_WIDTH / 2;
    const halfH = ROOM_HEIGHT / 2;
    const rx = room.x - halfW;
    const ry = room.y - halfH;

    if (debug) {
      parts.push(`<!-- Room: ${room.id} | type: ${room.roomType} | pos: (${Math.round(room.x)}, ${Math.round(room.y)}) | confidence: ${room.confidence} | features: [${room.features.join(', ')}] -->`);
    }

    parts.push(`<g class="room" data-room-id="${escSvg(room.id)}" data-room-type="${escSvg(room.roomType || 'room')}">`);

    // Room fill
    parts.push(`<rect x="${rx}" y="${ry}" width="${ROOM_WIDTH}" height="${ROOM_HEIGHT}" rx="3" fill="${color.fill}" stroke="${isCurrent ? '#0f9d87' : color.stroke}" stroke-width="${isCurrent ? WALL_THICKNESS + 1 : WALL_THICKNESS}" class="room-rect"/>`);

    // Current location highlight
    if (isCurrent) {
      parts.push(`<rect x="${rx - 2}" y="${ry - 2}" width="${ROOM_WIDTH + 4}" height="${ROOM_HEIGHT + 4}" rx="5" fill="none" stroke="rgba(15,157,135,0.3)" stroke-width="2" stroke-dasharray="6,3">`);
      if (animate) {
        parts.push(`<animate attributeName="stroke-dashoffset" from="0" to="18" dur="1.5s" repeatCount="indefinite"/>`);
      }
      parts.push(`</rect>`);
    }

    // Layout: icon (top-left corner), name (centered), type+confidence, features
    // All text is centered on room.x to avoid overflow on long names
    const iconKey = room.roomType?.toLowerCase().trim();
    const iconSvg = ICON_PATHS[iconKey];

    // Vertical layout depends on whether we have features
    const hasFeatures = room.features && room.features.length > 0;
    const nameY = hasFeatures ? room.y - 12 : room.y - 8;
    const typeY = hasFeatures ? room.y + 2 : room.y + 6;
    const featY = room.y + 14;

    // Room icon (small, in top-left corner of room)
    if (iconSvg) {
      parts.push(`<g transform="translate(${rx + 14}, ${ry + 14})" color="${color.stroke}" opacity="0.5">${iconSvg}</g>`);
    }

    // Room name — always centered on room, with truncation for long names
    const maxLabelLen = Math.floor(ROOM_WIDTH / 8);
    const displayName = room.name.length > maxLabelLen ? room.name.slice(0, maxLabelLen - 1) + '\u2026' : room.name;
    parts.push(`<text x="${room.x}" y="${nameY}" text-anchor="middle" class="room-label">${escSvg(displayName)}</text>`);

    // Room type + confidence
    const confidence = Math.round((room.confidence || 0) * 100);
    parts.push(`<text x="${room.x}" y="${typeY}" text-anchor="middle" class="room-type">${escSvg(room.roomType || 'room')} \u00B7 ${confidence}%</text>`);

    // Features (up to 2, truncated to fit)
    if (hasFeatures) {
      const maxFeatLen = Math.floor(ROOM_WIDTH / 6);
      let featureText = room.features.slice(0, 2).join(', ');
      const extra = room.features.length > 2 ? ` +${room.features.length - 2}` : '';
      if (featureText.length + extra.length > maxFeatLen) {
        featureText = featureText.slice(0, maxFeatLen - extra.length - 1) + '\u2026';
      }
      parts.push(`<text x="${room.x}" y="${featY}" text-anchor="middle" class="room-features">${escSvg(featureText + extra)}</text>`);
    }

    // Location marker
    if (isCurrent) {
      parts.push(renderLocationMarker(room.x, room.y));
    }

    // Debug overlays
    if (debug) {
      parts.push(`<text x="${rx + 2}" y="${ry - 3}" class="debug-text">${escSvg(room.id)}</text>`);
      parts.push(`<text x="${rx + 2}" y="${ry + ROOM_HEIGHT + 10}" class="debug-coord">(${Math.round(room.x)}, ${Math.round(room.y)})</text>`);
    }

    parts.push(`</g>`);
  }
  parts.push(`</g>`);

  // ── Compass rose ────────────────────────────────────────────────────────
  parts.push(renderCompass(bounds.maxX - 30, bounds.minY + 30, heading));

  // ── Scale indicator ─────────────────────────────────────────────────────
  const scaleY = bounds.maxY - 12;
  const scaleX = bounds.minX + 12;
  parts.push(`<g class="scale-bar">
    <line x1="${scaleX}" y1="${scaleY}" x2="${scaleX + 60}" y2="${scaleY}" stroke="#888" stroke-width="1.5"/>
    <line x1="${scaleX}" y1="${scaleY - 4}" x2="${scaleX}" y2="${scaleY + 4}" stroke="#888" stroke-width="1.5"/>
    <line x1="${scaleX + 60}" y1="${scaleY - 4}" x2="${scaleX + 60}" y2="${scaleY + 4}" stroke="#888" stroke-width="1.5"/>
    <text x="${scaleX + 30}" y="${scaleY - 6}" text-anchor="middle" font-family="sans-serif" font-size="8" fill="#888">~10 ft</text>
  </g>`);

  // ── Debug: state dump ───────────────────────────────────────────────────
  if (debug) {
    parts.push(`<!-- === STATE DUMP === -->`);
    parts.push(`<!-- Rooms: -->`);
    for (const room of rooms) {
      parts.push(`<!-- ${room.id}: ${JSON.stringify({ x: Math.round(room.x), y: Math.round(room.y), type: room.roomType, confidence: room.confidence, features: room.features })} -->`);
    }
    parts.push(`<!-- Edges: -->`);
    for (const edge of edges) {
      parts.push(`<!-- ${edge.key}: ${JSON.stringify({ pathType: edge.pathType, anchorFrom: edge.anchorFromId, anchorDir: edge.anchorDirection })} -->`);
    }
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

/**
 * Convert SVG string to a data URL (for use in <img src>)
 */
export function svgToDataUrl(svgString) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
}

/**
 * Convert SVG to PNG via canvas (returns a Promise<string> with a data URL)
 */
export async function svgToPng(svgString, scale = 2) {
  const img = new Image();
  const svgUrl = svgToDataUrl(svgString);

  return new Promise((resolve, reject) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to load SVG for PNG conversion'));
    img.src = svgUrl;
  });
}

/**
 * Trigger a file download in the browser
 */
export function downloadFile(content, filename, mimeType = 'image/svg+xml') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Validate home state and return a diagnostics report.
 * Useful for debugging before/after SVG generation.
 */
export function diagnoseHomeState(homeState) {
  const issues = [];
  const rooms = homeState.rooms;
  const edges = homeState.edges || [];

  if (!rooms || rooms.size === 0) {
    issues.push({ level: 'warn', msg: 'No rooms in state' });
    return { ok: issues.length === 0, issues, roomCount: 0, edgeCount: 0 };
  }

  // Check for rooms with missing/invalid positions
  for (const [id, room] of rooms) {
    if (!Number.isFinite(room.x) || !Number.isFinite(room.y)) {
      issues.push({ level: 'error', msg: `Room "${id}" has invalid position: (${room.x}, ${room.y})` });
    }
    if (!room.name) {
      issues.push({ level: 'error', msg: `Room "${id}" has no name` });
    }
    if (room.confidence !== undefined && (room.confidence < 0 || room.confidence > 1)) {
      issues.push({ level: 'warn', msg: `Room "${id}" confidence out of range: ${room.confidence}` });
    }
  }

  // Check for edges referencing missing rooms
  for (const edge of edges) {
    if (!rooms.has(edge.fromId)) {
      issues.push({ level: 'error', msg: `Edge "${edge.key}" references missing room: ${edge.fromId}` });
    }
    if (!rooms.has(edge.toId)) {
      issues.push({ level: 'error', msg: `Edge "${edge.key}" references missing room: ${edge.toId}` });
    }
    if (edge.fromId === edge.toId) {
      issues.push({ level: 'warn', msg: `Edge "${edge.key}" is a self-loop` });
    }
  }

  // Check for overlapping rooms
  const roomList = [...rooms.values()];
  for (let i = 0; i < roomList.length; i++) {
    for (let j = i + 1; j < roomList.length; j++) {
      const a = roomList[i];
      const b = roomList[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < ROOM_WIDTH * 0.7 && dy < ROOM_HEIGHT * 0.7) {
        issues.push({ level: 'warn', msg: `Rooms "${a.id}" and "${b.id}" overlap significantly (dist: ${Math.round(dx)}, ${Math.round(dy)})` });
      }
    }
  }

  // Check for isolated rooms (no edges)
  const connectedRooms = new Set();
  for (const edge of edges) {
    connectedRooms.add(edge.fromId);
    connectedRooms.add(edge.toId);
  }
  for (const [id] of rooms) {
    if (!connectedRooms.has(id) && rooms.size > 1) {
      issues.push({ level: 'info', msg: `Room "${id}" has no connections` });
    }
  }

  return {
    ok: issues.filter(i => i.level === 'error').length === 0,
    issues,
    roomCount: rooms.size,
    edgeCount: edges.length,
    connectedRooms: connectedRooms.size,
    isolatedRooms: rooms.size - connectedRooms.size,
  };
}
