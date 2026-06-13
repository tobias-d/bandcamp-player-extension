import type { ContextResourceSample } from '@/shared/resource-sampler';

export interface RuntimeAudioPrepareInput {
  url: string;
  cacheKey?: string;
  sourceVersion: number;
}

// Resource-diagnostics report for one runtime audio host iframe. `hostId` and `track` are the
// non-sensitive ping-pong identity (instance id + public trackId); `active` marks the audible
// host. `perf`/`underruns` are null when the iframe is not yet created or did not answer.
export interface RuntimeHostPerfReport {
  hostId: string;
  track: string;
  active: boolean;
  perf: ContextResourceSample | null;
  underruns: number | null;
}

export interface RuntimeAudioPreparedSnapshot {
  url: string;
  cacheKey?: string;
  sourceVersion: number;
  byteLength: number;
  decodedByteLength: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  contentType?: string;
  fetchMs: number;
  decodeMs: number;
  totalMs: number;
  preparedAt: number;
}

export interface RuntimeAudioPrepareResult {
  ok: boolean;
  reason?: string;
  track?: RuntimeAudioPreparedSnapshot;
}

export interface RuntimeAudioEngineDebugEvent {
  ts: number;
  stage: string;
  detail: string;
}

export interface RuntimeAudioEngineDebugEntry {
  url: string;
  cacheKey?: string;
  sourceVersion: number;
  byteLength: number;
  decodedByteLength: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  preparedAt: number;
  hasBuffer: boolean;
  fetchMs: number;
  decodeMs: number;
  totalMs: number;
}

export interface RuntimeAudioEngineDebugSnapshot {
  maxPrepared: number;
  maxDecodedBytes: number;
  maxEncodedBytes: number;
  predecodeWindowTracks: number;
  maxConcurrentPredecode: number;
  deviceMemoryGb: number | null;
  capacityReason: string;
  preparedCount: number;
  preparedBytes: number;
  preparedDecodedBytes: number;
  preparedDurationSec: number;
  activePrepareCount: number;
  activePrepareUrls: string[];
  prepareAttemptCount: number;
  evictionCount: number;
  staleFetchCount: number;
  staleDecodeCount: number;
  stalePrepareCount: number;
  prepareFailureCount: number;
  lastPrepareFailure: string;
  lastPreparedUrl: string;
  // Retained encoded (compressed) blobs that survive decoded-PCM eviction, so a
  // re-selected track re-decodes locally instead of re-fetching from the network.
  encodedCacheCount: number;
  encodedCacheBytes: number;
  encodedCacheHits: number;
  entries: RuntimeAudioEngineDebugEntry[];
  recentEvents: RuntimeAudioEngineDebugEvent[];
}

export interface RuntimeAudioIncidentDebugEntry {
  ts: number;
  transitionId: string;
  stage: string;
  detail: string;
}

export interface RuntimeAudioIncidentDebugSummary {
  transitionId: string;
  reason: string;
  targetSrc: string;
  targetStage: string;
  browserAudio: string;
  startedAt: number;
  updatedAt: number;
}

export interface RuntimeAudioIncidentDebugSnapshot {
  transitionSeq: number;
  currentTransitionId: string;
  currentReason: string;
  targetSrc: string;
  targetStage: string;
  browserAudio: string;
  recentIncidents: RuntimeAudioIncidentDebugSummary[];
  warnings: RuntimeAudioIncidentDebugEntry[];
  timings: RuntimeAudioIncidentDebugEntry[];
  events: RuntimeAudioIncidentDebugEntry[];
}

export interface RuntimeAudioPlaybackState {
  src: string;
  paused: boolean;
  currentTimeSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  ts: number;
}

export type RuntimeAudioOwnershipState = 'origin-started' | 'runtime-pending' | 'runtime';

export interface RuntimeAudioOwnershipDebugState {
  ownershipState: RuntimeAudioOwnershipState;
  firstOriginAvailable: boolean;
}

export interface RuntimeStretchCapability {
  supported: boolean;
  reason: string;
  detail: string;
  checkedAt: number;
}

export interface RuntimeAudioEngine {
  prepareTrack(input: RuntimeAudioPrepareInput): Promise<RuntimeAudioPrepareResult>;
  clearPreparedTrack(): void;
  getPreparedTrack(): RuntimeAudioPreparedSnapshot | null;
  getDebugSnapshot(): RuntimeAudioEngineDebugSnapshot;
  findPrepared(url: string): { snapshot: RuntimeAudioPreparedSnapshot; buffer: AudioBuffer | null } | null;
  destroy(): void;
}

export interface RuntimeAudioFetchSuccess {
  ok: true;
  url: string;
  status: number;
  contentType?: string;
  audioData: ArrayBuffer;
}

export interface RuntimeAudioFetchFailure {
  ok: false;
  url: string;
  status?: number;
  error: string;
}

export type RuntimeAudioFetchResult = RuntimeAudioFetchSuccess | RuntimeAudioFetchFailure;
