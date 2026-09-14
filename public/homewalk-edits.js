import { bounds, roomBox, dist } from './homewalk-geometry.js';

const EPS = 0.015;
const clone = value => structuredClone(value);
const finite = x => typeof x === 'number' && Number.isFinite(x);
export const boxPolygon = b => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
export function rectangle(room) {
  const p = room?.editedPolygon, b = bounds(p);
  if (!b || p.length !== 4 || p.some(v => !finite(v.x) || !finite(v.y)) || p.some(v => ![b.minX, b.maxX].some(x => Math.abs(x - v.x) < EPS) || ![b.minY, b.maxY].some(y => Math.abs(y - v.y) < EPS))) throw Error('This room needs a rectangular outline before using the simple wall editor.');
  return b;
}
export function inside(p, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
const axisOf = side => side.endsWith('X') ? 'x' : 'y';
const opposite = side => (side.startsWith('min') ? 'max' : 'min') + side.slice(3);
const sides = ['minX', 'maxX', 'minY', 'maxY'];
const overlap = (a, b, axis) => Math.min(a[`max${axis}`], b[`max${axis}`]) - Math.max(a[`min${axis}`], b[`min${axis}`]);
const areaOverlap = (a, b) => Math.max(0, overlap(a, b, 'X')) * Math.max(0, overlap(a, b, 'Y'));
const getRoom = (doc, id) => { const room = doc.rooms.find(r => r.id === id); if (!room) throw Error('Room no longer exists. Refresh the plan.'); return room; };
const validName = name => { if (typeof name !== 'string' || !name.trim() || name.length > 100) throw Error('Use a room name of 1–100 characters.'); return name.trim(); };

export function sharedEdges(doc, roomID, side, tolerance = EPS) {
  if (!sides.includes(side)) throw Error('Unknown wall.');
  const room = getRoom(doc, roomID), a = rectangle(room), otherSide = opposite(side), cross = axisOf(side) === 'x' ? 'Y' : 'X';
  return doc.rooms.filter(r => r.id !== roomID).flatMap(r => {
    let b; try { b = rectangle(r); } catch { return []; }
    return Math.abs(a[side] - b[otherSide]) <= tolerance && overlap(a, b, cross) > 0.3 ? [{ roomID: r.id, side: otherSide, gap: b[otherSide] - a[side] }] : [];
  });
}

function updateWall(doc, roomID, side, value) {
  if (!sides.includes(side) || !finite(value)) throw Error('Invalid wall position.');
  const root = rectangle(getRoom(doc, roomID));
  if (Math.abs(value - root[side]) > 5) throw Error('Move walls at most 5 metres per adjustment.');
  const queue = [{ roomID, side }], seen = new Set(), moves = [];
  while (queue.length) {
    const edge = queue.shift(), key = `${edge.roomID}:${edge.side}`;
    if (seen.has(key)) continue;
    seen.add(key); moves.push(edge);
    queue.push(...sharedEdges(doc, edge.roomID, edge.side));
  }
  for (const edge of moves) {
    const room = getRoom(doc, edge.roomID), b = rectangle(room), old = b[edge.side], axis = axisOf(edge.side);
    for (const door of doc.doorways ?? []) {
      if (door.wallRoomID === room.id && Math.abs(door.endpointA[axis] - old) < EPS && Math.abs(door.endpointB[axis] - old) < EPS) {
        door.endpointA[axis] = value; door.endpointB[axis] = value;
      }
    }
    b[edge.side] = value;
    if (b.maxX - b.minX < 0.8 || b.maxY - b.minY < 0.8) throw Error('This would collapse a neighboring room.');
    room.editedPolygon = boxPolygon(b); room.revision = (room.revision ?? 0) + 1;
  }
}

function remapRoomReferences(doc, oldID, newID) {
  for (const key of ['capturedItems', 'transcript', 'observations', 'features', 'openings']) {
    for (const item of doc[key] ?? []) {
      if (item.roomID === oldID) item.roomID = newID;
      if (item.roomId === oldID) item.roomId = newID;
    }
  }
  for (const door of doc.doorways ?? []) {
    door.connectedRoomIDs = [...new Set(door.connectedRoomIDs.map(id => id === oldID ? newID : id))];
    if (door.wallRoomID === oldID) door.wallRoomID = newID;
  }
}

function maintainDoors(doc) {
  for (const door of doc.doorways ?? []) {
    const room = getRoom(doc, door.wallRoomID), poly = room.editedPolygon;
    const center = { x: (door.endpointA.x + door.endpointB.x) / 2, y: (door.endpointA.y + door.endpointB.y) / 2 };
    let best;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const t = Math.max(0, Math.min(1, ((center.x - a.x) * dx + (center.y - a.y) * dy) / (len * len)));
      const p = { x: a.x + dx * t, y: a.y + dy * t }, distance = dist(p, center);
      if (!best || distance < best.distance) best = { i, a, b, dx, dy, len, t, distance };
    }
    if (!best || best.distance > 0.03 || best.len < door.width) throw Error('This would detach a doorway. Adjust the connected wall instead.');
    const half = door.width / (2 * best.len), t = Math.max(half, Math.min(1 - half, best.t));
    door.endpointA = { x: best.a.x + best.dx * (t - half), y: best.a.y + best.dy * (t - half) };
    door.endpointB = { x: best.a.x + best.dx * (t + half), y: best.a.y + best.dy * (t + half) };
    door.wallEdgeIndex = best.i;
    for (const id of door.connectedRoomIDs.filter(id => id !== room.id)) {
      const b = bounds(getRoom(doc, id).editedPolygon), axis = Math.abs(best.dx) < EPS ? 'x' : 'y', cross = axis === 'x' ? 'y' : 'x';
      if (Math.min(Math.abs(door.endpointA[axis] - b[`min${axis.toUpperCase()}`]), Math.abs(door.endpointA[axis] - b[`max${axis.toUpperCase()}`])) > 0.03 || Math.min(door.endpointA[cross], door.endpointB[cross]) < b[`min${cross.toUpperCase()}`] - EPS || Math.max(door.endpointA[cross], door.endpointB[cross]) > b[`max${cross.toUpperCase()}`] + EPS) throw Error('The doorway must remain attached to both rooms.');
    }
  }
}

export function applyEdits(original, operations) {
  if (!Array.isArray(operations) || operations.length > 24) throw Error('Too many changes in one revision.');
  const doc = clone(original);
  for (const op of operations) {
    const room = getRoom(doc, op.roomID);
    if (op.type === 'renameRoom') { room.name = validName(op.name); room.revision++; continue; }
    const b = rectangle(room);
    if (op.type === 'moveWall') updateWall(doc, room.id, op.side, op.value);
    else if (op.type === 'moveRoom') {
      if (![op.dx, op.dy].every(finite) || Math.hypot(op.dx, op.dy) > 5) throw Error('Move a room at most 5 metres per revision.');
      // Move each boundary together with its attached neighbors.
      // Expand the leading boundary before moving the trailing boundary. A
      // valid translation larger than the room width must not temporarily
      // collapse the room halfway through this atomic operation.
      const order = [...(op.dx >= 0 ? ['maxX', 'minX'] : ['minX', 'maxX']),
        ...(op.dy >= 0 ? ['maxY', 'minY'] : ['minY', 'maxY'])];
      for (const side of order) updateWall(doc, room.id, side, b[side] + (axisOf(side) === 'x' ? op.dx : op.dy));
    } else if (op.type === 'joinRooms') {
      const target = getRoom(doc, op.otherRoomID), n = rectangle(target);
      if (room.id === target.id) throw Error('Choose two different rooms.');
      const candidates = sides.map(side => ({ side, gap: Math.abs(b[side] - n[opposite(side)]), cross: axisOf(side) === 'x' ? 'Y' : 'X' }))
        .filter(c => c.gap <= 0.75 && overlap(b, n, c.cross) > 0.8).sort((a, b) => a.gap - b.gap);
      if (!candidates.length) throw Error('These rooms are too far apart to snap. Move them closer first.');
      const side = candidates[0].side, value = (b[side] + n[opposite(side)]) / 2;
      updateWall(doc, room.id, side, value); updateWall(doc, target.id, opposite(side), value);
    } else if (op.type === 'mergeRooms') {
      const other = getRoom(doc, op.otherRoomID), n = rectangle(other);
      const shared = sides.some(side => sharedEdges(doc, room.id, side).some(e => e.roomID === other.id));
      const union = { minX: Math.min(b.minX, n.minX), maxX: Math.max(b.maxX, n.maxX), minY: Math.min(b.minY, n.minY), maxY: Math.max(b.maxY, n.maxY) };
      const area = q => (q.maxX - q.minX) * (q.maxY - q.minY);
      if (!shared || Math.abs(area(union) - area(b) - area(n)) > 0.05) throw Error('The simple merge needs two rooms that form one rectangle.');
      doc.doorways = (doc.doorways ?? []).filter(d => !(d.connectedRoomIDs.includes(room.id) && d.connectedRoomIDs.includes(other.id)));
      remapRoomReferences(doc, other.id, room.id);
      room.editedPolygon = boxPolygon(union); room.name = validName(op.name || room.name);
      room.walkPoses = [...(room.walkPoses ?? []), ...(other.walkPoses ?? [])].sort((a, b) => a.t - b.t);
      room.walkPath = room.walkPoses.map(p => p.camera); room.walkTrail = room.walkPath;
      room.capturedPoints = [...room.capturedPoints, ...other.capturedPoints];
      room.walkStartedAt = Math.min(room.walkStartedAt ?? Infinity, other.walkStartedAt ?? Infinity);
      room.walkEndedAt = Math.max(room.walkEndedAt ?? 0, other.walkEndedAt ?? 0);
      doc.rooms = doc.rooms.filter(r => r.id !== other.id); room.revision++;
    } else if (op.type === 'splitRoom') {
      if (!['x', 'y'].includes(op.axis) || !finite(op.value)) throw Error('Choose a divider position.');
      const a = { ...b }, z = { ...b }, axis = op.axis.toUpperCase(); a[`max${axis}`] = op.value; z[`min${axis}`] = op.value;
      if (op.value - b[`min${axis}`] < 0.8 || b[`max${axis}`] - op.value < 0.8) throw Error('Both rooms need at least 0.8 m of space.');
      const newRoom = clone(room); newRoom.id = op.newRoomID ?? crypto.randomUUID().toUpperCase(); newRoom.name = validName(op.name || `${room.name} 2`);
      newRoom.editedPolygon = boxPolygon(z); room.editedPolygon = boxPolygon(a);
      newRoom.walkPoses = (room.walkPoses ?? []).filter(p => p.camera[op.axis] >= op.value);
      room.walkPoses = (room.walkPoses ?? []).filter(p => p.camera[op.axis] < op.value);
      for (const r of [room, newRoom]) { r.walkPath = r.walkPoses.map(p => p.camera); r.walkTrail = r.walkPath; r.revision++; }
      doc.rooms.push(newRoom);
      for (const door of doc.doorways ?? []) {
        if (!door.connectedRoomIDs.includes(room.id)) continue;
        const mid = (door.endpointA[op.axis] + door.endpointB[op.axis]) / 2;
        if (mid >= op.value) { door.connectedRoomIDs = door.connectedRoomIDs.map(id => id === room.id ? newRoom.id : id); if (door.wallRoomID === room.id) door.wallRoomID = newRoom.id; }
      }
      for (const key of ['capturedItems', 'transcript', 'features', 'openings']) for (const item of doc[key] ?? []) {
        if ((item.roomID ?? item.roomId) !== room.id) continue;
        const t = item.timestamp ?? item.startedAt;
        const nearest = [...room.walkPoses, ...newRoom.walkPoses].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
        if ((item.position ?? nearest?.camera)?.[op.axis] >= op.value) { if ('roomID' in item) item.roomID = newRoom.id; else item.roomId = newRoom.id; }
      }
    } else throw Error(`Unsupported change: ${op.type}`);
  }
  maintainDoors(doc);
  for (let i = 0; i < doc.rooms.length; i++) for (let j = i + 1; j < doc.rooms.length; j++) {
    const a = doc.rooms[i], b = doc.rooms[j], oldA = original.rooms.find(r => r.id === a.id), oldB = original.rooms.find(r => r.id === b.id);
    const before = oldA && oldB ? areaOverlap(bounds(oldA.editedPolygon), bounds(oldB.editedPolygon)) : 0;
    if (areaOverlap(bounds(a.editedPolygon), bounds(b.editedPolygon)) > before + 0.03) throw Error('This would overlap another room. Move the shared wall or join the rooms.');
  }
  return doc;
}

export function planWarnings(doc) {
  const warnings = [], fp = doc.site?.footprintPlan;
  if (fp?.length) for (const r of doc.rooms) if (r.editedPolygon.some(p => !inside(p, fp))) warnings.push(`${r.name}: some boundary lies outside the building footprint; check the evidence.`);
  for (let i = 0; i < doc.rooms.length; i++) for (let j = i + 1; j < doc.rooms.length; j++) if (areaOverlap(bounds(doc.rooms[i].editedPolygon), bounds(doc.rooms[j].editedPolygon)) > 0.1) warnings.push(`${doc.rooms[i].name} and ${doc.rooms[j].name}: overlapping draft bounds need review.`);
  return warnings;
}

/** Models supply time windows and room identity, never metre coordinates. */
export function assembleRooms(source, segments) {
  const doc = clone(source), poses = [...source.rooms.flatMap(r => r.walkPoses ?? []), ...(source.inProgress?.walkPoses ?? [])].sort((a, b) => a.t - b.t);
  if (!poses.length) throw Error('This capture has no timestamped camera path.');
  const t0 = source.media?.videoStartedAt ?? source.events?.find(e => e.type === 'walkStarted')?.timestamp ?? poses[0].t;
  const duration = poses.at(-1).t - t0;
  if (!Array.isArray(segments) || !segments.length || segments.length > 80) throw Error('No usable room segments were returned.');
  const windows = segments.map(s => {
    if (!finite(s.start) || !finite(s.end) || s.start < 0 || s.end <= s.start || s.end > duration + 1 || !['low', 'medium', 'high'].includes(s.confidence)) throw Error('Room timestamps or confidence are invalid.');
    return { ...s, name: validName(s.name) };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i++) if (windows[i].start < windows[i - 1].end - 0.05) throw Error('Room time windows overlap.');
  const groups = new Map();
  for (const p of poses) {
    const t = p.t - t0, s = windows.find(s => t >= s.start && t < s.end);
    const key = s?.name ?? 'Unassigned walk';
    if (!groups.has(key)) groups.set(key, { name: key, poses: [], confidence: s?.confidence ?? 'low', evidence: s?.evidence ?? 'No confident room assignment' });
    const group = groups.get(key); group.poses.push(p);
    if (s?.confidence === 'low') group.confidence = 'low';
  }
  doc.rooms = [...groups.values()].map(g => ({ id: crypto.randomUUID().toUpperCase(), name: g.name, type: 'other', capturedPoints: [],
    editedPolygon: roomBox(g.poses.map(p => p.camera), source.settings?.pad ?? 0.5, 1.2), revision: 0, isApproximate: true,
    createdAt: g.poses[0].t, walkPoses: g.poses, walkPath: g.poses.map(p => p.camera), walkTrail: g.poses.map(p => p.camera),
    walkStartedAt: g.poses[0].t, walkEndedAt: g.poses.at(-1).t,
    assembly: { confidence: g.confidence, evidence: g.evidence, method: 'camera-path envelope; boundaries need review' } }));
  doc.doorways = [];
  if (doc.inProgress) { doc.inProgress.walkPoses = []; doc.inProgress.walkSamples = []; }
  // Preserve time attribution even when original manual room taps were wrong.
  for (const key of ['capturedItems', 'transcript', 'observations']) for (const item of doc[key] ?? []) {
    const t = item.timestamp ?? item.startedAt;
    if (finite(t)) { const nearest = doc.rooms.flatMap(r => r.walkPoses.map(p => ({ room: r, d: Math.abs(p.t - t) }))).sort((a, b) => a.d - b.d)[0]; if (nearest) item.roomID = nearest.room.id; }
  }
  doc.assembly = { segments: windows, sourcePoseCount: poses.length, warning: 'Draft room envelopes, not surveyed walls. Unassigned and low-confidence areas need review.' };
  return doc;
}
