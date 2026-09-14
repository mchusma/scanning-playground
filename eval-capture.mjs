#!/usr/bin/env node
// Evaluate a HomeWalk capture bundle against the physical-test protocol.
//
//   node eval-capture.mjs <bundle.homewalk | plan.json> [--json] [--svg out.svg]
//
// Prints measured vs tape dimensions per room, shared-wall snaps, doorway
// state, mismatches and return-to-door drift. `--json` emits the evaluation
// object; `--svg` writes the faithful polygon rendering.
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, report, renderSVG } from './public/homewalk-plan.js';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) {
  console.error('usage: node eval-capture.mjs <bundle.homewalk | plan.json> [--json] [--svg out.svg]');
  process.exit(2);
}
const planPath = fs.statSync(target).isDirectory() ? path.join(target, 'plan.json') : target;
const doc = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (doc.schemaVersion !== 1) console.error(`warning: schemaVersion ${doc.schemaVersion}, evaluator was written for 1`);

if (args.includes('--json')) {
  console.log(JSON.stringify(evaluate(doc), null, 2));
} else {
  console.log(report(doc));
}
const svgIdx = args.indexOf('--svg');
if (svgIdx >= 0 && args[svgIdx + 1]) {
  fs.writeFileSync(args[svgIdx + 1], renderSVG(doc, { showTrail: true, showPath: true }));
  console.error(`wrote ${args[svgIdx + 1]}`);
}
