// Unit tests for the pure CHANGELOG transform in bump-version.js.
// Run with: npm test  (uses Node's built-in test runner — no dependencies).
const test = require('node:test');
const assert = require('node:assert/strict');

const { foldChangelog, unreleasedBodyIsEmpty, UNRELEASED_SEED } = require('./bump-version');

const VERSION = '3.8.0';
const DATE = '2026-07-01';

// Return the body of the "## <heading>" section up to the next "## " (or end of text).
function sectionBody(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `expected a "## ${heading}" section`);
  const afterHeader = start + text.slice(start).indexOf('\n');
  const rest = text.slice(afterHeader);
  const nextRel = rest.search(/\n## /);
  return nextRel === -1 ? rest : rest.slice(0, nextRel);
}

const WITH_NOTES = `# Changelog

Intro paragraph describing the file.

## Unreleased

${UNRELEASED_SEED}

Main improvements:
- First real note about the resolver.
- Second note about a Firefox race.

## 3.7.0 — 2026-06-26

Version \`3.7.0\` reworks Settings.

Main improvements:
- An older shipped bullet.
`;

const EMPTY_UNRELEASED = `# Changelog

Intro paragraph.

## Unreleased

${UNRELEASED_SEED}

## 3.7.0 — 2026-06-26

Version \`3.7.0\` reworks Settings.
`;

const NO_UNRELEASED = `# Changelog

Intro paragraph.

## 3.7.0 — 2026-06-26

Version \`3.7.0\` reworks Settings.
`;

test('folds accrued Unreleased notes into a dated entry', () => {
  const { text, mode } = foldChangelog(WITH_NOTES, VERSION, DATE);

  assert.equal(mode, 'folded');
  // Exactly one Unreleased section survives (a fresh empty one, re-seeded on top).
  assert.equal(text.match(/^## Unreleased/gm).length, 1);
  // The dated entry exists and carries the accrued notes.
  const dated = sectionBody(text, `${VERSION} — ${DATE}`);
  assert.match(dated, /First real note about the resolver\./);
  assert.match(dated, /Second note about a Firefox race\./);
  // The guidance comment is stripped from the released entry...
  assert.doesNotMatch(dated, /<!--/);
  // ...but the fresh Unreleased section keeps the seed and drops the moved notes.
  const fresh = sectionBody(text, 'Unreleased');
  assert.match(fresh, /<!--/);
  assert.doesNotMatch(fresh, /First real note/);
});

test('preserves ordering: Unreleased > new entry > previous entry', () => {
  const { text } = foldChangelog(WITH_NOTES, VERSION, DATE);
  const iUnreleased = text.indexOf('## Unreleased');
  const iNew = text.indexOf(`## ${VERSION} — ${DATE}`);
  const iPrev = text.indexOf('## 3.7.0');
  assert.ok(iUnreleased < iNew, 'Unreleased should stay on top');
  assert.ok(iNew < iPrev, 'new entry should sit above the previous release');
  // The old entry's content is untouched.
  assert.match(text, /An older shipped bullet\./);
});

test('scaffolds a blank entry when Unreleased is empty, keeping Unreleased on top', () => {
  const { text, mode } = foldChangelog(EMPTY_UNRELEASED, VERSION, DATE);

  assert.equal(mode, 'scaffolded');
  assert.equal(text.match(/^## Unreleased/gm).length, 1);
  const iUnreleased = text.indexOf('## Unreleased');
  const iNew = text.indexOf(`## ${VERSION} — ${DATE}`);
  assert.ok(iUnreleased < iNew, 'empty Unreleased should remain above the new entry');
  assert.match(sectionBody(text, `${VERSION} — ${DATE}`), /Fill this in/);
});

test('scaffolds above the newest entry when there is no Unreleased section', () => {
  const { text, mode } = foldChangelog(NO_UNRELEASED, VERSION, DATE);

  assert.equal(mode, 'scaffolded');
  const iNew = text.indexOf(`## ${VERSION} — ${DATE}`);
  const iPrev = text.indexOf('## 3.7.0');
  assert.ok(iNew !== -1 && iNew < iPrev, 'new entry should sit above the previous release');
  // The intro / title is not clobbered.
  assert.match(text, /^# Changelog/);
});

test('does not duplicate a manifest version into the changelog header line', () => {
  // Guards against the "## Unreleased" matcher accidentally swallowing the title.
  const { text } = foldChangelog(WITH_NOTES, VERSION, DATE);
  assert.match(text, /^# Changelog\n/);
});

test('unreleasedBodyIsEmpty treats guidance/placeholders as empty', () => {
  assert.equal(unreleasedBodyIsEmpty(`\n\n${UNRELEASED_SEED}\n`), true);
  assert.equal(unreleasedBodyIsEmpty('\n\nMain improvements:\n- \n'), true);
  assert.equal(unreleasedBodyIsEmpty('\n_placeholder line_\n'), true);
  assert.equal(unreleasedBodyIsEmpty('\n'), true);
});

test('unreleasedBodyIsEmpty detects a real bullet', () => {
  assert.equal(unreleasedBodyIsEmpty('\n- A genuine change.\n'), false);
  assert.equal(unreleasedBodyIsEmpty(`${UNRELEASED_SEED}\n- A genuine change.\n`), false);
});
