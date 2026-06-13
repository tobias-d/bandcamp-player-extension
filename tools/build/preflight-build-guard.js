#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifySourceManifest } = require('./release-manifest-guard');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const CRITICAL_FILES = [
  'src/content/metadata/release/index.ts',
  'src/content/metadata/release/dom.ts',
  'src/content/metadata/release/hints.ts',
  'src/content/metadata/release/selectors.ts',
  'src/content/metadata/release/date.ts',
  'src/content/metadata/release/non-release-snapshot-gate.ts',
  'src/content/metadata/release/types.ts',
  'src/content/metadata/extractor/api/probe.ts',
];

function fail(message) {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}

function realPathSafe(inputPath) {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function runGit(args) {
  return spawnSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const projectRootReal = realPathSafe(PROJECT_ROOT);
const processCwdReal = realPathSafe(process.cwd());

if (processCwdReal !== projectRootReal) {
  fail(`Run commands from project root only.\nExpected: ${projectRootReal}\nCurrent:  ${processCwdReal}`);
}

for (const relativeFile of CRITICAL_FILES) {
  const absoluteFile = path.resolve(PROJECT_ROOT, relativeFile);
  if (!fs.existsSync(absoluteFile)) {
    fail(`Missing critical file: ${relativeFile}`);
  }
}

const inGitTree = runGit(['rev-parse', '--is-inside-work-tree']);
if (inGitTree.status !== 0 || inGitTree.stdout.trim() !== 'true') {
  fail('Git repository is required for preflight checks.');
}

for (const relativeFile of CRITICAL_FILES) {
  const tracked = runGit(['ls-files', '--error-unmatch', relativeFile]);
  if (tracked.status !== 0) {
    fail(`Critical file is not tracked by git: ${relativeFile}`);
  }
}

console.log(`[preflight] Workspace and critical-file checks passed (${CRITICAL_FILES.length} files).`);

const metadataProbeSource = fs.readFileSync(
  path.resolve(PROJECT_ROOT, 'src/content/metadata/extractor/api/probe.ts'),
  'utf8'
);

function assertSourceContains(source, required, description) {
  if (!source.includes(required)) {
    fail(`Metadata regression guard failed: missing ${description}.`);
  }
}

function assertSourceOrder(source, before, after, description) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex > afterIndex) {
    fail(`Metadata regression guard failed: ${description}.`);
  }
}

assertSourceContains(
  metadataProbeSource,
  'function shouldProbeLinkedReleaseUrlDirectly',
  'non-release linked-release probe gate'
);
assertSourceContains(
  metadataProbeSource,
  'fetchTralbumForIdentity(null, linkedReleaseUrl, trackId, rootGeneration)',
  'direct linked-release URL fetch'
);
assertSourceContains(
  metadataProbeSource,
  'linked-release-ready:',
  'linked-release success debug state'
);
assertSourceOrder(
  metadataProbeSource,
  'shouldProbeLinkedReleaseUrlDirectly({',
  'const nextTarget = candidates.find',
  'direct linked-release probe must run before generic candidate probing'
);

console.log('[preflight] Metadata linked-release regression guard passed.');

const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(PROJECT_ROOT, 'package.json'), 'utf8')
).version;

for (const contractName of ['chrome', 'firefox', 'firefox-dev']) {
  try {
    verifySourceManifest(PROJECT_ROOT, contractName, packageVersion);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

console.log(`[preflight] Version ${packageVersion} and browser manifest contracts verified.`);
