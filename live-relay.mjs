// Live debug link between the HomeWalk iPhone app and browsers on this Mac.
//
//   phone   ── ws://<mac>:8787/live?role=phone  ── snapshots (≈1/s) ──▶ relay
//   viewer  ── ws://<mac>:8787/live?role=viewer ◀── snapshots; ──▶ settings/commands ──▶ phone
//
// Every snapshot is appended to test-output/live/<sessionID>.jsonl so a walk
// can be replayed or tailed from a terminal. GET /live/latest returns the
// most recent snapshot; POST /live/settings pushes settings to the phone
// without a browser (curl-friendly).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';

export function createLiveRelay({ app, logDir }) {
  const phones = new Set();
  const viewers = new Set();
  let latest = null;
  let logStream = null;
  let logSession = null;

  function logSnapshot(snap) {
    try {
      if (snap.sessionID !== logSession) {
        logStream?.end();
        fs.mkdirSync(logDir, { recursive: true });
        logSession = snap.sessionID;
        logStream = fs.createWriteStream(path.join(logDir, `${snap.sessionID}.jsonl`), { flags: 'a' });
      }
      logStream.write(JSON.stringify(snap) + '\n');
    } catch (err) {
      console.error('live log write failed:', err.message);
    }
  }

  function broadcast(set, text) {
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  function toPhone(obj) {
    const text = JSON.stringify(obj);
    broadcast(phones, text);
    return phones.size;
  }

  app.get('/live/latest', (_req, res) => {
    if (!latest) return res.status(404).json({ error: 'no snapshot yet' });
    res.json({ ...latest, phones: phones.size, viewers: viewers.size });
  });
  app.post('/live/settings', express.json(), (req, res) => {
    const n = toPhone({ type: 'settings', settings: req.body.settings ?? req.body, rebox: Boolean(req.body.rebox) });
    res.json({ sentTo: n });
  });
  app.post('/live/command', express.json(), (req, res) => {
    const n = toPhone({ type: 'command', name: String(req.body.name ?? '') });
    res.json({ sentTo: n });
  });

  // Reuse cached property evidence. Reading a property never starts a model call.
  const referenceDir = path.join(path.dirname(logDir), 'reference');
  const slugOf = address => address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function cachedProperty(address) {
    const slug = slugOf(address);
    if (!slug) throw new Error('address required');
    const direct = path.join(referenceDir, slug);
    if (fs.existsSync(path.join(direct, 'priors.json'))) return direct;
    // The script may have been run with a short address; priors.json holds
    // the canonical geocoded address, including city and state.
    for (const entry of fs.existsSync(referenceDir) ? fs.readdirSync(referenceDir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(referenceDir, entry.name);
      try {
        const priors = JSON.parse(fs.readFileSync(path.join(dir, 'priors.json'), 'utf8'));
        if (slugOf(priors.address ?? '') === slug) return dir;
      } catch { /* incomplete cache; try the next bundle */ }
    }
    return direct;
  }

  app.get('/site/aerial', (req, res) => {
    const address = String(req.query.address ?? '').trim();
    if (!slugOf(address)) return res.status(400).json({ error: 'address required' });
    const dir = cachedProperty(address);
    // Serve only the known overlay filename, never a path supplied by a client.
    const file = path.resolve(dir, 'aerial-overlay.png');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'aerial unavailable' });
    res.sendFile(file);
  });

  app.get('/site', (req, res) => {
    const address = String(req.query.address ?? '').trim();
    if (!slugOf(address)) return res.status(400).json({ error: 'address required' });
    const dir = cachedProperty(address);
    const send = () => {
      try {
        const priors = JSON.parse(fs.readFileSync(path.join(dir, 'priors.json'), 'utf8'));
        const fp = priors.footprint;
        if (!fp) return res.status(404).json({ error: 'no footprint found for that address' });
        const facts = priors.facts ?? {};
        const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
        res.json({
          footprintEastNorth: fp.polygonEastNorthM.map(p => ({ x: p.east, y: p.north })),
          centroidLatitude: fp.centroid.lat, centroidLongitude: fp.centroid.lon,
          wallBearingDegrees: fp.dominantWallBearingDeg, areaSquareMeters: fp.areaM2, source: fp.source,
          address: priors.address || address,
          widthEastWestMeters: numeric(fp.bboxEastWestM), depthNorthSouthMeters: numeric(fp.bboxNorthSouthM),
          aerialPath: fs.existsSync(path.join(dir, 'aerial-overlay.png')) ? `/site/aerial?address=${encodeURIComponent(address)}` : null,
          propertyFacts: {
            bedrooms: numeric(facts.bedrooms), bathrooms: numeric(facts.bathrooms),
            livingAreaSqFt: numeric(facts.livingAreaSqFt), storeys: numeric(facts.storeys),
            propertyType: typeof facts.propertyType === 'string' ? facts.propertyType : null,
            roomsMentioned: Array.isArray(facts.roomsMentioned) ? facts.roomsMentioned.filter(r => typeof r === 'string') : [],
            verified: false,
          },
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    };
    if (fs.existsSync(path.join(dir, 'priors.json'))) return send();
    execFile(process.execPath, ['property-priors.mjs', address, '--no-model', '--out', dir], { cwd: path.dirname(logDir).replace(/test-output$/, '') || process.cwd(), timeout: 120_000 }, err => {
      if (err) return res.status(500).json({ error: `priors failed: ${err.message}` });
      send();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://x').searchParams.get('role') === 'phone' ? 'phone' : 'viewer';
    const set = role === 'phone' ? phones : viewers;
    set.add(ws);
    console.log(`live: ${role} connected (${phones.size} phone, ${viewers.size} viewer)`);
    if (role === 'viewer' && latest) ws.send(JSON.stringify(latest));
    ws.on('message', data => {
      const text = data.toString();
      if (role === 'phone') {
        try {
          const snap = JSON.parse(text);
          if (snap?.type === 'snapshot') { latest = snap; logSnapshot(snap); }
        } catch { return; }
        broadcast(viewers, text);
        // Ack so the phone's receive loop sees the link is alive.
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ack', t: Date.now() / 1000 }));
      } else {
        broadcast(phones, text);
      }
    });
    ws.on('close', () => { set.delete(ws); console.log(`live: ${role} disconnected`); });
    ws.on('error', () => set.delete(ws));
  });

  return {
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        if (!req.url.startsWith('/live')) return;
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      });
    },
    lanAddresses() {
      return Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === 'IPv4' && !i.internal)
        .map(i => i.address);
    },
    get latest() { return latest; },
  };
}
