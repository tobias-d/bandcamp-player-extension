#!/usr/bin/env node
// Single-command version bump (step 3 of the release workflow). Writes the new version into
// package.json and all three manifests so they stay in lockstep, then scaffolds an empty dated
// CHANGELOG.md entry to fill in. It does NOT build, commit, or release — those stay manual.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CHANGELOG_PATH = path.resolve(PROJECT_ROOT, 'CHANGELOG.md');

// Every file whose "version" field must match the released version.
const VERSION_FILES = [
  'package.json',
  'src/manifest.json',
  'src/manifest.firefox.json',
  'src/manifest.firefox.dev.json'
];

function fail(message) {
  console.error(`[bump-version] ${message}`);
  process.exit(1);
}

const version = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`Usage: npm run bump <version>  (e.g. npm run bump 3.7.0). Got: "${process.argv[2] || ''}"`);
}

const VERSION_FIELD = /("version"\s*:\s*")([^"]+)(")/;

function readVersionField(relPath) {
  const match = fs.readFileSync(path.resolve(PROJECT_ROOT, relPath), 'utf8').match(VERSION_FIELD);
  if (!match) {
    fail(`No "version" field found in ${relPath}`);
  }
  return match[2];
}

function bumpVersionField(relPath) {
  const filePath = path.resolve(PROJECT_ROOT, relPath);
  const text = fs.readFileSync(filePath, 'utf8');
  // Targeted replace of the first "version" field only, so JSON formatting and key order are kept.
  fs.writeFileSync(filePath, text.replace(VERSION_FIELD, `$1${version}$3`));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function changelogHasEntry(text) {
  return new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(text);
}

function prependChangelogEntry() {
  const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const entry =
    `## ${version} — ${todayIso()}\n\n` +
    `_Summary — fill this in. Audience: people rebuilding the extension, so be specific._\n\n` +
    `Main improvements:\n` +
    `- Fill this in with enough technical detail to understand what changed and why.\n\n`;
  // Insert above the most recent existing entry so newest stays on top.
  const marker = text.indexOf('\n## ');
  const next = marker === -1
    ? `${text.trimEnd()}\n\n${entry}`
    : `${text.slice(0, marker + 1)}${entry}${text.slice(marker + 1)}`;
  fs.writeFileSync(CHANGELOG_PATH, next);
}

// Validate everything before writing anything, so a rejected bump leaves the tree untouched.
const currentVersion = readVersionField(VERSION_FILES[0]);
if (currentVersion === version) {
  fail(`Already at version ${version} (in ${VERSION_FILES[0]}). Pass a new version.`);
}
if (changelogHasEntry(fs.readFileSync(CHANGELOG_PATH, 'utf8'))) {
  fail(`CHANGELOG.md already has an entry for ${version}`);
}

for (const relPath of VERSION_FILES) {
  bumpVersionField(relPath);
}
prependChangelogEntry();

// Best-effort: list the commits since the previous version was committed, so there is concrete
// raw material to write the entry from. Falls back to a hint if git or the prior commit is absent.
function commitsSincePreviousVersion() {
  if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
    return null;
  }
  try {
    // The pickaxe finds the commit that introduced the previous version string in package.json.
    const prevCommit = childProcess
      .execSync(`git log -1 --format=%H -S'"version": "${currentVersion}"' -- package.json`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      .trim();
    if (!prevCommit) {
      return null;
    }
    // Scope to this project subtree so unrelated commits in the repo are excluded.
    const log = childProcess
      .execSync(`git log --oneline ${prevCommit}..HEAD -- .`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      .trim();
    return log || null;
  } catch {
    return null;
  }
}

console.log(`[bump-version] Set version ${version} in ${VERSION_FILES.length} files and scaffolded a CHANGELOG.md entry.`);
console.log('');
console.log('  Before you publish this release, review:');
console.log(`   1. The version history since ${currentVersion} — make sure every notable change is captured.`);
console.log('   2. The CHANGELOG.md entry — it is read by people rebuilding the extension, so write');
console.log('      enough technical detail to understand what changed and why.');
console.log('');

const commits = commitsSincePreviousVersion();
if (commits) {
  console.log(`  Commits since ${currentVersion}:`);
  for (const line of commits.split('\n')) {
    console.log(`    ${line}`);
  }
} else {
  console.log('  Review recent history with:  git log --oneline -20');
}
