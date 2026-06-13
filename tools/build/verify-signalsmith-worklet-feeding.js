#!/usr/bin/env node
/**
 * Verifies the multi-chunk feeding-loop patch in generate-signalsmith-worklet.js #7 is
 * correct AND does not change single-track playback. This is the safety proof for chunked /
 * incremental feeding (a track fed as several addBuffers slices = a multi-chunk timeline).
 *
 * Machine-independent: it runs the REAL feeding loop extracted from the generated worklet.js
 * inside a mock of the worklet's process() locals, and builds two variants from the same
 * scaffold — patched (the fix) and original (pre-patch body restored) — checking both against
 * a ground-truth concatenated read.
 *
 * Run: node tools/build/verify-signalsmith-worklet-feeding.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WORKLET_PATH = path.resolve(
  __dirname, '..', '..', 'vendor', 'signalsmith', 'worklet.js'
);

const source = fs.readFileSync(WORKLET_PATH, 'utf8');

const SCAFFOLD_RE =
  /let buffers = outputList\[0\]\.map[\s\S]*?if \(blockSamples < this\.bufferLength\) \{[\s\S]*?\}\n/;
const scaffoldMatch = source.match(SCAFFOLD_RE);
if (!scaffoldMatch) {
  console.error('FAIL: could not locate the feeding-loop scaffold in worklet.js.');
  process.exit(1);
}
const patchedScaffold = scaffoldMatch[0];

if (!patchedScaffold.includes('this.bufferLength - blockSamples') ||
    !patchedScaffold.includes('if (blockSamples >= this.bufferLength) break;')) {
  console.error('FAIL: generated worklet.js lacks the multi-chunk feeding-loop patch. Run `node tools/build/generate-signalsmith-worklet.js`.');
  process.exit(1);
}

const PATCHED_BODY_RE =
  /let count = Math\.min\(audioBuffer\[0\]\.length - startIndex, this\.bufferLength - blockSamples\);[\s\S]*?if \(blockSamples >= this\.bufferLength\) break;/;
const ORIGINAL_BODY = [
  'let count = Math.min(audioBuffer[0].length - startIndex, inputSamplesEnd - inputSamples);',
  '\t\t\t\t\tif (count > 0) {',
  '\t\t\t\t\t\tbuffers.forEach((buffer, c) => {',
  '\t\t\t\t\t\t\tlet channelBuffer = audioBuffer[c%audioBuffer.length];',
  '\t\t\t\t\t\t\tbuffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));',
  '\t\t\t\t\t\t});',
  '\t\t\t\t\t\taudioSamples += count;',
  '\t\t\t\t\t\tblockSamples += count;',
  '\t\t\t\t\t} else { // already past this buffer - skip it',
  '\t\t\t\t\t\taudioSamples += audioBuffer[0].length;',
  '\t\t\t\t\t}',
  '\t\t\t\t\t++audioBufferIndex;'
].join('\n');
if (!PATCHED_BODY_RE.test(patchedScaffold)) {
  console.error('FAIL: could not isolate the patched loop body for the A/B comparison.');
  process.exit(1);
}
const originalScaffold = patchedScaffold.replace(PATCHED_BODY_RE, ORIGINAL_BODY);

function buildLoopFn(scaffold) {
  const body = scaffold + '\n;return { buffers: buffers, blockSamples: blockSamples };';
  // eslint-disable-next-line no-new-func
  return new Function('memory', 'outputList', 'sampleRate', 'inputSamplesEnd', body);
}
const runPatched = buildLoopFn(patchedScaffold);
const runOriginal = buildLoopFn(originalScaffold);

const CHANNELS = 2;
const BUFFER_LENGTH = 1024;

const sampleValue = (chunkIdx, i, c) => chunkIdx * 1e6 + i + (c === 1 ? 0.25 : 0);

function makeChunk(chunkIdx, length) {
  const chans = [];
  for (let c = 0; c < CHANNELS; c++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) arr[i] = sampleValue(chunkIdx, i, c);
    chans.push(arr);
  }
  return chans;
}

function groundTruth(audioBuffers, audioBuffersStart, inputSamplesEnd) {
  const out = [];
  for (let c = 0; c < CHANNELS; c++) out.push(new Float32Array(BUFFER_LENGTH));
  const windowStart = inputSamplesEnd - BUFFER_LENGTH;
  for (let j = 0; j < BUFFER_LENGTH; j++) {
    const abs = windowStart + j;
    if (abs < audioBuffersStart) continue;
    let pos = abs - audioBuffersStart;
    for (const chunk of audioBuffers) {
      const len = chunk[0].length;
      if (pos < len) {
        for (let c = 0; c < CHANNELS; c++) out[c][j] = chunk[c][pos];
        break;
      }
      pos -= len;
    }
  }
  return out;
}

function makeCtx(audioBuffers, audioBuffersStart) {
  const memory = new ArrayBuffer(CHANNELS * BUFFER_LENGTH * 4);
  const buffersIn = [];
  for (let c = 0; c < CHANNELS; c++) buffersIn.push(c * BUFFER_LENGTH * 4);
  return {
    memory,
    outputList: [new Array(CHANNELS).fill(0)],
    ctx: { bufferLength: BUFFER_LENGTH, buffersIn, audioBuffers, audioBuffersStart }
  };
}

function readDest(memory) {
  const out = [];
  for (let c = 0; c < CHANNELS; c++) out.push(new Float32Array(memory, c * BUFFER_LENGTH * 4, BUFFER_LENGTH));
  return out;
}

function channelsEqual(a, b) {
  for (let c = 0; c < CHANNELS; c++) {
    if (a[c].length !== b[c].length) return false;
    for (let i = 0; i < a[c].length; i++) if (a[c][i] !== b[c][i]) return false;
  }
  return true;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

function runVariant(fn, audioBuffers, audioBuffersStart, inputSamplesEnd) {
  const { memory, outputList, ctx } = makeCtx(audioBuffers, audioBuffersStart);
  try {
    fn.call(ctx, memory, outputList, 44100, inputSamplesEnd);
    return { threw: false, dest: readDest(memory) };
  } catch (err) {
    return { threw: true, error: err };
  }
}

console.log('\n(a) single-track playback unchanged (1 chunk):');
for (const tc of [
  { name: 'steady read inside the track', start: 0, len: 5000, end: 3000 },
  { name: 'leading zero-pad', start: 2000, len: 5000, end: 2500 },
  { name: 'trailing zero-fill', start: 0, len: 5000, end: 5200 }
]) {
  const chunks = [makeChunk(0, tc.len)];
  const truth = groundTruth(chunks, tc.start, tc.end);
  const p = runVariant(runPatched, chunks, tc.start, tc.end);
  const o = runVariant(runOriginal, chunks, tc.start, tc.end);
  check(`${tc.name}: patched == ground truth`, !p.threw && channelsEqual(p.dest, truth), p.threw ? String(p.error) : 'mismatch');
  check(`${tc.name}: patched byte-identical to pre-patch`, !o.threw && !p.threw && channelsEqual(p.dest, o.dest), o.threw ? 'orig threw' : 'differs');
}

console.log('\n(b) multi-chunk timeline (one track fed as several slices):');
for (const tc of [
  { name: 'read straddles a slice boundary', a: 2000, b: 2000, end: 2400 },
  { name: 'block fills from slice 1 with slice 2 present', a: 4000, b: 2000, end: 3000 }
]) {
  const chunks = [makeChunk(0, tc.a), makeChunk(1, tc.b)];
  const truth = groundTruth(chunks, 0, tc.end);
  const p = runVariant(runPatched, chunks, 0, tc.end);
  const o = runVariant(runOriginal, chunks, 0, tc.end);
  check(`${tc.name}: patched no throw + matches truth`, !p.threw && channelsEqual(p.dest, truth), p.threw ? 'patched threw: ' + p.error : 'mismatch');
  check(`${tc.name}: pre-patch throws RangeError (the bug)`, o.threw && o.error instanceof RangeError, o.threw ? 'non-RangeError: ' + o.error : 'did NOT throw');
}

console.log('\n(c) many small slices (the chunked-feed shape):');
{
  // 20 slices of ~700 frames = one track fed incrementally; read across an interior boundary.
  const chunks = [];
  for (let k = 0; k < 20; k++) chunks.push(makeChunk(k, 700));
  const total = 20 * 700;
  for (const end of [1500, 5000, 9000, total]) {
    const truth = groundTruth(chunks, 0, end);
    const p = runVariant(runPatched, chunks, 0, end);
    check(`read ending at ${end}: patched no throw + matches truth`, !p.threw && channelsEqual(p.dest, truth), p.threw ? 'threw: ' + p.error : 'mismatch');
  }
}

console.log('');
if (failures > 0) {
  console.error(`RESULT: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('RESULT: all checks passed — feeding-loop fix verified (single-track unchanged; chunked multi-slice safe).');
