#!/usr/bin/env node
/**
 * Generates vendor/signalsmith/worklet.js from the signalsmith-stretch package.
 *
 * Signalsmith uses URL.createObjectURL(new Blob([workletCode])) to load its AudioWorklet
 * processor. In Firefox extension pages, addModule() with a blob: URL hangs indefinitely.
 * This script captures the generated worklet code and writes it as a static file so that
 * the extension iframe can load it via a real moz-extension:// URL instead.
 *
 * How it works:
 *   1. Patches globalThis.Blob to intercept construction with {type:'text/javascript'}.
 *   2. Imports signalsmith-stretch (ESM) and calls it with a minimal mock AudioContext.
 *   3. AudioWorkletNode is not defined in Node.js → the catch path in Signalsmith runs,
 *      calling new Blob([workletCode]) which we intercept.
 *   4. Writes the captured code to vendor/signalsmith/worklet.js.
 *
 * Run before webpack so CopyWebpackPlugin picks up the generated file.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'vendor', 'signalsmith', 'worklet.js');

async function main() {
  // ---------------------------------------------------------------------------
  // 1. Intercept Blob construction to capture the worklet code string.
  // ---------------------------------------------------------------------------
  let capturedWorkletCode = null;

  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class PatchedBlob extends OriginalBlob {
    constructor(blobParts, options) {
      super(blobParts, options);
      if (
        capturedWorkletCode === null &&
        options &&
        options.type === 'text/javascript' &&
        Array.isArray(blobParts) &&
        typeof blobParts[0] === 'string'
      ) {
        capturedWorkletCode = blobParts[0];
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 2. Minimal mock AudioContext.
  //    audioWorklet.addModule must return a resolved Promise so the await doesn't hang.
  //    AudioWorkletNode is NOT defined in Node.js — that ReferenceError is what puts
  //    Signalsmith's createNode() into the catch branch where the Blob is created.
  // ---------------------------------------------------------------------------
  const mockCtx = {
    audioWorklet: {
      addModule(_url) {
        return Promise.resolve();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 3. Import Signalsmith and trigger the Blob-creation code path.
  // ---------------------------------------------------------------------------
  const signalsmithPath = path.resolve(
    __dirname,
    '..',
    '..',
    'node_modules',
    'signalsmith-stretch',
    'SignalsmithStretch.mjs'
  );

  let SignalsmithStretch;
  try {
    ({ default: SignalsmithStretch } = await import(signalsmithPath));
  } catch (importErr) {
    throw new Error(`Failed to import SignalsmithStretch: ${importErr.message}`);
  }

  // Calling SignalsmithStretch (= createNode) will:
  //   a) try new AudioWorkletNode(mockCtx, ...)  → ReferenceError (not defined in Node)
  //   b) catch → create worklet Blob (intercepted above) → set mockCtx[promiseKey] = addModule(...)
  //   c) await addModule → resolves immediately
  //   d) try new AudioWorkletNode again → ReferenceError again (uncaught → promise rejects)
  // We catch the rejection because we already captured what we needed in step (b).
  await SignalsmithStretch(mockCtx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  }).catch(() => undefined);

  // ---------------------------------------------------------------------------
  // 4. Restore Blob and write output.
  // ---------------------------------------------------------------------------
  globalThis.Blob = OriginalBlob;

  if (!capturedWorkletCode) {
    throw new Error(
      'Blob with type text/javascript was never constructed — worklet code not captured.\n' +
      'The signalsmith-stretch API may have changed.'
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Patch: branch-1 dead-code crash fix for numberOfInputs:0
  //
  // In the inactive branch (active:false), the worklet reads
  //   let channelBuffer = inputs[c%inputs.length];
  // but `inputs` is undefined when numberOfInputs:0 (spec: inputs array has
  // exactly numberOfInputs elements, so inputs[0] is undefined).  `channelBuffer`
  // is never used in that branch — it's dead code.  Remove it so the processor
  // doesn't throw a TypeError and die silently before PLAY arrives.
  // ---------------------------------------------------------------------------
  const DEAD_CODE_PATTERN = /let channelBuffer = inputs\[c%inputs\.length\];\s*\n(\s*)let buffer = new Float32Array\(memory, this\.buffersIn\[c\], outputBlockSize\);\s*\n\s*buffer\.fill\(0\);/;
  const DEAD_CODE_REPLACEMENT = 'let buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);\n$1buffer.fill(0);';
  let patched = capturedWorkletCode.replace(DEAD_CODE_PATTERN, DEAD_CODE_REPLACEMENT);
  if (patched === capturedWorkletCode) {
    throw new Error(
      'branch-1 dead-code patch did not match — worklet source may have changed. ' +
      'Update DEAD_CODE_PATTERN to match the current signalsmith-stretch worklet output.'
    );
  } else {
    console.log('[generate-signalsmith-worklet] applied branch-1 dead-code patch (numberOfInputs:0 crash fix)');
  }

  // ---------------------------------------------------------------------------
  // 6. Patch: discard replaced input buffers and DSP history inside the worklet.
  //
  // Signalsmith's public dropBuffers() transfers every removed Float32Array back
  // to the main thread. Runtime playback replaces a whole decoded track and does
  // not reuse that removed audio, so the transfer is pure switch-time work. A new
  // track also cannot inherit the stretcher's sample history from the old track.
  // Keep the public method intact and add a host-only full-reset method.
  // ---------------------------------------------------------------------------
  const DROP_BUFFERS_METHOD = 'dropBuffers: toSeconds => {';
  const CLEAR_BUFFERS_METHOD =
    'clearBuffers: () => {\n' +
    '\t\t\t\t\tthis.audioBuffers = [];\n' +
    '\t\t\t\t\tthis.audioBuffersStart = this.audioBuffersEnd = 0;\n' +
    '\t\t\t\t\tthis.wasmModule._reset();\n' +
    '\t\t\t\t\treturn {start: 0, end: 0, dspReset: true};\n' +
    '\t\t\t\t},\n' +
    '\t\t\t\t';
  if (!patched.includes(DROP_BUFFERS_METHOD)) {
    throw new Error(
      'clearBuffers patch did not match — worklet source may have changed. ' +
      'Update DROP_BUFFERS_METHOD to match the current signalsmith-stretch worklet output.'
    );
  }
  patched = patched.replace(DROP_BUFFERS_METHOD, `${CLEAR_BUFFERS_METHOD}${DROP_BUFFERS_METHOD}`);
  console.log('[generate-signalsmith-worklet] applied clearBuffers patch (no discarded PCM transfer, DSP reset)');

  // ---------------------------------------------------------------------------
  // 7. Patch: multi-chunk feeding-loop fix (enables chunked/incremental feeding).
  //
  // The buffered-playback feeding loop copies from this.audioBuffers (a list of
  // appended chunks) into a fixed-size heap view `buffers` of length
  // this.bufferLength. Upstream bounds the per-copy `count` by the constant
  // `inputSamplesEnd - inputSamples` and advances the chunk start by `count`
  // while never advancing the read cursor across chunks. With ONE chunk the loop
  // runs once and ends, so normal single-chunk playback is unaffected (byte
  // identical). With TWO+ chunks (a track fed as several addBuffers slices) the
  // loop fills the block from chunk 1, then continues into chunk 2 and runs
  // `buffer.subarray(this.bufferLength).set(<count samples>)` — a copy into a
  // zero-length tail → "RangeError: source array is too long".
  //
  // Fix: clamp the copy by the remaining destination (this.bufferLength -
  // blockSamples), advance the read cursor (inputSamples) by the copied count,
  // advance the chunk start by the whole chunk length so concatenated chunk
  // boundaries line up, and break once the block is full. Verified by
  // tools/build/verify-signalsmith-worklet-feeding.js.
  // ---------------------------------------------------------------------------
  const FEED_LOOP_OLD = [
    '\t\t\t\t\t// how many samples to copy: min(how many left in the buffer, how many more we need)',
    '\t\t\t\t\tlet count = Math.min(audioBuffer[0].length - startIndex, inputSamplesEnd - inputSamples);',
    '\t\t\t\t\tif (count > 0) {',
    '\t\t\t\t\t\tbuffers.forEach((buffer, c) => {',
    '\t\t\t\t\t\t\tlet channelBuffer = audioBuffer[c%audioBuffer.length];',
    '\t\t\t\t\t\t\tbuffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));',
    '\t\t\t\t\t\t});',
    '\t\t\t\t\t\taudioSamples += count;',
    '\t\t\t\t\t\tblockSamples += count;',
    '\t\t\t\t\t} else { // we\'re already past this buffer - skip it',
    '\t\t\t\t\t\taudioSamples += audioBuffer[0].length;',
    '\t\t\t\t\t}',
    '\t\t\t\t\t++audioBufferIndex;'
  ].join('\n');
  const FEED_LOOP_NEW = [
    '\t\t\t\t\t// how many samples to copy: min(how many are left in this chunk, how much',
    '\t\t\t\t\t// destination space remains). Clamping by the remaining destination',
    '\t\t\t\t\t// (this.bufferLength - blockSamples) instead of a constant is the multi-chunk',
    '\t\t\t\t\t// feeding-loop fix (see generate-signalsmith-worklet.js patch #7).',
    '\t\t\t\t\tlet count = Math.min(audioBuffer[0].length - startIndex, this.bufferLength - blockSamples);',
    '\t\t\t\t\tif (count > 0) {',
    '\t\t\t\t\t\tbuffers.forEach((buffer, c) => {',
    '\t\t\t\t\t\t\tlet channelBuffer = audioBuffer[c%audioBuffer.length];',
    '\t\t\t\t\t\t\tbuffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));',
    '\t\t\t\t\t\t});',
    '\t\t\t\t\t\tinputSamples += count;',
    '\t\t\t\t\t\tblockSamples += count;',
    '\t\t\t\t\t}',
    '\t\t\t\t\t// advance to the next chunk\'s absolute start by the whole chunk length so',
    '\t\t\t\t\t// concatenated chunk boundaries line up, then stop once the block is full',
    '\t\t\t\t\taudioSamples += audioBuffer[0].length;',
    '\t\t\t\t\t++audioBufferIndex;',
    '\t\t\t\t\tif (blockSamples >= this.bufferLength) break;'
  ].join('\n');
  if (!patched.includes(FEED_LOOP_OLD)) {
    throw new Error(
      'multi-chunk feeding-loop patch did not match — worklet source may have changed. ' +
      'Update FEED_LOOP_OLD to match the current signalsmith-stretch worklet output.'
    );
  }
  patched = patched.replace(FEED_LOOP_OLD, FEED_LOOP_NEW);
  console.log('[generate-signalsmith-worklet] applied multi-chunk feeding-loop patch (chunked feeding safe)');

  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, patched, 'utf8');

  const kb = (patched.length / 1024).toFixed(1);
  console.log(`[generate-signalsmith-worklet] wrote ${path.relative(process.cwd(), OUTPUT_PATH)} (${kb} kB)`);
}

main().catch(err => {
  console.error('[generate-signalsmith-worklet] FAILED:', err.message || err);
  process.exit(1);
});
