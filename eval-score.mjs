/**
 * Evaluation Scoring Module
 *
 * Compares pipeline output (from video replay) against ground truth
 * and produces a structured score report.
 *
 * Usage:
 *   import { scoreResult } from './eval-score.mjs';
 *   const score = scoreResult(pipelineOutput, groundTruth);
 */

// ── Fuzzy matching helpers ───────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function normalize(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

/**
 * Check if a detected room matches an expected room (by name or alias).
 * Uses substring matching to be forgiving of variations like
 * "Primary Bedroom Suite" matching "Primary Bedroom".
 */
function roomMatches(detectedName, expectedRoom) {
  const det = normalize(detectedName);
  const candidates = [expectedRoom.name, ...(expectedRoom.aliases || [])];

  for (const candidate of candidates) {
    const can = normalize(candidate);
    if (det === can) return true;
    if (det.includes(can) || can.includes(det)) return true;
    // Check slug match (handles "Living Room" vs "living-room")
    if (slugify(detectedName) === slugify(candidate)) return true;
  }
  return false;
}

/**
 * Check if a detected feature matches an expected feature.
 * Forgiving: "Stainless Steel Refrigerator (north wall)" matches "Refrigerator".
 * Strips position hints in parentheses before comparing.
 */
function featureMatches(detectedFeature, expectedFeature) {
  // Strip position hints like "(center)" or "(north wall)"
  const det = normalize(detectedFeature.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
  const exp = normalize(expectedFeature);
  return det.includes(exp) || exp.includes(det);
}

// ── Scoring ──────────────────────────────────────────────────────────────

/**
 * Score a pipeline result against ground truth.
 *
 * @param {Object} result - Pipeline output (from video-replay-report.json)
 *   { rooms: [{id, name, roomType, features}], edges: [{fromId, toId, pathType}], toolCalls: [...] }
 * @param {Object} truth - Ground truth
 *   { expectedRooms, expectedConnections, expectedFeatures, scoring }
 * @returns {Object} Detailed score report
 */
export function scoreResult(result, truth) {
  const scores = {};

  // ── 1. Room Detection ──────────────────────────────────────────────
  const detectedRooms = result.rooms || [];
  const expectedRooms = truth.expectedRooms || [];
  const { minRooms, maxReasonableRooms } = truth.scoring || {};

  // Match each expected room to a detected room
  const roomMatching = [];
  const matchedDetectedIds = new Set();

  for (const expected of expectedRooms) {
    let matched = null;
    for (const detected of detectedRooms) {
      if (matchedDetectedIds.has(detected.id)) continue;
      if (roomMatches(detected.name, expected)) {
        matched = detected;
        matchedDetectedIds.add(detected.id);
        break;
      }
    }
    roomMatching.push({
      expected: expected.name,
      required: expected.required,
      matched: matched ? matched.name : null,
      matchedId: matched ? matched.id : null,
    });
  }

  const requiredRooms = expectedRooms.filter(r => r.required);
  const requiredFound = roomMatching.filter(m => m.required && m.matched).length;
  const totalFound = roomMatching.filter(m => m.matched).length;
  const extraRooms = detectedRooms.filter(d => !matchedDetectedIds.has(d.id));

  scores.rooms = {
    requiredRecall: requiredRooms.length > 0 ? requiredFound / requiredRooms.length : 1,
    totalRecall: expectedRooms.length > 0 ? totalFound / expectedRooms.length : 1,
    precision: detectedRooms.length > 0 ? totalFound / detectedRooms.length : 0,
    detected: detectedRooms.length,
    expected: expectedRooms.length,
    requiredFound,
    requiredTotal: requiredRooms.length,
    extraRooms: extraRooms.map(r => r.name),
    matching: roomMatching,
    countInRange: detectedRooms.length >= (minRooms || 0) && detectedRooms.length <= (maxReasonableRooms || 999),
  };

  // ── 2. Connection Detection ────────────────────────────────────────
  const detectedEdges = result.edges || [];
  const expectedConns = truth.expectedConnections || [];
  const { minConnections, maxReasonableConnections } = truth.scoring || {};

  // Build a lookup of detected connections (using slugs, bidirectional)
  const detectedConnSet = new Set();
  // Also build adjacency list for indirect matching
  const adjacency = new Map();
  for (const edge of detectedEdges) {
    const pair = [edge.fromId, edge.toId].sort().join('::');
    detectedConnSet.add(pair);
    if (!adjacency.has(edge.fromId)) adjacency.set(edge.fromId, new Set());
    if (!adjacency.has(edge.toId)) adjacency.set(edge.toId, new Set());
    adjacency.get(edge.fromId).add(edge.toId);
    adjacency.get(edge.toId).add(edge.fromId);
  }

  // Check if two rooms are connected within N hops via transit rooms (hallways, entryways)
  const TRANSIT_TYPES = new Set(['hallway', 'entryway', 'corridor', 'hall', 'stairs']);
  function isIndirectlyConnected(fromId, toId, maxHops = 2) {
    if (!adjacency.has(fromId)) return false;
    // BFS limited to maxHops, only traversing through transit rooms
    const queue = [{ id: fromId, hops: 0 }];
    const visited = new Set([fromId]);
    while (queue.length > 0) {
      const { id, hops } = queue.shift();
      for (const neighbor of adjacency.get(id) || []) {
        if (neighbor === toId) return true;
        if (visited.has(neighbor) || hops + 1 >= maxHops) continue;
        // Only traverse through transit rooms (hallways, etc.)
        const room = detectedRooms.find(r => r.id === neighbor);
        if (room && TRANSIT_TYPES.has(normalize(room.roomType))) {
          visited.add(neighbor);
          queue.push({ id: neighbor, hops: hops + 1 });
        }
      }
    }
    return false;
  }

  // Try to match expected connections
  const connMatching = [];
  for (const expected of expectedConns) {
    // Find which detected room IDs correspond to the expected room names
    const fromMatch = roomMatching.find(m =>
      normalize(m.expected) === normalize(expected.from) ||
      normalize(m.matched || '') === normalize(expected.from)
    );
    const toMatch = roomMatching.find(m =>
      normalize(m.expected) === normalize(expected.to) ||
      normalize(m.matched || '') === normalize(expected.to)
    );

    let found = false;
    if (fromMatch?.matchedId && toMatch?.matchedId) {
      const pair = [fromMatch.matchedId, toMatch.matchedId].sort().join('::');
      found = detectedConnSet.has(pair);
      // If not directly connected, check indirect via hallway/entryway
      if (!found) {
        found = isIndirectlyConnected(fromMatch.matchedId, toMatch.matchedId);
      }
    }

    // Also try direct slug matching as fallback
    if (!found) {
      const fromSlug = slugify(expected.from);
      const toSlug = slugify(expected.to);
      const pair = [fromSlug, toSlug].sort().join('::');
      found = detectedConnSet.has(pair);
      if (!found) {
        found = isIndirectlyConnected(fromSlug, toSlug);
      }
    }

    connMatching.push({
      from: expected.from,
      to: expected.to,
      found,
    });
  }

  const connsFound = connMatching.filter(c => c.found).length;

  scores.connections = {
    recall: expectedConns.length > 0 ? connsFound / expectedConns.length : 1,
    detected: detectedEdges.length,
    expected: expectedConns.length,
    found: connsFound,
    matching: connMatching,
    countInRange: detectedEdges.length >= (minConnections || 0) && detectedEdges.length <= (maxReasonableConnections || 999),
  };

  // ── 3. Feature Detection ───────────────────────────────────────────
  const expectedFeatures = truth.expectedFeatures || {};
  let totalExpectedFeatures = 0;
  let totalFoundFeatures = 0;
  const featureMatching = {};

  for (const [roomName, features] of Object.entries(expectedFeatures)) {
    // Find the detected room matching this expected room
    const roomMatch = roomMatching.find(m =>
      normalize(m.expected) === normalize(roomName) ||
      normalize(m.matched || '') === normalize(roomName)
    );

    const detectedRoom = roomMatch?.matchedId
      ? detectedRooms.find(r => r.id === roomMatch.matchedId)
      : null;

    const detectedFeatures = detectedRoom?.features || [];
    const matches = [];

    for (const expected of features) {
      const found = detectedFeatures.some(df => featureMatches(df, expected));
      matches.push({ expected, found });
      totalExpectedFeatures++;
      if (found) totalFoundFeatures++;
    }

    featureMatching[roomName] = matches;
  }

  scores.features = {
    recall: totalExpectedFeatures > 0 ? totalFoundFeatures / totalExpectedFeatures : 1,
    found: totalFoundFeatures,
    expected: totalExpectedFeatures,
    byRoom: featureMatching,
  };

  // ── 4. Tool Call Efficiency ────────────────────────────────────────
  const toolCalls = result.toolCalls || [];
  const toolCounts = {};
  for (const tc of toolCalls) {
    toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
  }

  scores.efficiency = {
    totalToolCalls: toolCalls.length,
    byTool: toolCounts,
    roomsPerToolCall: detectedRooms.length > 0 ? toolCalls.length / detectedRooms.length : 0,
  };

  // ── 5. Overall Score ───────────────────────────────────────────────
  // Weighted composite: room recall is most important, then connections, then features
  const overall =
    0.40 * scores.rooms.requiredRecall +
    0.20 * scores.rooms.totalRecall +
    0.20 * scores.connections.recall +
    0.10 * scores.features.recall +
    0.05 * (scores.rooms.countInRange ? 1 : 0) +
    0.05 * (scores.connections.countInRange ? 1 : 0);

  scores.overall = Math.round(overall * 100);

  return scores;
}

/**
 * Format a score report as a human-readable string.
 */
export function formatScoreReport(name, scores) {
  const lines = [];
  const bar = (pct) => {
    const filled = Math.round(pct * 20);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`  ${name}`);
  lines.push(`${'═'.repeat(60)}`);
  lines.push(`  Overall Score: ${scores.overall}/100`);
  lines.push(`  ${bar(scores.overall / 100)}`);
  lines.push('');

  // Rooms
  lines.push(`  Rooms (${scores.rooms.detected} detected, ${scores.rooms.expected} expected)`);
  lines.push(`    Required recall: ${(scores.rooms.requiredRecall * 100).toFixed(0)}% (${scores.rooms.requiredFound}/${scores.rooms.requiredTotal})`);
  lines.push(`    Total recall:    ${(scores.rooms.totalRecall * 100).toFixed(0)}% (${scores.rooms.matching.filter(m => m.matched).length}/${scores.rooms.expected})`);
  lines.push(`    Precision:       ${(scores.rooms.precision * 100).toFixed(0)}%`);

  for (const m of scores.rooms.matching) {
    const icon = m.matched ? '  ✓' : (m.required ? '  ✗' : '  ○');
    const label = m.matched ? `→ ${m.matched}` : 'NOT FOUND';
    lines.push(`    ${icon} ${m.expected} ${label}`);
  }
  if (scores.rooms.extraRooms.length > 0) {
    lines.push(`    Extra: ${scores.rooms.extraRooms.join(', ')}`);
  }
  lines.push('');

  // Connections
  lines.push(`  Connections (${scores.connections.detected} detected, ${scores.connections.expected} expected)`);
  lines.push(`    Recall: ${(scores.connections.recall * 100).toFixed(0)}% (${scores.connections.found}/${scores.connections.expected})`);
  for (const c of scores.connections.matching) {
    lines.push(`    ${c.found ? '  ✓' : '  ✗'} ${c.from} ↔ ${c.to}`);
  }
  lines.push('');

  // Features
  lines.push(`  Features (${scores.features.found}/${scores.features.expected} found)`);
  lines.push(`    Recall: ${(scores.features.recall * 100).toFixed(0)}%`);
  for (const [room, features] of Object.entries(scores.features.byRoom || {})) {
    const found = features.filter(f => f.found).length;
    lines.push(`    ${room}: ${found}/${features.length}`);
    for (const f of features) {
      lines.push(`      ${f.found ? '✓' : '✗'} ${f.expected}`);
    }
  }
  lines.push('');

  // Efficiency
  lines.push(`  Tool Calls: ${scores.efficiency.totalToolCalls}`);
  for (const [tool, count] of Object.entries(scores.efficiency.byTool)) {
    lines.push(`    ${tool}: ${count}`);
  }

  lines.push(`${'═'.repeat(60)}\n`);
  return lines.join('\n');
}
