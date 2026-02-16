#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./src/manifest.firefox.json').version")"
PKG_BASENAME="bandcamp-player-extension-${VERSION}-firefox"
RELEASE_DIR="$ROOT_DIR/release"

mkdir -p "$RELEASE_DIR"

echo "[package] Building Firefox distribution..."
npm run build:firefox

echo "[package] Creating add-on package (.xpi)..."
rm -f "$RELEASE_DIR/${PKG_BASENAME}.xpi"
(
  cd dist
  zip -r "../release/${PKG_BASENAME}.xpi" . -x "*.map"
)

echo "[package] Creating source package (.zip) for AMO review..."
rm -f "$RELEASE_DIR/${PKG_BASENAME}-source.zip"
git archive --format=zip --output "$RELEASE_DIR/${PKG_BASENAME}-source.zip" HEAD

echo "[package] Done:"
echo "  $RELEASE_DIR/${PKG_BASENAME}.xpi"
echo "  $RELEASE_DIR/${PKG_BASENAME}-source.zip"
