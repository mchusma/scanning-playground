// JS port of the walk → room geometry in ios/HomeWalk/HomeWalk/Geometry/Geometry.swift,
// so a capture can be re-derived on the Mac (post-walk pipeline, review page)
// with different settings, and so the Swift and JS sides can be parity-tested
// against the same fixture. Pure functions, metres, plan frame.

export const DEFAULT_SETTINGS = {
  pad: 0.5, minSide: 1.2, measureFromHits: false, minRayFloorDot: 0.3, maxHitDistance: 4,
  sharedWallMaxShift: 1.2, sharedWallMaxGap: 0.35, yawMinSamples: 40, yawMinInlierFraction: 0.35, gridAngleOverride: null,
};

export const rotate = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function bounds(points) {
  if (!points?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

const boxOf = b => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

/** Axis-aligned box around the points, padded, at least minSide each way. */
export function roomBox(points, pad = DEFAULT_SETTINGS.pad, minSide = DEFAULT_SETTINGS.minSide) {
  const b = bounds(points.length ? points : [{ x: 0, y: 0 }]);
  b.minX -= pad; b.minY -= pad; b.maxX += pad; b.maxY += pad;
  if (b.maxX - b.minX < minSide) { const m = (b.minX + b.maxX) / 2; b.minX = m - minSide / 2; b.maxX = m + minSide / 2; }
  if (b.maxY - b.minY < minSide) { const m = (b.minY + b.maxY) / 2; b.minY = m - minSide / 2; b.maxY = m + minSide / 2; }
  return boxOf(b);
}

/** Pull the nearest edge inward to pass through `point` (the doorway tap), by at most maxPull. */
export function pinBoxEdge(box, point, maxPull = DEFAULT_SETTINGS.pad + 0.15, minSide = DEFAULT_SETTINGS.minSide) {
  const b = bounds(box);
  const cands = [
    { pull: b.maxX - point.x, apply: () => { b.maxX = point.x; } },
    { pull: point.x - b.minX, apply: () => { b.minX = point.x; } },
    { pull: b.maxY - point.y, apply: () => { b.maxY = point.y; } },
    { pull: point.y - b.minY, apply: () => { b.minY = point.y; } },
  ].filter(c => c.pull >= 0).sort((p, q) => p.pull - q.pull);
  if (!cands.length || cands[0].pull > maxPull) return box;
  cands[0].apply();
  if (b.maxX - b.minX < minSide || b.maxY - b.minY < minSide) return box;
  return boxOf(b);
}

/** Snap a new axis-aligned box onto its neighbour's shared wall (one side, bounded). */
export function snapBoxToNeighbor(box, neighbor, maxShift = DEFAULT_SETTINGS.sharedWallMaxShift, maxGap = DEFAULT_SETTINGS.sharedWallMaxGap, minSide = DEFAULT_SETTINGS.minSide) {
  const b = bounds(box), n = bounds(neighbor);
  const overlapX = Math.min(b.maxX, n.maxX) - Math.max(b.minX, n.minX);
  const overlapY = Math.min(b.maxY, n.maxY) - Math.max(b.minY, n.minY);
  const separateOnX = overlapX <= overlapY;
  const separation = separateOnX ? overlapX : overlapY;
  const other = separateOnX ? overlapY : overlapX;
  if (other <= 0.3) return null;
  if (separation > maxShift || separation < -maxGap) return null;
  const bC = separateOnX ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
  const nC = separateOnX ? (n.minX + n.maxX) / 2 : (n.minY + n.maxY) / 2;
  const higher = bC >= nC;
  let shift;
  if (separateOnX) {
    if (higher) { shift = n.maxX - b.minX; b.minX = n.maxX; } else { shift = b.maxX - n.minX; b.maxX = n.minX; }
    if (b.maxX - b.minX < minSide) return null;
  } else {
    if (higher) { shift = n.maxY - b.minY; b.minY = n.maxY; } else { shift = b.maxY - n.minY; b.maxY = n.minY; }
    if (b.maxY - b.minY < minSide) return null;
  }
  return { box: boxOf(b), shift };
}

/** Weighted headings (radians) → grid angle in (-45°, 45°], or null. */
export function dominantAngle(headings, { minTotalWeight, minInlierFraction, inlierWindowDegrees }) {
  const quarter = Math.PI / 2;
  const segs = [];
  let total = 0;
  for (const h of headings) {
    if (!(h.weight > 0)) continue;
    let theta = h.angle % quarter;
    if (theta < 0) theta += quarter;
    segs.push({ angle: theta, w: h.weight }); total += h.weight;
  }
  if (total < minTotalWeight) return null;
  const bins = new Array(30).fill(0);
  for (const s of segs) bins[Math.min(29, Math.floor(s.angle / quarter * 30))] += s.w;
  let peak = 0, peakW = -1;
  for (let i = 0; i < 30; i++) { const w = bins[(i + 29) % 30] + bins[i] + bins[(i + 1) % 30]; if (w > peakW) { peakW = w; peak = i; } }
  const peakAngle = (peak + 0.5) / 30 * quarter;
  const window = inlierWindowDegrees * Math.PI / 180;
  let sx = 0, sy = 0, inlier = 0;
  for (const s of segs) {
    let d = Math.abs(s.angle - peakAngle); d = Math.min(d, quarter - d);
    if (d > window) continue;
    sx += s.w * Math.cos(4 * s.angle); sy += s.w * Math.sin(4 * s.angle); inlier += s.w;
  }
  if (inlier < minTotalWeight || inlier / total < minInlierFraction) return null;
  return Math.atan2(sy, sx) / 4;
}

export function dominantAngleOfPath(path, { minSegment = 0.15, minTotalLength = 2, minInlierFraction = 0.4, inlierWindowDegrees = 6 } = {}) {
  const headings = [];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y, len = Math.hypot(dx, dy);
    if (len >= minSegment) headings.push({ angle: Math.atan2(dy, dx), weight: len });
  }
  return dominantAngle(headings, { minTotalWeight: minTotalLength, minInlierFraction, inlierWindowDegrees });
}

export function dominantAngleOfYaws(yaws, { minSamples = 40, minInlierFraction = 0.35, inlierWindowDegrees = 12 } = {}) {
  if (yaws.length < minSamples) return null;
  return dominantAngle(yaws.map(a => ({ angle: a, weight: 1 })), { minTotalWeight: minSamples, minInlierFraction, inlierWindowDegrees });
}

/**
 * Orientation at which the walked paths box tightest (sum of per-room bbox
 * areas), searched over [0, 90°). A rotating-calipers stand-in for captures
 * without yaw. Returns radians in (-45°, 45°] or null when the paths are too
 * short; `confidence` is how much smaller the best box is than the worst.
 */
export function minAreaAngle(roomPaths, { stepDeg = 1, minPoints = 8 } = {}) {
  const paths = roomPaths.filter(p => p?.length >= minPoints);
  if (!paths.length) return null;
  let best = null, worst = -Infinity;
  for (let deg = 0; deg < 90; deg += stepDeg) {
    const a = deg * Math.PI / 180;
    let area = 0;
    for (const path of paths) { const b = bounds(path.map(p => rotate(p, -a))); area += (b.maxX - b.minX) * (b.maxY - b.minY); }
    if (!best || area < best.area) best = { deg, area };
    worst = Math.max(worst, area);
  }
  let deg = best.deg;
  if (deg > 45) deg -= 90;
  return { angle: deg * Math.PI / 180, confidence: worst > 0 ? 1 - best.area / worst : 0 };
}

export function closestEdge(polygon, point) {
  let best = null;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const abx = b.x - a.x, aby = b.y - a.y, len2 = abx * abx + aby * aby;
    let t = len2 < 1e-12 ? 0 : ((point.x - a.x) * abx + (point.y - a.y) * aby) / len2;
    t = Math.min(1, Math.max(0, t));
    const p = { x: a.x + abx * t, y: a.y + aby * t };
    const d = dist(p, point);
    if (!best || d < best.distance) best = { index: i, t, projected: p, distance: d };
  }
  return best;
}

export function doorwayFromCenter(polygon, edgeIndex, centerT, width) {
  const a = polygon[edgeIndex], b = polygon[(edgeIndex + 1) % polygon.length];
  const abx = b.x - a.x, aby = b.y - a.y, len = Math.hypot(abx, aby);
  if (len < 0.02) return null;
  const dx = abx / len, dy = aby / len, c = { x: a.x + abx * centerT, y: a.y + aby * centerT };
  const clamp = p => { const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (len * len))); return { x: a.x + abx * t, y: a.y + aby * t }; };
  const p0 = clamp({ x: c.x - dx * width / 2, y: c.y - dy * width / 2 }), p1 = clamp({ x: c.x + dx * width / 2, y: c.y + dy * width / 2 });
  return dist(p0, p1) < 0.02 ? null : [p0, p1];
}

/**
 * Re-derive every walk room of a capture from its stored poses/path with the
 * given settings, exactly like `CaptureSession.reboxRooms()` plus optional
 * grid alignment. Returns a new document; the input is not mutated.
 *
 * Old captures (before poses were stored) have `walkPath` (camera) and
 * `walkTrail` (hits) but no per-sample time or yaw; the last camera point of
 * a room that was closed with Through a door stands in for the door tap.
 */
export function rederive(doc, overrides = {}, { align = true } = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}), ...overrides };
  const out = structuredClone(doc);
  out.settings = settings;
  const sourcePoints = room => {
    if (room.walkPoses?.length) return settings.measureFromHits ? room.walkPoses.map(p => p.hit).filter(Boolean) : room.walkPoses.map(p => p.camera);
    return settings.measureFromHits ? (room.walkTrail ?? []) : (room.walkPath ?? room.walkTrail ?? []);
  };
  const closedByDoor = new Set(out.doorways.map(d => d.wallRoomID));

  // Grid: yaw votes first, path second. Applied as a rotation of every plan-space quantity.
  let angle = null;
  if (align && settings.gridAngleOverride == null) {
    const yaws = out.rooms.flatMap(r => (r.walkPoses ?? []).map(p => p.yaw).filter(y => y != null));
    const path = out.rooms.flatMap(r => r.walkPath ?? []);
    angle = dominantAngleOfYaws(yaws, { minSamples: settings.yawMinSamples, minInlierFraction: settings.yawMinInlierFraction }) ?? dominantAngleOfPath(path);
    if (angle == null) {
      const m = minAreaAngle(out.rooms.map(r => r.walkPath ?? []));
      if (m && m.confidence >= 0.08) { angle = m.angle; out.gridEstimator = `min-area sweep (confidence ${m.confidence.toFixed(2)})`; }
    } else out.gridEstimator = yaws.length >= settings.yawMinSamples ? 'phone yaw' : 'path heading';
  } else if (settings.gridAngleOverride != null) {
    angle = settings.gridAngleOverride - (out.floor?.gridAngle ?? 0);
  }
  if (angle != null && Math.abs(angle) > 1e-9) rotatePlan(out, angle);

  let prevID = null;
  for (const room of out.rooms) {
    const pts = sourcePoints(room);
    if (!pts.length) { prevID = room.id; continue; }
    let raw = roomBox(pts, settings.pad, settings.minSide);
    const tap = room.doorTapPoint ?? (closedByDoor.has(room.id) ? (room.walkPath?.at(-1) ?? null) : null);
    if (tap) raw = pinBoxEdge(raw, tap, settings.pad + 0.15, settings.minSide);
    let edited = raw, shift = null;
    if (prevID && out.doorways.some(d => d.connectedRoomIDs.includes(room.id) && d.connectedRoomIDs.includes(prevID))) {
      const prev = out.rooms.find(r => r.id === prevID);
      const s = snapBoxToNeighbor(raw, prev.editedPolygon, settings.sharedWallMaxShift, settings.sharedWallMaxGap, settings.minSide);
      if (s) { edited = s.box; shift = s.shift; }
    }
    room.capturedPoints = raw.map(p => ({ id: cryptoId(), rawWorld: { x: p.x, y: 0, z: p.y }, rawPlan: p, snappedPlan: p, isApproximate: true, wasSnapped: false }));
    room.editedPolygon = edited;
    room.wallSnapShift = shift;
    room.doorTapPoint = tap ?? room.doorTapPoint ?? null;
    room.revision = (room.revision ?? 1) + 1;
    if (tap) {
      const door = out.doorways.find(d => d.wallRoomID === room.id);
      const edge = closestEdge(edited, tap);
      if (door && edge) {
        const pair = doorwayFromCenter(edited, edge.index, edge.t, door.width ?? 0.9);
        if (pair) { door.wallEdgeIndex = edge.index; door.endpointA = pair[0]; door.endpointB = pair[1]; }
      }
    }
    prevID = room.id;
  }
  out.mismatches = [];
  for (const d of out.doorways) {
    if (d.connectedRoomIDs.length < 2) continue;
    const [ra, rb] = d.connectedRoomIDs.map(id => out.rooms.find(r => r.id === id));
    if (!ra || !rb) continue;
    const mid = { x: (d.endpointA.x + d.endpointB.x) / 2, y: (d.endpointA.y + d.endpointB.y) / 2 };
    const ea = closestEdge(ra.editedPolygon, mid), eb = closestEdge(rb.editedPolygon, mid);
    const gap = dist(ea.projected, eb.projected);
    if (gap > 0.15) out.mismatches.push({ id: cryptoId(), doorwayID: d.id, roomA: ra.id, roomB: rb.id, distanceMeters: gap, angleDegrees: 0, summary: `Adjacent outlines disagree by ${(gap * 100).toFixed(0)} cm. No corridor was invented.` });
  }
  out.rederived = { at: Date.now() / 1000, gridAngleApplied: angle, settings };
  return out;
}

function rotatePlan(doc, angle) {
  const r = p => rotate(p, -angle);
  if (doc.floor) doc.floor.gridAngle = (doc.floor.gridAngle ?? 0) + angle;
  for (const room of doc.rooms) {
    room.editedPolygon = room.editedPolygon.map(r);
    room.walkTrail = (room.walkTrail ?? []).map(r);
    room.walkPath = (room.walkPath ?? []).map(r);
    room.walkPoses = (room.walkPoses ?? []).map(p => ({ ...p, camera: r(p.camera), hit: p.hit ? r(p.hit) : p.hit, yaw: p.yaw != null ? p.yaw - angle : p.yaw }));
    if (room.doorTapPoint) room.doorTapPoint = r(room.doorTapPoint);
    for (const cp of room.capturedPoints ?? []) { cp.rawPlan = r(cp.rawPlan); cp.snappedPlan = r(cp.snappedPlan); }
  }
  for (const d of doc.doorways) { d.endpointA = r(d.endpointA); d.endpointB = r(d.endpointB); }
  for (const c of doc.alignmentChecks ?? []) { c.cameraPlan = r(c.cameraPlan); c.doorwayMidpoint = r(c.doorwayMidpoint); }
  if (doc.geo?.cameraPlan) doc.geo.cameraPlan = r(doc.geo.cameraPlan);
  if (doc.site?.footprintPlan) doc.site.footprintPlan = doc.site.footprintPlan.map(r);
  for (const f of doc.features ?? []) if (f.position) f.position = r(f.position);
  for (const o of doc.openings ?? []) if (o.position) o.position = r(o.position);
}

function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toUpperCase();
}
