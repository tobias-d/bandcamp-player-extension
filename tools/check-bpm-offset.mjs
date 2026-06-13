#!/usr/bin/env node
// Measure the sub-integer BPM offset of our base estimator vs ground truth.
//
// Input: a report exported from the BPM Prototype panel (Copy Report / Analyze All).
// After the Stage-0 instrumentation, each track block carries:
//   Expected BPM: <int>        (filled from rekordbox)
//   Base BPM: <int>            (Math.round of the base estimate — what the product shows)
//   Base raw BPM: <float>      (the pre-round float — the number this script measures)
//   Observed BPM: <int>        (final, possibly family-corrected)
//
// This script answers ONE question: is the ~1 BPM gap vs rekordbox a sub-integer
// rounding bias (fixable by calibration) or a genuine algorithmic difference?
//
// Usage:
//   node tools/check-bpm-offset.mjs <panel-report.txt> [rekordbox-reference.jsonl]
//
// The optional JSONL (artist/title/bpm) is used only to backfill Expected BPM for
// blocks where the panel field was left blank, matched on the "Artist - Title" label.

import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
const refPath = process.argv[3];

if (!reportPath) {
  console.error('Usage: node tools/check-bpm-offset.mjs <panel-report.txt> [rekordbox-reference.jsonl]');
  process.exit(2);
}

// ---- parse the panel report -------------------------------------------------

function parseBlocks(text) {
  // Blocks are separated by a line of '=' (Analyze All uses 72). Single-track
  // reports are one block. Be tolerant of any run of '=' on its own line.
  const blocks = text.split(/\n\s*={6,}\s*\n/);
  const rows = [];
  for (const block of blocks) {
    const fields = {};
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key && !(key in fields)) fields[key] = val;
    }
    if (fields.Track || fields['Base raw BPM'] || fields['Expected BPM']) {
      rows.push(fields);
    }
  }
  return rows;
}

function num(v) {
  if (v == null || v === '-' || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ---- optional rekordbox backfill -------------------------------------------

function loadReference(path) {
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    const key = `${o.artist} - ${o.title}`.toLowerCase().trim();
    const bpm = parseFloat(o.bpm);
    if (Number.isFinite(bpm)) map.set(key, bpm);
  }
  return map;
}

// ---- stats helpers ----------------------------------------------------------

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');

// ---- run --------------------------------------------------------------------

const rows = parseBlocks(readFileSync(reportPath, 'utf8'));
const ref = refPath ? loadReference(refPath) : null;

let total = 0;
let noExpected = 0;
let noRaw = 0;
let corrected = 0;
const offsets = [];        // baseRaw - expected, for UNCORRECTED tracks only
const offBy1 = [];         // uncorrected tracks where round(baseRaw) is >=1 away from expected
const correctedRows = [];

for (const r of rows) {
  total++;
  const baseRaw = num(r['Base raw BPM']);
  const baseInt = num(r['Base BPM']);
  const observed = num(r['Observed BPM']);
  let expected = num(r['Expected BPM']);
  if (!Number.isFinite(expected) && ref) {
    const key = String(r.Track || '').toLowerCase().trim();
    if (ref.has(key)) expected = ref.get(key);
  }
  if (!Number.isFinite(baseRaw)) { noRaw++; continue; }
  if (!Number.isFinite(expected)) { noExpected++; continue; }

  const isCorrected = Number.isFinite(observed) && Number.isFinite(baseInt) && observed !== baseInt;
  if (isCorrected) {
    corrected++;
    correctedRows.push(`  ${r.Track || '?'}: base ${fmt(baseRaw)} -> corrected ${observed} (expected ${expected})`);
    continue; // family correction dominates; out of scope for the rounding question
  }

  const offset = baseRaw - expected;
  const refined = num(r['Refined BPM']);
  offsets.push({ offset, baseRaw, refined, expected, track: r.Track || '?' });
  if (Math.abs(Math.round(baseRaw) - expected) >= 1) {
    offBy1.push({ track: r.Track || '?', baseRaw, expected, offset, refined });
  }
}

// ---- report -----------------------------------------------------------------

console.log('='.repeat(72));
console.log('BPM sub-integer offset analysis (base estimate vs ground truth)');
console.log('='.repeat(72));
console.log(`Report blocks parsed:        ${total}`);
console.log(`  usable (raw + expected):   ${offsets.length} uncorrected`);
console.log(`  family-corrected (skipped):${corrected}`);
console.log(`  missing raw BPM:           ${noRaw}`);
console.log(`  missing expected BPM:      ${noExpected}`);

if (!offsets.length) {
  console.log('\nNo usable uncorrected tracks. Export a panel report with Expected BPM filled.');
  process.exit(0);
}

const offsetVals = offsets.map((o) => o.offset);
const m = mean(offsetVals);
const med = median(offsetVals);
const sd = stdev(offsetVals);
const within05 = offsetVals.filter((o) => Math.abs(o) <= 0.5).length;
const pos = offsetVals.filter((o) => o > 0).length;
const neg = offsetVals.filter((o) => o < 0).length;
const ge1 = offsetVals.filter((o) => Math.abs(o) >= 1).length;

console.log('\n-- offset = (our raw base float) - (ground-truth BPM), uncorrected tracks --');
console.log(`  mean:    ${fmt(m)}   median: ${fmt(med)}   stdev: ${fmt(sd)}`);
console.log(`  range:   [${fmt(Math.min(...offsetVals))}, ${fmt(Math.max(...offsetVals))}]`);
console.log(`  sign:    +${pos} / -${neg}  (toward faster / slower)`);
console.log(`  |offset| <= 0.5:  ${within05}/${offsetVals.length}  (${(100 * within05 / offsetVals.length).toFixed(1)}%)`);
console.log(`  |offset| >= 1.0:  ${ge1}/${offsetVals.length}  (${(100 * ge1 / offsetVals.length).toFixed(1)}%)`);
console.log(`  displayed (rounded) off by >=1 vs truth: ${offBy1.length}/${offsetVals.length}`);

// ---- EXPERIMENT scoring: does beat-grid refinement land the integer? --------
const withRefined = offsets.filter((o) => Number.isFinite(o.refined));
if (withRefined.length) {
  const baseHit = withRefined.filter((o) => Math.round(o.baseRaw) === o.expected).length;
  const refHit = withRefined.filter((o) => Math.round(o.refined) === o.expected).length;
  const fixed = withRefined.filter((o) => Math.round(o.baseRaw) !== o.expected && Math.round(o.refined) === o.expected);
  const broke = withRefined.filter((o) => Math.round(o.baseRaw) === o.expected && Math.round(o.refined) !== o.expected);
  console.log('\n-- beat-grid refinement (EXPERIMENT) on uncorrected tracks --');
  console.log(`  exact integer hit:  base ${baseHit}/${withRefined.length}  ->  refined ${refHit}/${withRefined.length}`);
  console.log(`  FIXED by refinement (was off, now exact): ${fixed.length}`);
  for (const o of fixed) console.log(`    + ${o.track}: ${Math.round(o.baseRaw)} -> ${Math.round(o.refined)} (truth ${o.expected})`);
  console.log(`  BROKEN by refinement (was exact, now off): ${broke.length}`);
  for (const o of broke) console.log(`    - ${o.track}: ${Math.round(o.baseRaw)} -> ${Math.round(o.refined)} (truth ${o.expected})`);
}

if (offBy1.length) {
  console.log('\n-- tracks whose ROUNDED base is >=1 off (the user-visible 1-BPM gap) --');
  for (const o of offBy1.slice(0, 40)) {
    const ref = Number.isFinite(o.refined) ? `  refined ${fmt(o.refined, 1)}` : '';
    console.log(`  ${o.track}: raw ${fmt(o.baseRaw)} vs truth ${o.expected}  (offset ${o.offset >= 0 ? '+' : ''}${fmt(o.offset)})${ref}`);
  }
  if (offBy1.length > 40) console.log(`  ... and ${offBy1.length - 40} more`);
}

if (correctedRows.length) {
  console.log('\n-- family-corrected tracks (separate question, not a rounding fix) --');
  for (const line of correctedRows.slice(0, 20)) console.log(line);
  if (correctedRows.length > 20) console.log(`  ... and ${correctedRows.length - 20} more`);
}

// ---- verdict ----------------------------------------------------------------

console.log('\n' + '='.repeat(72));
console.log('VERDICT');
console.log('='.repeat(72));
const absMean = Math.abs(m);
if (ge1 / offsets.length > 0.25) {
  console.log('ALGORITHMIC. A large share of raw floats are >=1 BPM from ground truth.');
  console.log('This is NOT a rounding problem — calibration cannot fix it. Investigate the');
  console.log('analysis window / resampling / estimator, and keep the integer pipeline as-is.');
} else if (absMean >= 0.2 && sd < 0.45) {
  console.log(`SYSTEMATIC SUB-INTEGER BIAS of ${m >= 0 ? '+' : ''}${fmt(m)} BPM (tight, stdev ${fmt(sd)}).`);
  console.log('Candidate for a small, measured pre-round calibration — but validate against the');
  console.log('full curated guardrail set first, and add it as a separate step before Math.round,');
  console.log('NOT by changing the correction-band integers.');
} else {
  console.log('NO SYSTEMATIC BIAS. Raw floats straddle ground truth with small spread; the');
  console.log('occasional 1-BPM gap is just .5-boundary rounding on individual tracks.');
  console.log('A global calibration would not help and could hurt. Leave the pipeline as-is.');
}
console.log('');
