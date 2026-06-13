#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyBuiltManifest } = require('./release-manifest-guard');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DIST_BASE_DIR = path.resolve(PROJECT_ROOT, 'dist');
const RELEASES_DIR = path.resolve(PROJECT_ROOT, 'releases');
const PACKAGE_JSON_PATH = path.resolve(PROJECT_ROOT, 'package.json');

function fail(message) {
  console.error(`[capture-release] ${message}`);
  process.exit(1);
}

function readPackageVersion() {
  if (!fs.existsSync(PACKAGE_JSON_PATH)) {
    fail(`Missing package.json at ${PACKAGE_JSON_PATH}`);
  }
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!version) {
    fail('package.json is missing a version');
  }
  return version;
}

function parseBrowserArg() {
  const raw = String(process.argv[2] || '').trim().toLowerCase();
  if (raw === 'firefox' || raw === 'chrome') {
    return raw;
  }
  fail('Usage: node tools/build/capture-release.js <firefox|chrome>');
}

function ensureZipAvailable() {
  try {
    childProcess.execFileSync('zip', ['-v'], {
      stdio: 'ignore'
    });
  } catch {
    fail('The `zip` command is required to package release artifacts.');
  }
}

function createZipFromDist(distDir, outputPath) {
  fs.rmSync(outputPath, { force: true });
  childProcess.execFileSync('zip', ['-qr', outputPath, '.'], {
    cwd: distDir,
    stdio: 'inherit'
  });
}

function main() {
  const browser = parseBrowserArg();
  const version = readPackageVersion();
  const DIST_DIR = path.resolve(DIST_BASE_DIR, browser);

  if (!fs.existsSync(DIST_DIR)) {
    fail(`Build output missing at ${DIST_DIR}. Run the browser build first.`);
  }

  try {
    verifyBuiltManifest(PROJECT_ROOT, browser, version);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  ensureZipAvailable();

  const targetDir = path.resolve(RELEASES_DIR, browser);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.rmSync(path.resolve(targetDir, version), { recursive: true, force: true });

  const baseName = `bandcamp-deck-${browser}-${version}`;
  const zipPath = path.resolve(targetDir, `${baseName}.zip`);
  createZipFromDist(DIST_DIR, zipPath);

  if (browser === 'firefox') {
    const xpiPath = path.resolve(targetDir, `${baseName}.xpi`);
    createZipFromDist(DIST_DIR, xpiPath);
    console.log(
      `[capture-release] packaged firefox ${version} -> ${path.relative(PROJECT_ROOT, xpiPath)}, ${path.relative(PROJECT_ROOT, zipPath)}`
    );
    return;
  }

  console.log(
    `[capture-release] packaged ${browser} ${version} -> ${path.relative(PROJECT_ROOT, zipPath)}`
  );
}

main();
