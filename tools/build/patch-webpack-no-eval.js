#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = String(process.argv[2] || '').trim().toLowerCase();
if (target !== 'firefox' && target !== 'chrome') {
  console.error('[patch-webpack-no-eval] Usage: node patch-webpack-no-eval.js <firefox|chrome>');
  process.exit(1);
}

const dist = path.resolve(__dirname, '..', '..', 'dist', target);

const targets = [
  path.join(dist, 'background', 'index.js'),
  path.join(dist, 'background', 'analysis-worker.js'),
  path.join(dist, 'content', 'player', 'index.js'),
  path.join(dist, 'content', 'discover', 'index.js'),
  path.join(dist, 'public', 'runtime-audio-host.js'),
  ...(target === 'chrome' ? [path.join(dist, 'offscreen', 'analysis-host.js')] : [])
];

const runtimePattern = /if\("object"==typeof globalThis\)return globalThis;try\{return this\|\|new Function\("return this"\)\(\)\}catch\((\w+)\)\{if\("object"==typeof window\)return window\}/g;

for (const file of targets) {
  if (!fs.existsSync(file)) {
    continue;
  }

  const source = fs.readFileSync(file, 'utf8');
  const patched = source.replace(
    runtimePattern,
    'if("object"==typeof globalThis)return globalThis;if("object"==typeof self)return self;if("object"==typeof window)return window;if("object"==typeof global)return global;try{return this}catch($1){}'
  );

  if (patched !== source) {
    fs.writeFileSync(file, patched);
    console.log(`[patch-webpack-no-eval] patched ${path.relative(process.cwd(), file)}`);
  }

  if (patched.includes('new Function("return this")()')) {
    console.error(`[patch-webpack-no-eval] failed: remaining new Function in ${file}`);
    process.exit(1);
  }
}
