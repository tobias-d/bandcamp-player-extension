#!/usr/bin/env node
/**
 * Copies the custom Essentia WASM build (v2.1_beta5, compiled from C++ source)
 * over the npm-installed essentia.js WASM files.
 *
 * EXPERIMENTAL: This replaces the stock essentia.js v0.1.3 WASM with a custom
 * build from Essentia C++ v2.1_beta5 compiled via Emscripten 5.0.3.
 *
 * Improvements over stock build:
 *   - HarmonicPeaks bug fix (full harmonic series, not just octave harmonics)
 *   - New Key profiles: bgate, edmm, edma
 *   - HPCP thresholding and detuning correction
 *   - DYNAMIC_EXECUTION=0 (no new Function() calls, CSP-safe)
 *   - ~25% smaller UMD bundle, ~16% smaller WASM binary
 *
 * Build source: ~/essentia-wasm-build/essentia.js/builds/
 * To rebuild: see local rebuild notes for the custom Essentia WASM flow.
 */
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '..', '..', 'vendor', 'essentia-wasm-custom');
const DEST_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'essentia.js', 'dist');

const FILES = [
  'essentia-wasm.umd.js',
  'essentia-wasm.web.js',
  'essentia-wasm.web.wasm',
];

const UMD_BLOB_MARKER = 'function findWasmBinary(){return binaryDecode(';

function fail(msg) {
  console.error(`[copy-custom-essentia-wasm] ${msg}`);
  process.exit(1);
}

function escapeJsStringValue(value) {
  let escaped = '';

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code <= 0xff) {
      escaped += `\\x${code.toString(16).padStart(2, '0')}`;
      continue;
    }

    escaped += `\\u${code.toString(16).padStart(4, '0')}`;
  }

  return escaped;
}

function decodeEmbeddedWasm(value) {
  const bytes = Buffer.alloc(value.length);

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    bytes[i] = (~code >> 8) & code;
  }

  return bytes;
}

function extractStringLiteral(source, startIndex) {
  const quote = source[startIndex];

  if (quote !== '\'' && quote !== '"') {
    fail(`Unable to parse embedded WASM string literal at index ${startIndex}`);
  }

  let endIndex = startIndex + 1;
  let escaped = false;

  for (; endIndex < source.length; endIndex += 1) {
    const char = source[endIndex];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === quote) {
      return {
        literal: source.slice(startIndex, endIndex + 1),
        startIndex,
        endIndex: endIndex + 1
      };
    }
  }

  fail('Unable to find end of embedded WASM string literal');
}

function evaluateStringLiteral(literal) {
  try {
    return Function(`return ${literal}`)();
  } catch (error) {
    fail(
      `Unable to evaluate embedded WASM string literal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function sanitizeUmdEmbeddedWasm(filePath, wasmPath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const blobStart = source.indexOf(UMD_BLOB_MARKER);

  if (blobStart === -1) {
    fail(`Unable to find embedded WASM marker in ${filePath}`);
  }

  const literal = extractStringLiteral(source, blobStart + UMD_BLOB_MARKER.length);
  const embeddedValue = evaluateStringLiteral(literal.literal);
  const decodedEmbeddedWasm = decodeEmbeddedWasm(embeddedValue);
  const wasmBytes = fs.readFileSync(wasmPath);

  if (!decodedEmbeddedWasm.equals(wasmBytes)) {
    fail(`Embedded WASM in ${filePath} does not match ${wasmPath} before sanitizing`);
  }

  const escapedBlob = escapeJsStringValue(embeddedValue);
  const patched =
    source.slice(0, literal.startIndex + 1) +
    escapedBlob +
    source.slice(literal.endIndex - 1);

  fs.writeFileSync(filePath, patched, 'utf8');

  const sanitizedSource = fs.readFileSync(filePath, 'utf8');
  const sanitizedLiteral = extractStringLiteral(sanitizedSource, blobStart + UMD_BLOB_MARKER.length);
  const sanitizedValue = evaluateStringLiteral(sanitizedLiteral.literal);
  const decodedSanitizedWasm = decodeEmbeddedWasm(sanitizedValue);

  if (!decodedSanitizedWasm.equals(wasmBytes)) {
    fail(`Sanitized embedded WASM in ${filePath} no longer matches ${wasmPath}`);
  }
}

if (!fs.existsSync(BUILD_DIR)) {
  console.log('[copy-custom-essentia-wasm] No custom build found at vendor/essentia-wasm-custom/, using stock npm build');
  process.exit(0);
}

if (!fs.existsSync(DEST_DIR)) {
  fail(`Destination not found: ${DEST_DIR}. Run npm install first.`);
}

for (const file of FILES) {
  const src = path.join(BUILD_DIR, file);
  const dest = path.join(DEST_DIR, file);

  if (!fs.existsSync(src)) {
    fail(`Custom build file missing: ${src}`);
  }

  fs.copyFileSync(src, dest);

  if (file === 'essentia-wasm.umd.js') {
    sanitizeUmdEmbeddedWasm(dest, path.join(DEST_DIR, 'essentia-wasm.web.wasm'));
  }

  console.log(`[copy-custom-essentia-wasm] Copied ${file}`);
}

console.log('[copy-custom-essentia-wasm] Custom Essentia WASM build installed');
