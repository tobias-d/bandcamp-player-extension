#!/usr/bin/env node
// Single-command version bump (step 3 of the release workflow). Writes the new version into
// package.json and all three manifests so they stay in lockstep, then turns the accrued
// CHANGELOG.md "## Unreleased" notes into a dated release entry (or scaffolds a blank one if
// Unreleased is empty). It does NOT build, commit, or release — those stay manual.
//
// The CHANGELOG transform is a pure function (foldChangelog) exported for tests; the file I/O and
// git plumbing live under the require.main guard so importing this module has no side effects.
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

const VERSION_FIELD = /("version"\s*:\s*")([^"]+)(")/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pure CHANGELOG transforms (no file I/O) — exported and unit-tested.
// ---------------------------------------------------------------------------

// Guidance seed for a fresh Unreleased section. Kept as an HTML comment so it renders
// invisibly and is easy to detect-and-ignore when deciding whether Unreleased has content.
const UNRELEASED_SEED =
  '<!-- Accruing notes for the next release. Add a bullet here when you land something\n' +
  '     notable; `npm run bump <version>` folds this section into the dated entry below.\n' +
  '     Audience: people rebuilding the extension — keep the detail technical. -->';

function blankEntry(version, dateIso) {
  return (
    `## ${version} — ${dateIso}\n\n` +
    `_Summary — fill this in. Audience: people rebuilding the extension, so be specific._\n\n` +
    `Main improvements:\n` +
    `- Fill this in with enough technical detail to understand what changed and why.\n\n`
  );
}

// Locate the "## Unreleased" section and return its bounds plus the raw body, or null.
function findUnreleasedSection(text) {
  const header = text.match(/^## Unreleased[^\n]*$/m);
  if (!header) {
    return null;
  }
  const start = header.index;
  const afterHeader = start + header[0].length;
  const nextRel = text.slice(afterHeader).search(/\n## /);
  const end = nextRel === -1 ? text.length : afterHeader + nextRel;
  return { start, end, body: text.slice(afterHeader, end) };
}

// The body counts as empty when nothing but guidance/placeholders/blank bullets remains.
function unreleasedBodyIsEmpty(body) {
  const meaningful = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== 'Main improvements:' && !/^-\s*$/.test(line) && !/^_.*_$/.test(line));
  return meaningful.length === 0;
}

// Fold accrued Unreleased notes into the dated entry, or fall back to a blank scaffold.
// Returns { text, mode } where mode is 'folded' or 'scaffolded'. Pure: no file I/O.
function foldChangelog(text, version, dateIso) {
  const section = findUnreleasedSection(text);

  if (section && !unreleasedBodyIsEmpty(section.body)) {
    // Rename Unreleased -> dated entry, keep the accrued body, re-seed a fresh Unreleased on top.
    const accrued = section.body.replace(/<!--[\s\S]*?-->/g, '').trim();
    const next =
      `${text.slice(0, section.start)}` +
      `## Unreleased\n\n${UNRELEASED_SEED}\n\n` +
      `## ${version} — ${dateIso}\n\n${accrued}\n\n` +
      `${text.slice(section.end).replace(/^\n+/, '')}`;
    return { text: next, mode: 'folded' };
  }

  if (section) {
    // Empty Unreleased: keep it on top, drop the blank scaffold directly beneath it.
    const next =
      `${text.slice(0, section.end).replace(/\s+$/, '')}\n\n` +
      `${blankEntry(version, dateIso)}` +
      `${text.slice(section.end).replace(/^\n+/, '')}`;
    return { text: next, mode: 'scaffolded' };
  }

  // No Unreleased section at all: insert the blank scaffold above the newest entry.
  const marker = text.indexOf('\n## ');
  const next = marker === -1
    ? `${text.trimEnd()}\n\n${blankEntry(version, dateIso)}`
    : `${text.slice(0, marker + 1)}${blankEntry(version, dateIso)}${text.slice(marker + 1)}`;
  return { text: next, mode: 'scaffolded' };
}

module.exports = { foldChangelog, findUnreleasedSection, unreleasedBodyIsEmpty, blankEntry, UNRELEASED_SEED };

// ---------------------------------------------------------------------------
// CLI — only runs when invoked directly (npm run bump), never on import.
// ---------------------------------------------------------------------------

function main() {
  function fail(message) {
    console.error(`[bump-version] ${message}`);
    process.exit(1);
  }

  const version = String(process.argv[2] || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`Usage: npm run bump <version>  (e.g. npm run bump 3.7.0). Got: "${process.argv[2] || ''}"`);
  }

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

  function changelogHasEntry(text) {
    return new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(text);
  }

  // Best-effort: list the commits since the previous version was committed, so there is concrete
  // raw material to write the entry from. Falls back to a hint if git or the prior commit is absent.
  function commitsSincePreviousVersion(currentVersion) {
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

  // Validate everything before writing anything, so a rejected bump leaves the tree untouched.
  const currentVersion = readVersionField(VERSION_FILES[0]);
  if (currentVersion === version) {
    fail(`Already at version ${version} (in ${VERSION_FILES[0]}). Pass a new version.`);
  }
  const changelogText = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  if (changelogHasEntry(changelogText)) {
    fail(`CHANGELOG.md already has an entry for ${version}`);
  }

  for (const relPath of VERSION_FILES) {
    bumpVersionField(relPath);
  }
  const { text: nextChangelog, mode } = foldChangelog(changelogText, version, todayIso());
  fs.writeFileSync(CHANGELOG_PATH, nextChangelog);

  const changelogNote = mode === 'folded'
    ? 'folded the Unreleased section into a dated CHANGELOG.md entry'
    : 'scaffolded a blank CHANGELOG.md entry';
  console.log(`[bump-version] Set version ${version} in ${VERSION_FILES.length} files and ${changelogNote}.`);
  console.log('');
  console.log('  Before you publish this release, review:');
  console.log(`   1. The version history since ${currentVersion} — make sure every notable change is captured.`);
  console.log('   2. The CHANGELOG.md entry — it is read by people rebuilding the extension, so write');
  console.log('      enough technical detail to understand what changed and why.');
  console.log(`   3. After you build (npm run release:all) and ship, tag the release commit:`);
  console.log(`        git tag v${version} && git push origin v${version}`);
  console.log('');

  const commits = commitsSincePreviousVersion(currentVersion);
  if (commits) {
    console.log(`  Commits since ${currentVersion}:`);
    for (const line of commits.split('\n')) {
      console.log(`    ${line}`);
    }
  } else {
    console.log('  Review recent history with:  git log --oneline -20');
  }
}

if (require.main === module) {
  main();
}
