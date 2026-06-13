export const RUNTIME_PREDECODE_DEFAULT_TRACKS = 10;
// Firefox hides navigator.deviceMemory, so ALL Firefox users land on this unknown-memory
// profile regardless of actual RAM — it is "unknown", not "low". It was originally pinned to
// 4 tracks / 440 MB because a slow-machine crack landed while loading the largest track on top
// of a larger footprint (GC pressure during the heavy load). Two later fixes remove that reason:
// the Firefox chunked worklet feed eliminates the load-on-audible-path stall, and encoded-blob
// retention makes eviction cheap (re-decode locally, no re-fetch). So treat "unknown" as a
// modern machine: 8 tracks / 850 MB. (Genuinely low-RAM *known* machines stay conservative via
// the <4 GB tier below — that only triggers on Chrome, which reports real deviceMemory.)
// NOTE: higher steady resident memory is still a real cost on a genuinely low-RAM Firefox box;
// this is release-gated and reversible. Consider a user setting if it proves too heavy.
export const RUNTIME_PREDECODE_UNKNOWN_MEMORY_TRACKS = 8;
export const RUNTIME_PREDECODE_LOW_MEMORY_TRACKS = 6;
export const RUNTIME_PREDECODE_MID_MEMORY_TRACKS = 8;

// Decoded-PCM retention budget (bytes). A fixed track COUNT does not bound memory
// when one entry is huge: a fast-machine capture showed a single 38-minute / 813 MB
// track spike the working set to ~775 MB even with only 4 retained tracks, and the
// next switch glitched. Cap by total decoded bytes too, so a giant track evicts the
// others instead of stacking on top of them. A normal 4-min stereo track decodes to
// ~85 MB, so ~440 MB still holds ~5 normal tracks.
const MB = 1024 * 1024;
export const RUNTIME_PREDECODE_UNKNOWN_MEMORY_BYTES = 850 * MB;
export const RUNTIME_PREDECODE_LOW_MEMORY_BYTES = 440 * MB;
export const RUNTIME_PREDECODE_MID_MEMORY_BYTES = 750 * MB;
export const RUNTIME_PREDECODE_DEFAULT_BYTES = 1200 * MB;

// Encoded (compressed) audio is ~5 MB per track versus ~100 MB decoded. Retaining the
// encoded blobs across decoded-PCM eviction lets a re-selected track skip the network
// fetch and decode locally instead, which removes the fetch+evict thrash on the
// conservative (Firefox/unknown-memory) profile WITHOUT raising the decoded-PCM peak the
// profile is protecting. ~128 MB holds the encoded data for ~25 normal tracks — enough to
// cover a typical playlist so any in-playlist re-selection becomes decode-only.
export const RUNTIME_PREDECODE_ENCODED_BYTES = 128 * MB;

// Chrome-only opt-in "Performance mode" tier. Chrome caps navigator.deviceMemory at 8, so even
// a 32/64 GB machine cannot climb past the memory-gte-8gb tier automatically. This tier is only
// returned when the user explicitly opts in (and only on the Chrome build — see index.ts). It is
// the first tier where the lookahead window (24) is SMALLER than retention (30): the extra
// retained tracks stay decoded behind the playhead for instant lookback. maxDecodedBytes is the
// real guardrail — a single long mix (~800 MB) evicts others instead of stacking. Tunable.
export const RUNTIME_PREDECODE_PERFORMANCE_WINDOW = 24;
export const RUNTIME_PREDECODE_PERFORMANCE_TRACKS = 30;
export const RUNTIME_PREDECODE_PERFORMANCE_BYTES = 2900 * MB;

export interface RuntimePredecodePolicy {
  windowTracks: number;
  maxPreparedTracks: number;
  maxDecodedBytes: number;
  // Budget for retained encoded (compressed) blobs, independent of the decoded-PCM budget.
  maxEncodedBytes: number;
  maxConcurrentPredecode: number;
  deviceMemoryGb: number | null;
  reason: string;
}

function readDeviceMemoryGb(): number | null {
  const memory = Number((globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory);
  if (!Number.isFinite(memory) || memory <= 0) {
    return null;
  }
  return memory;
}

export function resolveRuntimePredecodePolicy(
  options: { performanceMode?: boolean } = {}
): RuntimePredecodePolicy {
  const deviceMemoryGb = readDeviceMemoryGb();

  // Explicit opt-in overrides the device-memory tiers. The caller is responsible for the
  // browser gate (Chrome-only), so this branch trusts the flag. deviceMemoryGb is still
  // reported for the debug snapshot even though it does not drive the numbers here.
  if (options.performanceMode) {
    return {
      windowTracks: RUNTIME_PREDECODE_PERFORMANCE_WINDOW,
      maxPreparedTracks: RUNTIME_PREDECODE_PERFORMANCE_TRACKS,
      maxDecodedBytes: RUNTIME_PREDECODE_PERFORMANCE_BYTES,
      maxEncodedBytes: RUNTIME_PREDECODE_ENCODED_BYTES,
      maxConcurrentPredecode: 4,
      deviceMemoryGb,
      reason: 'performance-opt-in'
    };
  }

  if (deviceMemoryGb === null) {
    return {
      windowTracks: RUNTIME_PREDECODE_UNKNOWN_MEMORY_TRACKS,
      maxPreparedTracks: RUNTIME_PREDECODE_UNKNOWN_MEMORY_TRACKS,
      maxDecodedBytes: RUNTIME_PREDECODE_UNKNOWN_MEMORY_BYTES,
      maxEncodedBytes: RUNTIME_PREDECODE_ENCODED_BYTES,
      maxConcurrentPredecode: 2,
      deviceMemoryGb,
      reason: 'memory-unavailable'
    };
  }

  if (deviceMemoryGb < 4) {
    return {
      windowTracks: RUNTIME_PREDECODE_LOW_MEMORY_TRACKS,
      maxPreparedTracks: RUNTIME_PREDECODE_LOW_MEMORY_TRACKS,
      maxDecodedBytes: RUNTIME_PREDECODE_LOW_MEMORY_BYTES,
      maxEncodedBytes: RUNTIME_PREDECODE_ENCODED_BYTES,
      maxConcurrentPredecode: 1,
      deviceMemoryGb,
      reason: 'memory-lt-4gb'
    };
  }

  if (deviceMemoryGb < 8) {
    return {
      windowTracks: RUNTIME_PREDECODE_MID_MEMORY_TRACKS,
      maxPreparedTracks: RUNTIME_PREDECODE_MID_MEMORY_TRACKS,
      maxDecodedBytes: RUNTIME_PREDECODE_MID_MEMORY_BYTES,
      maxEncodedBytes: RUNTIME_PREDECODE_ENCODED_BYTES,
      maxConcurrentPredecode: 2,
      deviceMemoryGb,
      reason: 'memory-lt-8gb'
    };
  }

  return {
    windowTracks: RUNTIME_PREDECODE_DEFAULT_TRACKS,
    maxPreparedTracks: RUNTIME_PREDECODE_DEFAULT_TRACKS,
    maxDecodedBytes: RUNTIME_PREDECODE_DEFAULT_BYTES,
    maxEncodedBytes: RUNTIME_PREDECODE_ENCODED_BYTES,
    maxConcurrentPredecode: 3,
    deviceMemoryGb,
    reason: 'memory-gte-8gb'
  };
}
