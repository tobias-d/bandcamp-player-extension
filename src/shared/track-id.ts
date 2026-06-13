// Single background-safe extractor for the Bandcamp trackId embedded in a stream
// URL, covering both shapes the extension handles:
//   - stream_redirect: bandcamp.com/stream_redirect?enc=...&track_id=NNN (also ?track=NNN)
//   - signed CDN:       t4.bcbits.com/stream/<hash>/mp3-v0/NNN  (id in the path)
//
// No `window` dependency, so it is safe in the background service worker as well
// as content/offscreen contexts. Thresholds match content's readTrackIdFromUrl
// (4+ digit query id, 6+ digit path id) so all call sites agree on the key.
export function readTrackIdFromStreamUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }
  const queryMatch =
    raw.match(/[?&]track_id=(\d{4,})/i) ||
    raw.match(/[?&]trackid=(\d{4,})/i) ||
    raw.match(/[?&]track=(\d{4,})/i);
  if (queryMatch) {
    return queryMatch[1];
  }
  const pathMatch = raw.match(/\/mp3-[^/]+\/(\d{6,})(?:[/?]|$)/i);
  return pathMatch ? pathMatch[1] : '';
}
