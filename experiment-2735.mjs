import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

const dir = 'test-output/walkthrough-2735';
mkdirSync(dir, { recursive: true });
const model = process.env.PLAN_MODEL || 'gemini-3.1-pro-preview';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const video = { inlineData: { mimeType: 'video/mp4', data: readFileSync(`${dir}/video.mp4`).toString('base64') }, videoMetadata: { fps: 2 } };
const shared = `This is a real 124-second portrait home walkthrough. Watch the video AND listen carefully to the audio. Reconstruct only this property, not an idealized house. Distinguish revisits from new rooms, open-plan zones from enclosed rooms, visibility from traversal. No compass bearing or physical scale is known. Use a local coordinate system with entry at bottom and interior toward top if possible. Never convert a camera pan into walking or assume all left turns are global west. Cite timestamps in seconds. Hidden spaces remain unknown. Approximate geometry is welcome, invented rooms are not. Return JSON only.`;
const planSchema = `Return {title,method,summary,orientation,scaleNote,rooms:[{id,name,type,x,y,w,h,confidence,firstSeen,notes:[{text,time,source:"spoken|visible|inferred"}]}],edges:[{from,to,kind,evidence,time,confidence}],uncertainties:[string],walk:[{time,roomId,description}]}. Rooms are nonoverlapping axis-aligned rectangles in arbitrary layout units (about 100 units for an ordinary room width), x/y at top left, y increases down. Connected rooms should touch at a shared wall whenever plausible. Preserve distinct open-plan zones but note their open boundary. Outdoor areas must be labeled. Include rooms clearly seen even if not entered, marking uncertain identity. A room's confidence refers to geometry; notes need actual supporting evidence. There can be multiple floors if explicitly observed, but do not invent them. Use IDs in all edges and walk entries.`;

async function run(name, prompt, parts = [video]) {
  if (existsSync(`${dir}/${name}.json`)) { console.log(`Cached ${name}`); return JSON.parse(readFileSync(`${dir}/${name}.json`)); }
  console.log(`Starting ${name} with ${model}`);
  writeFileSync(`${dir}/${name}.prompt.txt`, `${shared}\n${prompt}`);
  const start = Date.now();
  const response = await ai.models.generateContent({ model, contents: [{ role: 'user', parts: [...parts, { text: `${shared}\n${prompt}` }] }], config: { responseMimeType: 'application/json', temperature: 0.2 } });
  writeFileSync(`${dir}/${name}.raw.txt`, response.text || '');
  const data = JSON.parse(response.text);
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(data, null, 2));
  writeFileSync(`${dir}/${name}.meta.json`, JSON.stringify({model,seconds:(Date.now()-start)/1000,usage:response.usageMetadata},null,2));
  console.log(`Finished ${name}: ${(Date.now()-start)/1000}s`);
  return data;
}

const mode = process.argv[2] || 'both';
if (mode === 'both' || mode === 'direct') await run('direct', `Approach A: reason over the entire video in one pass and directly create your best approximate 2D floor plan. ${planSchema}`);
if (mode === 'both' || mode === 'evidence') {
  const evidence = await run('evidence', `Approach B, stage 1: collect observations before attempting coordinates. Do NOT draw a plan yet. Return {transcript:[{start,end,text}],rooms:[{id,name,type,firstSeen,visits:[{start,end}],features:[{text,time,source}],shapeDescription}],transitions:[{time,from,to,traversed,description,confidence}],spatialConstraints:[{a,b,relation,evidence,time,confidence}],uncertainties:[string]}. Transcribe audible speech faithfully; do not invent narration. Relations must distinguish camera-relative statements from global directions. Identify the complete route, repeated visits, shared openings and room boundaries. A separate stage will fit room rectangles.`);
  await run('constrained-seed', `Approach B, stage 2: use this evidence ledger to assemble the most consistent rough floor plan. You have NO video in this stage. Resolve revisit identity before positioning rooms; fit the entire route jointly. ${planSchema}\nEVIDENCE:\n${JSON.stringify(evidence)}`, []);
}
