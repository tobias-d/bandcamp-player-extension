import type {
  AnalysisResult,
  HostResourceDiagnostics,
  LikesDebugSnapshot,
  MetadataResolution,
  NonReleaseResolverSnapshot,
  PanelInput,
  TrackMetadata,
  UiPerformanceDebug,
  WorkerResourceReport
} from '@/shared/types';
import type { ContextResourceSample } from '@/shared/resource-sampler';
import type { ResourceDiagnosticsDebugState } from '@/content/debug/resource-diagnostics';
import type { RuntimeHostPerfReport } from '@/content/player/runtime-audio/types';
import type { OwnedPlaybackHostState } from '@/content/discover/origin-bridge/types';
import type { KeyAnalysisTraceEntry } from '@/content/debug/key-analysis-trace';
import type {
  RuntimeAudioEngineDebugSnapshot,
  RuntimeAudioIncidentDebugEntry,
  RuntimeAudioIncidentDebugSnapshot,
  RuntimeAudioOwnershipState,
  RuntimeStretchCapability
} from '@/content/player/runtime-audio/types';
import {
  DiscoverTransportDebugState,
  formatDiscoverTransportTraceLines,
  formatSince,
  formatTransportTraceLines,
  TransportDebugState
} from '@/content/debug/transport-debug';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { readTrackIdFromStreamUrl } from '@/shared/track-id';
import {
  SHARED_LIKES_CACHE_MAX_AGE_MS
} from '@/shared/constants';
import { RUNTIME_PREDECODE_DEFAULT_TRACKS } from '@/shared/runtime-predecode-policy';
import {
  createDebugBuilder,
  formatTraceClock,
  type DebugSection,
  type DebugSectionsFactory
} from '@/shared/debug-trace';

function formatRuntimeAudioIncidentLines(
  entries: RuntimeAudioIncidentDebugEntry[] | undefined,
  limit = 12
): string[] {
  if (!entries?.length) {
    return ['(none)'];
  }
  return entries.slice(-Math.max(1, limit)).map((entry) =>
    `${formatProcessTime(entry.ts)} [${entry.transitionId || '-'}] ${entry.stage || '-'} ${entry.detail || '-'}`
  );
}

function filterCurrentRuntimeAudioIncidentEntries(
  snapshot: RuntimeAudioIncidentDebugSnapshot | null,
  entries: RuntimeAudioIncidentDebugEntry[] | undefined
): RuntimeAudioIncidentDebugEntry[] {
  const currentTransitionId = snapshot?.currentTransitionId || '-';
  return entries?.filter((entry) => entry.transitionId === currentTransitionId) || [];
}

function isRuntimeAudioIncidentCritical(entry: RuntimeAudioIncidentDebugEntry): boolean {
  const stage = entry.stage || '';
  return (
    stage.includes('warning') ||
    stage.includes('timing') ||
    stage.includes('load') ||
    stage.includes('stop') ||
    stage.includes('play') ||
    stage.includes('mute') ||
    stage.includes('seek') ||
    stage.includes('ownership') ||
    stage === 'runtime-playlist-load-enqueued' ||
    stage === 'host-context-stats'
  );
}

function formatRuntimeAudioIncidentTimelineLines(
  snapshot: RuntimeAudioIncidentDebugSnapshot | null,
  limit = 36
): string[] {
  const currentTransitionId = snapshot?.currentTransitionId || '-';
  const transitionEvents = snapshot?.events?.filter((entry) =>
    entry.transitionId === currentTransitionId
  ) || [];
  if (!transitionEvents.length) {
    return ['(none)'];
  }

  const lowSignal: RuntimeAudioIncidentDebugEntry[] = [];
  const critical = transitionEvents.filter((entry) => {
    if (isRuntimeAudioIncidentCritical(entry)) {
      return true;
    }
    lowSignal.push(entry);
    return false;
  });
  const rows = critical.length
    ? critical
    : transitionEvents;
  const filler = critical.length
    ? lowSignal.slice(-Math.max(0, limit - rows.length))
    : [];
  const selected = [...rows, ...filler]
    .sort((a, b) => a.ts - b.ts)
    .slice(-Math.max(1, limit));

  return selected.map((entry) =>
    `${formatProcessTime(entry.ts)} [${entry.transitionId || '-'}] ${entry.stage || '-'} ${entry.detail || '-'}`
  );
}

function countRuntimeAudioIncidentEntries(
  entries: RuntimeAudioIncidentDebugEntry[] | undefined,
  transitionId: string
): number {
  return entries?.filter((entry) => entry.transitionId === transitionId).length || 0;
}

function formatRuntimeAudioIncidentRecentLines(
  snapshot: RuntimeAudioIncidentDebugSnapshot | null,
  limit = 4
): string[] {
  const summaries = snapshot?.recentIncidents?.slice(-Math.max(1, limit)).reverse() || [];
  if (!summaries.length) {
    return ['(none)'];
  }
  return summaries.map((summary) => {
    const transitionId = summary.transitionId || '-';
    const warningCount = countRuntimeAudioIncidentEntries(snapshot?.warnings, transitionId);
    const timingCount = countRuntimeAudioIncidentEntries(snapshot?.timings, transitionId);
    const eventCount = countRuntimeAudioIncidentEntries(snapshot?.events, transitionId);
    return `${formatProcessTime(summary.updatedAt)} [${transitionId}] reason=${summary.reason || '-'} stage=${summary.targetStage || 'idle'} warnings=${warningCount} timings=${timingCount} events=${eventCount} target=${summary.targetSrc || '-'}`;
  });
}

interface PlayerMetadataDebugSnapshot {
  trackId?: string;
  globals?: string;
  linkedReleaseUrl?: string;
  domIdentity?: string;
  domDetails?: string;
  strictIdentity?: string;
  candidates?: string | number;
  primaryIdentity?: string;
  resolvedIdentity?: string;
  cachedIdentity?: string;
  keyHints?: string;
  bandHints?: string;
  itemHints?: string;
  typeHints?: string;
  apiHintCount?: string | number;
  apiTrackHintCount?: string | number;
  apiHints?: string;
  fanId?: string;
  summaryHintCount?: string | number;
  summaryHints?: string;
  globalsHintStatus?: string;
  fanSummaryStatus?: string;
  fanItemsStatus?: string;
  apiCandidateStrictAccepted?: string | number;
  apiCandidateRejected?: string | number;
  fallbackUsed?: string | number;
  apiProbeState?: string;
  strictApiState?: string;
  pathLastDecision?: string;
}

function formatIsoTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '-';
  }
  return new Date(ts).toISOString();
}

function formatProcessTime(ts: number): string {
  return formatTraceClock(ts);
}

function formatCountdownMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const decimals = scaled >= 100 || unitIndex === 0 ? 0 : (scaled >= 10 ? 1 : 2);
  return `${scaled.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatDeviceMemoryGb(memory: number | null | undefined): string {
  if (!Number.isFinite(memory) || Number(memory) <= 0) {
    return '-';
  }
  return `${Number(memory)}GB`;
}

function formatRuntimePlaylistPreparationLine(
  trackUrls: string[],
  runtimeAudioEngineDebug: RuntimeAudioEngineDebugSnapshot | null | undefined,
  currentIndex = 0,
  fallbackTotal = 0
): string {
  const normalizedTrackUrls = trackUrls.map((url) => String(url || '').trim());
  const playableTrackUrls = normalizedTrackUrls.filter(Boolean);
  const playlistTotal = normalizedTrackUrls.length || Math.max(0, Number(fallbackTotal) || 0);
  const maxPrepared = Math.max(0, Number(runtimeAudioEngineDebug?.maxPrepared) || 0);
  const predecodeWindowTracks = Math.max(
    1,
    Number(runtimeAudioEngineDebug?.predecodeWindowTracks) || maxPrepared || RUNTIME_PREDECODE_DEFAULT_TRACKS
  );
  const windowTotal = Math.min(playlistTotal, predecodeWindowTracks);
  const startIndex = playlistTotal > 0 && Number.isInteger(currentIndex)
    ? ((currentIndex % playlistTotal) + playlistTotal) % playlistTotal
    : 0;
  const windowTrackUrls: string[] = [];
  for (let offset = 0; offset < windowTotal; offset += 1) {
    const url = normalizedTrackUrls[(startIndex + offset) % playlistTotal];
    if (url) {
      windowTrackUrls.push(url);
    }
  }
  const active = runtimeAudioEngineDebug?.activePrepareCount ?? 0;
  const entries = runtimeAudioEngineDebug?.entries || [];
  const prepared = windowTrackUrls.filter((trackUrl) =>
    entries.some((entry) => sourcesShareTrackIdentity(entry.url, trackUrl))
  ).length;
  const retained = playableTrackUrls.filter((trackUrl) =>
    entries.some((entry) => sourcesShareTrackIdentity(entry.url, trackUrl))
  ).length;
  const targetTotal = windowTrackUrls.length || windowTotal;
  const missing = Math.max(0, targetTotal - prepared);
  const capacityFull = maxPrepared > 0 && retained >= maxPrepared && missing > 0;
  const state = missing <= 0
    ? 'complete'
    : active > 0
      ? 'preparing'
      : capacityFull
        ? 'capacity-full'
        : 'idle';

  return `Runtime playlist prep: prepared=${prepared}/${targetTotal} active=${active} capacity=${maxPrepared || '-'} missing=${missing} state=${state} window=${startIndex}+${windowTotal} retained=${retained}/${playlistTotal} policy=${runtimeAudioEngineDebug?.capacityReason || '-'}`;
}

function formatLikesAutoRefreshLine(likesDebug: LikesDebugSnapshot, now = Date.now()): string {
  if (!Number.isFinite(likesDebug.lastSyncTs) || likesDebug.lastSyncTs <= 0) {
    return 'LIKES auto refresh: cadence=30m due=- in=- state=waiting-for-first-sync';
  }
  const dueAt = likesDebug.lastSyncTs + SHARED_LIKES_CACHE_MAX_AGE_MS;
  const remainingMs = Math.max(0, dueAt - now);
  const state = likesDebug.syncInFlightSince > 0 ? 'in-flight' : (remainingMs <= 0 ? 'due' : 'countdown');
  return `LIKES auto refresh: cadence=30m due=${formatIsoTime(dueAt)} in=${formatCountdownMs(remainingMs)} state=${state}`;
}

function formatDiscoverRawMetadataSourceLabel(source: string, field: 'title' | 'artist' | 'album'): string {
  const value = String(source || '').trim();
  if (!value) {
    return 'missing';
  }
  if (value !== 'default') {
    return value;
  }
  return `bridge-missing-${field}`;
}

function formatDiscoverRawMetadataSourcesLine(input: {
  title: string;
  artist: string;
  album: string;
  release: string;
  stream: string;
  identity: string;
}): string {
  return [
    `title:${formatDiscoverRawMetadataSourceLabel(input.title, 'title')}`,
    `artist:${formatDiscoverRawMetadataSourceLabel(input.artist, 'artist')}`,
    `album:${formatDiscoverRawMetadataSourceLabel(input.album, 'album')}`,
    `release:${String(input.release || '').trim() || 'none'}`,
    `stream:${String(input.stream || '').trim() || 'none'}`,
    `identity:${String(input.identity || '').trim() || 'none'}`
  ].join(', ');
}

function formatLikeStateChangeLines(likesDebug: LikesDebugSnapshot, limit = 12): string[] {
  const events = Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : [];
  const changes = events.filter((event) => {
    const stage = String(event.stage || '');
    return stage === 'view.state.change' || stage === 'view.state.snapshot';
  });
  if (!changes.length) {
    return ['(none)'];
  }
  return changes
    .slice(-Math.max(1, limit))
    .map((event) => `${formatProcessTime(event.ts)} [${String(event.stage || '-')}] ${String(event.detail || '-')}`);
}

function collectLatestSyncPhaseEvents(
  likesDebug: LikesDebugSnapshot
): Array<{ ts: number; stage: string; detail: string }> {
  const events = Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : [];
  if (!events.length) {
    return [];
  }

  let startIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const stage = String(events[i]?.stage || '');
    if (stage === 'sync.start') {
      startIndex = i;
      break;
    }
  }

  if (startIndex < 0) {
    return [];
  }

  let endIndex = events.length;
  for (let i = startIndex + 1; i < events.length; i += 1) {
    if (String(events[i]?.stage || '') === 'sync.start') {
      endIndex = i;
      break;
    }
  }

  return events.slice(startIndex, endIndex);
}

function formatLikeApiPhaseLines(likesDebug: LikesDebugSnapshot, limit = 40): string[] {
  const syncEvents = collectLatestSyncPhaseEvents(likesDebug);
  if (!syncEvents.length) {
    return ['(none)'];
  }

  const interesting = syncEvents.filter((event) => {
    const stage = String(event.stage || '');
    return (
      stage === 'sync.start' ||
      stage === 'fan.id.hint' ||
      stage === 'fan.id.viewer' ||
      stage === 'fan.id.resolved' ||
      stage === 'sync.release' ||
      stage === 'endpoint.summary' ||
      stage === 'sync.seed.summary' ||
      stage === 'sync.success' ||
      stage === 'sync.finally' ||
      stage.startsWith('token.') ||
      stage.startsWith('endpoint.request.') ||
      stage.startsWith('endpoint.error.') ||
      stage.startsWith('endpoint.retry.') ||
      stage.startsWith('endpoint.complete.') ||
      stage.startsWith('endpoint.page.') ||
      stage.startsWith('endpoint.focus.')
    );
  });

  if (!interesting.length) {
    return ['(none)'];
  }

  const compact: Array<{ ts: number; stage: string; detail: string }> = [];
  for (const event of interesting) {
    const stage = String(event.stage || '');
    const isProgressPulse =
      stage.startsWith('endpoint.request.') ||
      stage.startsWith('endpoint.page.');
    if (!isProgressPulse) {
      compact.push(event);
      continue;
    }

    const existingIndex = compact.findIndex((entry) => String(entry.stage || '') === stage);
    if (existingIndex >= 0) {
      compact.splice(existingIndex, 1);
    }
    compact.push(event);
  }

  return compact
    .slice(-Math.max(1, limit))
    .map((event) => `${formatProcessTime(event.ts)} [${String(event.stage || '-')}] ${String(event.detail || '-')}`);
}

function isJumpLikeEventStage(stage: string): boolean {
  const normalized = String(stage || '').trim();
  if (
    normalized.startsWith('source.change.') ||
    normalized.startsWith('view.resolve.') ||
    normalized === 'view.inventory.truth' ||
    normalized === 'view.state.snapshot' ||
    normalized.startsWith('reset.') ||
    normalized === 'album.infer' ||
    normalized === 'mutation.verify'
  ) {
    return true;
  }
  if (
    normalized === 'sync.start' ||
    normalized === 'sync.success' ||
    normalized === 'sync.error' ||
    normalized === 'sync.finally' ||
    normalized === 'sync.skipped' ||
    normalized === 'sync.deep.queue'
  ) {
    return true;
  }
  return (
    normalized === 'endpoint.summary' ||
    normalized === 'endpoint.apply'
  );
}

function hasJumpDiagnosticSignal(transportDebug: TransportDebugState, likesDebug: LikesDebugSnapshot): boolean {
  if (
    transportDebug.actionSeq > 0 ||
    transportDebug.selectionCount > 0 ||
    transportDebug.guardCount > 0 ||
    transportDebug.selectionMissCount > 0 ||
    transportDebug.fallbackLoadCount > 0 ||
    transportDebug.blockedCount > 0
  ) {
    return true;
  }
  return (Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : []).some((event) => {
    const stage = String(event.stage || '');
    const detail = String(event.detail || '');
    return (
      stage.startsWith('source.change.') ||
      detail.includes('outside=1') ||
      detail.includes('recentSelection=1') ||
      detail.includes('jumpLock=1') ||
      detail.includes('mismatch=') && !detail.includes('mismatch=none')
    );
  });
}

function isJumpTransportEntry(entry: TransportDebugState['trace'][number]): boolean {
  if (entry.channel === 'selection' || entry.channel === 'align' || entry.channel === 'guard') {
    return true;
  }
  if (entry.channel === 'bridge') {
    return entry.action === 'source-changed';
  }
  if (entry.channel === 'ui') {
    return entry.action.includes('track') || entry.action === 'prev-track' || entry.action === 'next-track';
  }
  return false;
}

function formatJumpDiagnosisLines(
  transportDebug: TransportDebugState,
  likesDebug: LikesDebugSnapshot,
  limit = 40
): string[] {
  if (!hasJumpDiagnosticSignal(transportDebug, likesDebug)) {
    return ['(none)'];
  }
  const merged = [
    ...transportDebug.trace
      .filter((entry) => isJumpTransportEntry(entry))
      .map((entry) => ({
        ts: entry.ts,
        label: `transport.${entry.channel}`,
        detail: `${entry.action} ${entry.detail}`.trim()
      })),
    ...(Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : [])
      .filter((event) => isJumpLikeEventStage(String(event.stage || '')))
      .map((event) => ({
        ts: event.ts,
        label: `likes.${String(event.stage || '-')}`,
        detail: String(event.detail || '-')
      }))
  ].sort((left, right) => left.ts - right.ts);

  const compact: Array<{ ts: number; label: string; detail: string; count: number }> = [];
  for (const entry of merged) {
    const last = compact[compact.length - 1];
    if (last && last.label === entry.label && last.detail === entry.detail) {
      last.count += 1;
      last.ts = entry.ts;
      continue;
    }
    compact.push({
      ts: entry.ts,
      label: entry.label,
      detail: entry.detail,
      count: 1
    });
  }

  const sliced = compact.slice(-Math.max(1, limit));

  if (!sliced.length) {
    return ['(none)'];
  }

  return sliced.map((entry) => {
    const suffix = entry.count > 1 ? ` (x${entry.count})` : '';
    return `${formatProcessTime(entry.ts)} [${entry.label}] ${entry.detail}${suffix}`;
  });
}

function formatInventoryMismatchSummaryLines(likesDebug: LikesDebugSnapshot, limit = 12): string[] {
  const events = Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : [];
  const mismatchEvents = events.filter((event) => String(event.stage || '') === 'view.inventory.truth');
  const mismatchLines: string[] = [];
  const seen = new Set<string>();
  for (let index = mismatchEvents.length - 1; index >= 0; index -= 1) {
    const event = mismatchEvents[index];
    const detail = String(event.detail || '-');
    const mismatchMatch = detail.match(/\bmismatch=([^\s]+)/);
    const mismatch = mismatchMatch ? mismatchMatch[1] : 'none';
    if (mismatch === 'none') {
      continue;
    }
    const key = `mismatch=${mismatch} ${detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mismatchLines.push(`${formatProcessTime(event.ts)} ${key}`);
    if (mismatchLines.length >= Math.max(1, limit)) {
      break;
    }
  }

  if (!mismatchLines.length) {
    return ['(none)'];
  }
  return mismatchLines.reverse();
}

function parseSyncRunFromDetail(detail: string): number {
  const match = String(detail || '').match(/\brun=(\d+)\b/);
  if (!match) {
    return 0;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseSyncReasonFromDetail(detail: string): string {
  const match = String(detail || '').match(/\breason=([^\s]+)/);
  return match ? String(match[1] || '').trim() : '';
}

function parseSyncStatusFromFinally(detail: string): string {
  const match = String(detail || '').match(/\bstatus=([^\s]+)/);
  return match ? String(match[1] || '').trim() : '';
}

function formatDeepSyncStatus(likesDebug: LikesDebugSnapshot): string {
  const events = Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents : [];
  if (!events.length) {
    return '-';
  }
  let queued = false;
  let deepStartIndex = -1;
  let deepRun = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const stage = String(events[i]?.stage || '');
    const detail = String(events[i]?.detail || '');
    if (stage === 'sync.start' && detail.includes('mode=deep')) {
      deepStartIndex = i;
      deepRun = parseSyncRunFromDetail(detail);
      break;
    }
    if (stage === 'sync.deep.queue') {
      queued = true;
    }
  }
  if (deepStartIndex < 0) {
    return queued ? 'queued' : '-';
  }

  let deepFinalStatus = '';
  let deepSuccessReason = '';
  let deepErrorDetail = '';
  for (let i = deepStartIndex + 1; i < events.length; i += 1) {
    const stage = String(events[i]?.stage || '');
    const detail = String(events[i]?.detail || '');
    const run = parseSyncRunFromDetail(detail);
    const sameRun = !deepRun || (run > 0 && run === deepRun);
    if (stage === 'sync.success' && sameRun) {
      deepSuccessReason = parseSyncReasonFromDetail(detail);
    }
    if (stage === 'sync.error') {
      deepErrorDetail = detail;
    }
    if (stage === 'sync.finally' && sameRun) {
      deepFinalStatus = parseSyncStatusFromFinally(detail);
    }
  }

  if (!deepFinalStatus) {
    return 'in-flight';
  }
  if (deepFinalStatus === 'success') {
    return deepSuccessReason ? `success:${deepSuccessReason}` : 'success';
  }
  if (deepFinalStatus === 'error') {
    return deepErrorDetail ? `error:${deepErrorDetail}` : 'error';
  }
  return deepFinalStatus;
}

function formatAudioSourceSummary(url: string | undefined | null): string {
  const source = String(url || '').trim();
  if (!source) {
    return '-';
  }

  const trackId = readTrackIdFromStreamUrl(source) || '-';
  try {
    const parsed = new URL(source, 'https://bandcamp.com');
    const encoding = parsed.searchParams.get('enc') || parsed.pathname.match(/\/(mp3-[^/]+)\//i)?.[1] || '-';
    return `track=${trackId} enc=${encoding} url=${source}`;
  } catch {
    return source;
  }
}

function formatTraceLines(
  trace: KeyAnalysisTraceEntry[] | undefined,
  limit = 50,
  include?: (event: KeyAnalysisTraceEntry) => boolean
): string[] {
  const events = Array.isArray(trace) ? trace : [];
  const filtered = include ? events.filter(include) : events;
  if (!filtered.length) {
    return ['(none)'];
  }
  return filtered
    .slice(-Math.max(1, limit))
    .map((event) => `${formatProcessTime(event.ts)} [${String(event.stage || '-')}] ${String(event.detail || '-')}`);
}

function formatKeyProcessLines(trace: KeyAnalysisTraceEntry[] | undefined, limit = 50): string[] {
  return formatTraceLines(trace, limit);
}

function formatCurrentKeyProcessLines(trace: KeyAnalysisTraceEntry[] | undefined, limit = 50): string[] {
  return formatTraceLines(trace, limit, (event) => String(event.stage || '').includes('key'));
}

function formatPreloadProcessLines(trace: KeyAnalysisTraceEntry[] | undefined, limit = 36): string[] {
  return formatTraceLines(trace, limit, (event) => {
    const stage = String(event.stage || '');
    return (
      stage === 'bpm-batch-open' ||
      stage === 'bpm-batch-settle' ||
      stage === 'start' ||
      stage === 'complete' ||
      stage === 'failure' ||
      stage === 'resync' ||
      stage === 'waveform-start' ||
      stage === 'waveform-complete' ||
      stage.includes('key')
    );
  });
}

function findTraceEntry(
  trace: KeyAnalysisTraceEntry[] | undefined,
  stages: string[]
): KeyAnalysisTraceEntry | null {
  const events = Array.isArray(trace) ? trace : [];
  for (const event of events) {
    if (stages.includes(String(event.stage || '').trim())) {
      return event;
    }
  }
  return null;
}

function findLastTraceEntry(
  trace: KeyAnalysisTraceEntry[] | undefined,
  stages: string[]
): KeyAnalysisTraceEntry | null {
  const events = Array.isArray(trace) ? trace : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (stages.includes(String(event.stage || '').trim())) {
      return event;
    }
  }
  return null;
}

function findLastTraceEntrySince(
  trace: KeyAnalysisTraceEntry[] | undefined,
  stages: string[],
  startEntry: KeyAnalysisTraceEntry | null
): KeyAnalysisTraceEntry | null {
  if (!startEntry) {
    return null;
  }
  const minTs = Number(startEntry.ts || 0);
  const events = Array.isArray(trace) ? trace : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (Number(event.ts || 0) < minTs) {
      continue;
    }
    if (stages.includes(String(event.stage || '').trim())) {
      return event;
    }
  }
  return null;
}

function formatPhaseLine(label: string, entry: KeyAnalysisTraceEntry | null): string {
  if (!entry) {
    return `${label}: -`;
  }
  return `${label}: ${formatProcessTime(entry.ts)} [${String(entry.stage || '-')}] ${String(entry.detail || '-')}`;
}

function formatPhaseTimelineLines(
  keyTrace: KeyAnalysisTraceEntry[] | undefined,
  preloadTrace: KeyAnalysisTraceEntry[] | undefined,
  milestones?: { preloadBpmBatchOpenTs?: number; preloadKeyBatchOpenTs?: number }
): string[] {
  const currentBpmStart = findTraceEntry(keyTrace, ['bpm-start', 'request']);
  const currentBpmSettle = findLastTraceEntry(keyTrace, ['bpm-settle']);
  const currentKeyStart = findTraceEntry(keyTrace, ['key-start']);
  const currentKeySettle = findLastTraceEntry(keyTrace, ['key-ready', 'failure', 'dropped']);
  const preloadBpmStart = findTraceEntry(preloadTrace, ['bpm-batch-open', 'start'])
    || (milestones?.preloadBpmBatchOpenTs ? { ts: milestones.preloadBpmBatchOpenTs, stage: 'bpm-batch-open', detail: 'milestone' } : null);
  const preloadBpmSettle = findLastTraceEntrySince(preloadTrace, ['bpm-batch-settle'], preloadBpmStart);
  const preloadKeyStart = findTraceEntry(preloadTrace, ['key-batch-open', 'key-start'])
    || (milestones?.preloadKeyBatchOpenTs ? { ts: milestones.preloadKeyBatchOpenTs, stage: 'key-batch-open', detail: 'milestone' } : null);
  const preloadKeySettle = findLastTraceEntrySince(preloadTrace, ['key-batch-settle', 'key-complete', 'key-failure', 'key-cancel', 'key-drop'], preloadKeyStart);
  const waveformStart = findTraceEntry(keyTrace, ['waveform-start']);
  const waveformLatest = findLastTraceEntry(keyTrace, ['waveform-start', 'waveform-pending', 'waveform-settle', 'waveform-skip', 'waveform-seed', 'waveform-retry']);

  const lines: string[] = [];
  if (currentBpmStart) {
    lines.push(
      formatPhaseLine('Current BPM start', currentBpmStart),
      formatPhaseLine('Current BPM settle', currentBpmSettle)
    );
  }
  if (currentKeyStart) {
    lines.push(
      formatPhaseLine('Current key start', currentKeyStart),
      formatPhaseLine('Current key settle', currentKeySettle)
    );
  }
  if (preloadBpmStart) {
    lines.push(
      formatPhaseLine('Preload BPM batch start', preloadBpmStart),
      formatPhaseLine('Preload BPM batch settle', preloadBpmSettle)
    );
  }
  if (preloadKeyStart) {
    lines.push(
      formatPhaseLine('Preload key start', preloadKeyStart),
      formatPhaseLine('Preload key settle/drop', preloadKeySettle)
    );
  }
  if (waveformStart) {
    lines.push(
      formatPhaseLine('Waveform start', waveformStart),
      formatPhaseLine('Waveform latest', waveformLatest)
    );
  }
  return lines.length ? lines : ['(none)'];
}

function normalizeSourceForDisplay(value: string): string {
  const source = String(value || '').trim();
  return source || '-';
}

function formatMetadataOriginPath(metadata: TrackMetadata): string {
  return `title <- ${normalizeSourceForDisplay(metadata.sources.title)} | artist <- ${normalizeSourceForDisplay(metadata.sources.artist)} | album <- ${normalizeSourceForDisplay(metadata.sources.album)}`;
}

function formatKeyTopKeys(analysis: AnalysisResult | null | undefined): string {
  const result = analysis?.keyAnalysis;
  if (!result?.topKeys?.length) {
    return '-';
  }
  return result.topKeys
    .slice(0, 3)
    .map((candidate, index) => `${index + 1}) ${candidate.camelot} (${candidate.weight.toFixed(2)})`)
    .join(' | ');
}

function resolveKeyLifecycleStatus(analysis: AnalysisResult | null | undefined): string {
  if (!analysis) {
    return '-';
  }
  if (analysis.keyAnalysis?.topKeys?.length) {
    return 'ready';
  }
  const status = String(analysis.analysisStatus || '').toLowerCase();
  if (status.includes('analyzing key')) {
    return 'analyzing';
  }
  if (analysis.error || status.includes('failed')) {
    return 'failed';
  }
  if (status.startsWith('bpm:')) {
    return 'unavailable';
  }
  return 'pending';
}

function formatKeyWindowSummary(analysis: AnalysisResult | null | undefined): string {
  const result = analysis?.keyAnalysis;
  if (!result) {
    return '-';
  }
  return `${result.windowsAnalyzed}/${result.windowsTotal}, dual-center=${result.dualCenter ? 'yes' : 'no'}`;
}

function formatKeyTimingSummary(analysis: AnalysisResult | null | undefined): string {
  if (!analysis) {
    return '-';
  }
  const total = Number.isFinite(analysis.keyDebugTimingMs) ? `${Math.round(Number(analysis.keyDebugTimingMs))}ms` : '-';
  const decode = Number.isFinite(analysis.keyDebugDecodeMs) ? `${Math.round(Number(analysis.keyDebugDecodeMs))}ms` : '-';
  const preprocess = Number.isFinite(analysis.keyDebugPreprocessMs) ? `${Math.round(Number(analysis.keyDebugPreprocessMs))}ms` : '-';
  const compute = Number.isFinite(analysis.keyDebugComputeMs) ? `${Math.round(Number(analysis.keyDebugComputeMs))}ms` : '-';
  return `total=${total} | decode=${decode} | preprocess=${preprocess} | compute=${compute}`;
}

function formatKeyAnalysisLines(analysis: AnalysisResult | null | undefined): string[] {
  const lifecycle = resolveKeyLifecycleStatus(analysis);
  const hasKeyEvidence = Boolean(
    analysis?.keyAnalysis?.topKeys?.length ||
    analysis?.keyDebugSource ||
    analysis?.keyDebugDetail ||
    analysis?.keyStatus === 'ready' ||
    analysis?.keyStatus === 'empty' ||
    Number.isFinite(analysis?.keyDebugTimingMs)
  );
  if (!hasKeyEvidence && lifecycle === 'pending') {
    return [];
  }
  if (lifecycle === 'unavailable') {
    return ['Key analysis: unavailable'];
  }
  return [
    `Key lifecycle: ${lifecycle}`,
    `Key result: ${formatKeyTopKeys(analysis)}`,
    `Key reliability: ${Number.isFinite(analysis?.keyAnalysis?.reliability) ? Number(analysis?.keyAnalysis?.reliability).toFixed(3) : '-'}`,
    `Key windows: ${formatKeyWindowSummary(analysis)}`,
    `Key method: ${analysis?.keyAnalysis?.method || '-'}`,
    `Key source: ${analysis?.keyDebugSource || '-'}`,
    `Key detail: ${analysis?.keyDebugDetail || '-'}`,
    `Key timing: ${formatKeyTimingSummary(analysis)}`
  ];
}

function formatLikeMutationLines(likesDebug: LikesDebugSnapshot): string[] {
  const mutation = likesDebug.mutation;
  const summary = `LIKES mutation: enabled=${mutation.enabled ? '1' : '0'}, inFlight=${mutation.inFlight ? '1' : '0'}, target=${mutation.target}, action=${mutation.action}, gate=${mutation.gate}, reason=${mutation.reasonCode || '-'}, status=${mutation.status || 0}`;
  const hasActivity = mutation.inFlight
    || mutation.target !== 'none'
    || mutation.action !== 'none'
    || Boolean(mutation.reasonCode)
    || Boolean(mutation.preflightReason)
    || Boolean(mutation.requestPreview)
    || Boolean(mutation.responsePreview)
    || Boolean(mutation.transport)
    || Number(mutation.status || 0) !== 0;
  if (!hasActivity) {
    return [summary];
  }
  return [
    summary,
    `LIKES mutation context: family=${mutation.requestContextFamily || '-'}, variant=${mutation.requestContextVariant || '-'}, originPolicy=${mutation.selectedOriginReason || '-'}`,
    `LIKES mutation preflight: reason=${mutation.preflightReason || '-'}, item=${mutation.identityItemType || '-'}:${mutation.identityItemId || '-'}, band=${mutation.identityBandId || '-'}, page=${mutation.identityPageUrl || '-'}`,
    `LIKES mutation hosts: page=${mutation.pageHost || '-'} target=${mutation.targetHost || '-'} sameHost=${mutation.sameHost ? '1' : '0'}`,
    `LIKES mutation auth: fanPresent=${mutation.fanIdPresent ? '1' : '0'} fan=${mutation.fanIdValue || '-'} crumbPresent=${mutation.crumbPresent ? '1' : '0'} crumbLen=${mutation.crumbLength || 0} crumbSource=${mutation.crumbSource || '-'} retryCount=${mutation.retryCount ?? 0}`,
    `LIKES mutation request: ${mutation.requestPreview || '-'}`,
    `LIKES mutation response: transport=${mutation.transport || '-'} duration=${mutation.durationMs || 0}ms detail=${mutation.responsePreview || '-'}`
  ];
}

function formatMs(value: number | undefined): string {
  return Number.isFinite(value) ? `${Math.round(Number(value))}ms` : '-';
}

function formatUiPerformanceLine(debug: UiPerformanceDebug | undefined): string {
  const render = debug?.render;
  if (!render) {
    return 'UI performance: render=- panel=- debug=- count=-';
  }
  return `UI performance: render=${formatMs(render.totalRenderMs)} panel=${formatMs(render.panelUpdateMs)} debug=${formatMs(render.debugSnapshotMs)} count=${render.renderCount}`;
}

function formatWaveformAnimationLine(debug: UiPerformanceDebug | undefined): string {
  const waveform = debug?.waveformLoading;
  if (!waveform) {
    return 'Waveform animation: active=- dots=- samples=- avg=- max=- long=-';
  }
  return `Waveform animation: active=${waveform.active ? '1' : '0'} dots=${waveform.dotCount} samples=${waveform.sampleCount} avg=${formatMs(waveform.avgFrameMs)} max=${formatMs(waveform.maxFrameMs)} last=${formatMs(waveform.lastFrameMs)} long=${waveform.longFrameCount} duration=${formatMs(waveform.durationMs)}`;
}

/* ---- Resource diagnostics (task-manager-style proxies) ---- */

// Lag is the load signal; keep sub-millisecond precision at idle, round once it grows.
function formatLagMs(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return value < 10 ? `${value.toFixed(1)}ms` : `${Math.round(value)}ms`;
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return '-';
  }
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

// Heap tokens are deliberately named heap/heapLimit so the anonymized export can redact them
// (device-correlating). Null = realm has no performance.memory (Firefox, workers).
function formatHeapToken(sample: ContextResourceSample): string {
  if (sample.heapUsedBytes === null) {
    return 'heap=-';
  }
  const total = sample.heapTotalBytes !== null ? formatBytes(sample.heapTotalBytes) : '-';
  const limit = sample.heapLimitBytes !== null ? ` heapLimit=${formatBytes(sample.heapLimitBytes)}` : '';
  return `heap=${formatBytes(sample.heapUsedBytes)}/${total}${limit}`;
}

function formatLagSample(sample: ContextResourceSample | null): string {
  if (!sample) {
    return 'sample=blocked';
  }
  return `lag avg=${formatLagMs(sample.lagAvgMs)} max=${formatLagMs(sample.lagMaxMs)} last=${formatLagMs(sample.lagLastMs)} ticks=${sample.tickCount} ${formatHeapToken(sample)}`;
}

function formatWorkerResourceLine(worker: WorkerResourceReport): string {
  const wasm = worker.wasmHeapBytes !== null ? ` wasmHeap=${formatBytes(worker.wasmHeapBytes)}` : '';
  return `Resource worker[${worker.index}]: ready=${worker.ready ? '1' : '0'} busy=${formatPercent(worker.busyFraction)} ${formatLagSample(worker.sample)}${wasm}`;
}

function formatHostDiagnosticsLines(host: HostResourceDiagnostics): string[] {
  const lines: string[] = [];
  // The MV3 service worker only samples while kept awake by the open panel, so its numbers are
  // not continuous background load. Firefox's background page is persistent.
  const backgroundLabel = __BUILD_TARGET__ === 'chrome'
    ? 'Resource background (awake-for-diagnostics)'
    : 'Resource background';
  const label = host.context === 'background' ? backgroundLabel : 'Resource offscreen';
  const essentia = host.essentiaHeapBytes !== null ? ` essentiaHeap=${formatBytes(host.essentiaHeapBytes)}` : '';
  lines.push(`${label}: ${formatLagSample(host.sample)} caches: ${host.caches}${essentia}`);
  if (host.pool) {
    const poolTag = host.context === 'background' ? 'bg' : 'offscreen';
    lines.push(`Resource worker pool[${poolTag}]: total=${host.pool.total} ready=${host.pool.ready} busy=${host.pool.busy} queued=${host.pool.queued} busyFraction=${formatPercent(host.pool.busyFraction)}`);
  }
  for (const worker of host.workers) {
    lines.push(formatWorkerResourceLine(worker));
  }
  return lines;
}

function formatRuntimeHostResourceLine(report: RuntimeHostPerfReport): string {
  const role = report.active ? 'active' : 'idle';
  if (!report.perf) {
    return `Resource audio host[${report.hostId}]: ${role} track=${report.track} not running`;
  }
  const underruns = report.underruns !== null ? ` underruns=${report.underruns}` : '';
  return `Resource audio host[${report.hostId}]: ${role} track=${report.track} ${formatLagSample(report.perf)}${underruns}`;
}

function formatResourceDiagnosticsLines(state: ResourceDiagnosticsDebugState | null | undefined): string[] {
  if (!state || !state.open) {
    return ['Resource sampling: off (open-panel only)'];
  }
  const lines: string[] = [];
  const uptime = state.content ? `${(state.content.uptimeMs / 1000).toFixed(1)}s` : '-';
  const pull = state.lastPullError
    ? `error(${state.lastPullError})`
    : (state.backend ? 'ok' : 'pending');
  const last = state.lastPullAt ? formatTraceClock(state.lastPullAt) : '-';
  lines.push(`Resource sampling: on uptime=${uptime} pull=${pull} last=${last}`);
  lines.push(`Resource content: ${formatLagSample(state.content)}`);
  const backend = state.backend;
  if (backend) {
    lines.push(...formatHostDiagnosticsLines(backend.background));
    if (backend.offscreen) {
      lines.push(...formatHostDiagnosticsLines(backend.offscreen));
    }
  }
  if (state.hosts) {
    for (const host of state.hosts) {
      lines.push(formatRuntimeHostResourceLine(host));
    }
  }
  return lines;
}

function resolveSnapshotSourceFallback(playlistSource: string): 'TralbumAPI' | 'TralbumData' | 'none' {
  const value = String(playlistSource || '').trim();
  if (value.startsWith('TralbumAPI')) {
    return 'TralbumAPI';
  }
  if (value.startsWith('TralbumData')) {
    return 'TralbumData';
  }
  return 'none';
}

const readTrackIdFromSourceUrl = readTrackIdFromStreamUrl;

function resolveResolverDebugSummary(params: {
  resolverSnapshot?: NonReleaseResolverSnapshot | null;
  metadataResolution: MetadataResolution | null;
  playlistSource: string;
}): {
  trackId: string;
  matchReason: string;
  sourceLabel: string;
  identityLabel: string;
  playlistReason: string;
  metadataAlignedLabel: string;
  strictMetaLabel: string;
  strictPlaylistLabel: string;
} {
  const snapshot = params.resolverSnapshot;
  const sourceFallback = resolveSnapshotSourceFallback(params.playlistSource);
  const sourceTrackId = readTrackIdFromSourceUrl(String(snapshot?.currentSrc || ''));
  const snapshotTrackId = String(snapshot?.activeTrack.matchedTrackId || '').trim();
  const metadataTrackId = String(params.metadataResolution?.matchedTrackId || '').trim();
  const snapshotMatchReason = String(snapshot?.activeTrack.matchedReason || '').trim();
  const metadataReason = String(params.metadataResolution?.selectedTrackReason || '').trim();
  const metadataAlignedRaw = Boolean(snapshot?.flags.metadataAlignedWithSource);
  const snapshotSource = String(snapshot?.source.tralbumSource || '').trim() || 'none';
  const snapshotIdentity = String(snapshot?.source.identitySource || '').trim() || 'none';
  const snapshotPlaylistReason = String(snapshot?.playlistCurrentIndexReason || '').trim() || 'none';
  const snapshotStrictMeta = Boolean(snapshot?.flags.metadataStrictTrackMatch);
  const snapshotStrictPlaylist = Boolean(snapshot?.flags.strictPlaylistBinding);

  const inferredTrack = !snapshotTrackId && metadataAlignedRaw && metadataTrackId ? metadataTrackId : snapshotTrackId;
  const inferredTrackFromMetadata = Boolean(
    !snapshotTrackId &&
    metadataTrackId &&
    inferredTrack &&
    inferredTrack === metadataTrackId
  );
  const metadataAlignedEffective = metadataAlignedRaw || Boolean(
    sourceTrackId &&
    metadataTrackId &&
    sourceTrackId === metadataTrackId
  );
  const inferredMatchReason =
    (snapshotMatchReason && snapshotMatchReason !== 'none')
      ? snapshotMatchReason
      : (
          metadataAlignedEffective && inferredTrackFromMetadata
            ? (
                metadataReason && metadataReason !== 'none'
                  ? `metadata.${metadataReason}(inferred)`
                  : 'metadata.trackId(inferred)'
              )
            : (snapshotMatchReason || 'none')
        );
  const inferredSourceLabel =
    snapshotSource !== 'none'
      ? snapshotSource
      : (metadataAlignedEffective && sourceFallback !== 'none' ? `${sourceFallback}(inferred)` : snapshotSource);
  const inferredIdentityLabel =
    snapshotIdentity !== 'none'
      ? snapshotIdentity
      : (metadataAlignedEffective && sourceFallback !== 'none' ? `${sourceFallback}(inferred)` : snapshotIdentity);
  const inferredPlaylistReason =
    snapshotPlaylistReason !== 'none'
      ? snapshotPlaylistReason
      : (
          metadataAlignedEffective && inferredMatchReason !== 'none'
            ? inferredMatchReason
            : snapshotPlaylistReason
        );

  const strictMetaInferred = !snapshotStrictMeta && inferredMatchReason !== 'none' && metadataAlignedEffective;
  const strictPlaylistInferred = !snapshotStrictPlaylist && strictMetaInferred && inferredPlaylistReason !== 'none';

  return {
    trackId: inferredTrack || '-',
    matchReason: inferredMatchReason || '-',
    sourceLabel: inferredSourceLabel || '-',
    identityLabel: inferredIdentityLabel || '-',
    playlistReason: inferredPlaylistReason || '-',
    metadataAlignedLabel: metadataAlignedRaw ? '1' : (metadataAlignedEffective ? '~' : '0'),
    strictMetaLabel: snapshotStrictMeta ? '1' : (strictMetaInferred ? '~' : '0'),
    strictPlaylistLabel: snapshotStrictPlaylist ? '1' : (strictPlaylistInferred ? '~' : '0')
  };
}

export interface PlayerDebugBodyInput {
  pageType: string;
  pageMode?: string;
  pageGroup?: string;
  pageSection?: string;
  pageOwnership?: string;
  pageFanId?: string;
  viewerFanId?: string;
  pageFanSlug?: string;
  hasPlaybackStarted: boolean;
  currentSrc: string;
  hasAudioElement: boolean;
  isPlaying: boolean;
  metadata: TrackMetadata;
  metadataResolution: MetadataResolution | null;
  analysis: AnalysisResult | null;
  metadataDebug: PlayerMetadataDebugSnapshot;
  playlistSource: string;
  playlistTrackCount: number;
  playlistCurrentIndex: number;
  playlistTrackStreamUrls?: string[];
  activePlaylistTrackId?: string;
  activePlaylistTrackStreamUrl?: string;
  resolverSnapshot?: NonReleaseResolverSnapshot | null;
  transportDebug: TransportDebugState;
  runtimeStretchCapability: RuntimeStretchCapability | null;
  runtimeAudioEngineDebug?: RuntimeAudioEngineDebugSnapshot | null;
  runtimeAudioIncidentDebug?: RuntimeAudioIncidentDebugSnapshot | null;
  runtimeAudioDebug?: {
    takeoverStage: string;
    takeoverReason: string;
    takeoverDetail: string;
    takeoverTrace: string[];
    armDetail: string;
    prepareStage: string;
    prepareReason: string;
    prepareDetail: string;
    prepareRequestKey: string;
    prepareSourceCacheKey: string;
    prepareFetchUrl: string;
    prepareInFlight: boolean;
    prepareHasPreparedTrack: boolean;
    prepareTrace: string[];
    ownershipState: RuntimeAudioOwnershipState;
    firstOriginAvailable: boolean;
    runtimeActive: boolean;
    runtimeOwned: boolean;
    runtimeSrc: string;
    runtimeReportedSrc: string;
    runtimePaused: boolean;
    runtimeTimeSec: number;
    runtimeDurationSec: number;
    handoverOriginSnapshotTimeSec: number | null;
    handoverSeekTargetTimeSec: number | null;
    handoverFirstRuntimeTimeSec: number | null;
    handoverFirstRuntimeDeltaSec: number | null;
    originMuteDetail: string;
    hostLoadDetail: string;
    hostResampleDetail: string;
    hostLatencyDetail: string;
    hostChurnDetail: string;
    hostScheduleDetail: string;
    hostFirstWindowDetail: string;
    hostPairDetail: string;
    awaitingFirstRuntimeSample: boolean;
    ts: number;
  } | null;
  playheadDebug?: {
    selectedSource: 'audio' | 'bridge';
    selectedReason: string;
    selectedCurrentSec: number;
    selectedDurationSec: number;
    selectedFraction: number;
    audioSrc: string;
    audioPaused: boolean;
    audioCurrentSec: number;
    audioDurationSec: number;
    bridgeSrc: string;
    bridgeOrigin: 'runtime' | 'origin-audio' | 'bridge-observer' | '-';
    bridgePaused: boolean;
    bridgeCurrentSec: number;
    bridgeDurationSec: number;
    pendingSeekFraction: number | null;
    pendingSeekAgeMs: number | null;
    lastUpdateTs: number;
    trace: Array<{
      ts: number;
      kind: 'selected-source' | 'seek-request' | 'seek-settled' | 'jump-backward' | 'jump-forward';
      detail: string;
    }>;
  };
  nativeSeekDebug?: {
    requestAt: number;
    requestFraction: number | null;
    requestTargetTimeSec: number | null;
    requestSelectedSource: 'audio' | 'bridge';
    requestRuntimeOwned: boolean;
    requestSrc: string;
    requestPaused: boolean;
    requestReadyState: number | null;
    requestNetworkState: number | null;
    requestBufferedAheadSec: number | null;
    dispatchMode: 'native-only' | 'runtime-only' | 'runtime+native' | 'handover' | '-';
    runtimeDispatchAt: number;
    runtimeDispatchDetail: string;
    nativeDispatchAt: number;
    nativeDispatchDetail: string;
    lastEvent: string;
    lastEventDetail: string;
    lastEventAt: number;
    seekingAt: number;
    seekedAt: number;
    firstTimeupdateAt: number;
    eventCurrentTimeSec: number | null;
    eventDurationSec: number | null;
    eventReadyState: number | null;
    eventNetworkState: number | null;
    eventBufferedAheadSec: number | null;
  };
  ownedPlaybackHostState: OwnedPlaybackHostState | null;
  likesDebug: LikesDebugSnapshot;
  keyAnalysisTrace?: KeyAnalysisTraceEntry[];
  preloadTrace?: KeyAnalysisTraceEntry[];
  preloadBpmBatchOpenTs?: number;
  preloadKeyBatchOpenTs?: number;
  preloadStateLines?: string[];
  likeUiLoading?: boolean;
  likeUiDisabled?: boolean;
  likeUiNotice?: string;
  uiPerformance?: UiPerformanceDebug;
  resourceDiagnostics?: ResourceDiagnosticsDebugState | null;
}

export function buildPlayerDebugSections(input: PlayerDebugBodyInput): DebugSection[] {
  const transportTraceLines = formatTransportTraceLines(input.transportDebug, 14);
  const metadataDebug = input.metadataDebug || {};
  const likeApiPhaseLines = formatLikeApiPhaseLines(input.likesDebug);
  const likeStateChangeLines = formatLikeStateChangeLines(input.likesDebug);
  const jumpDiagnosisLines = formatJumpDiagnosisLines(input.transportDebug, input.likesDebug);
  const inventoryMismatchLines = formatInventoryMismatchSummaryLines(input.likesDebug);
  const keyProcessLines = formatCurrentKeyProcessLines(input.keyAnalysisTrace);
  const preloadProcessLines = formatPreloadProcessLines(input.preloadTrace);
  const phaseTimelineLines = formatPhaseTimelineLines(input.keyAnalysisTrace, input.preloadTrace, {
    preloadBpmBatchOpenTs: input.preloadBpmBatchOpenTs,
    preloadKeyBatchOpenTs: input.preloadKeyBatchOpenTs
  });
  const runtimeAudioEngineDebug = input.runtimeAudioEngineDebug || null;
  const runtimeAudioIncidentDebug = input.runtimeAudioIncidentDebug || null;
  const runtimeEngineEntriesLine = runtimeAudioEngineDebug?.entries?.length
    ? runtimeAudioEngineDebug.entries
      .slice(0, 6)
      .map((entry) => {
        const ageMs = Math.max(0, Date.now() - Number(entry.preparedAt || 0));
        return `${entry.cacheKey || entry.url.slice(-36)}@v${entry.sourceVersion}:pcm=${formatBytes(entry.decodedByteLength)}:encoded=${formatBytes(entry.byteLength)}:${entry.durationSec.toFixed(1)}s:${entry.hasBuffer ? 'buf' : 'host'}:fetch=${entry.fetchMs}ms:decode=${entry.decodeMs}ms:total=${entry.totalMs}ms:age=${ageMs}ms`;
      })
      .join(' | ')
    : '-';
  const preloadStateLines = Array.isArray(input.preloadStateLines) && input.preloadStateLines.length
    ? input.preloadStateLines
    : ['(none)'];
  const playheadTraceLines = Array.isArray(input.playheadDebug?.trace) && input.playheadDebug?.trace.length
    ? input.playheadDebug.trace.slice(-8).map((entry) =>
        `${formatProcessTime(entry.ts)} [${entry.kind}] ${entry.detail}`)
    : ['(none)'];
  const runtimeAudioIncidentCurrentWarnings = filterCurrentRuntimeAudioIncidentEntries(
    runtimeAudioIncidentDebug,
    runtimeAudioIncidentDebug?.warnings
  );
  const runtimeAudioIncidentCurrentTimings = filterCurrentRuntimeAudioIncidentEntries(
    runtimeAudioIncidentDebug,
    runtimeAudioIncidentDebug?.timings
  );
  const runtimeAudioIncidentPriorWarningCount = Math.max(
    0,
    (runtimeAudioIncidentDebug?.warnings?.length || 0) - runtimeAudioIncidentCurrentWarnings.length
  );
  const runtimeAudioIncidentWarningLines = formatRuntimeAudioIncidentLines(runtimeAudioIncidentCurrentWarnings, 8);
  const runtimeAudioIncidentTimingLines = formatRuntimeAudioIncidentLines(runtimeAudioIncidentCurrentTimings, 10);
  const runtimeAudioIncidentEventLines = formatRuntimeAudioIncidentTimelineLines(runtimeAudioIncidentDebug, 36);
  const runtimeAudioIncidentRecentLines = formatRuntimeAudioIncidentRecentLines(runtimeAudioIncidentDebug, 4);
  const resolverDebug = resolveResolverDebugSummary({
    resolverSnapshot: input.resolverSnapshot,
    metadataResolution: input.metadataResolution,
    playlistSource: input.playlistSource
  });

  const builder = createDebugBuilder();

  builder.section('context')
    .line(`Page type: ${input.pageType}`)
    .line(`Page mode/group: ${input.pageMode || '-'} / ${input.pageGroup || '-'}`)
    .line(`Page section/ownership: ${input.pageSection || '-'} / ${input.pageOwnership || '-'}`)
    .line(`Page fan scope: slug=${input.pageFanSlug || '-'}, pageFanId=${input.pageFanId || '-'}, viewerFanId=${input.viewerFanId || '-'}`);

  builder.section('playback')
    .line(`Playback gate: ${input.hasPlaybackStarted ? 'opened' : 'waiting for origin-site play click'}`)
    .line(`Audio source summary: current=${formatAudioSourceSummary(input.currentSrc)}`)
    .line(`Audio source summary: playlist[${input.playlistCurrentIndex}]=track=${input.activePlaylistTrackId || '-'} ${formatAudioSourceSummary(input.activePlaylistTrackStreamUrl)}`)
    .line(`Audio source summary: metadata=${formatAudioSourceSummary(input.metadataResolution?.matchedStreamUrl)}`)
    .line(`Audio element: ${input.hasAudioElement ? 'present' : 'missing'}`)
    .line(`Playback: ${input.isPlaying ? 'playing' : 'paused'}`)
    .line(`Metadata: ${input.metadata.artistName} | ${input.metadata.trackTitle} | ${input.metadata.albumTitle}`);

  builder.section('metadata')
    .line(`Metadata confidence: ${input.metadata.confidence}`)
    .line(`Metadata sources: title=${input.metadata.sources.title}, artist=${input.metadata.sources.artist}, album=${input.metadata.sources.album}`)
    .line(`Metadata origin path: ${formatMetadataOriginPath(input.metadata)}`);

  builder.section('analysis')
    .line(`Analysis BPM: ${Number.isFinite(input.analysis?.bpm) ? Math.round(Number(input.analysis?.bpm)) : '-'}`)
    .line(`Analysis source: ${input.analysis?.bpmDebugSource || '-'}`)
    .line(`Analysis source detail: ${input.analysis?.bpmDebugDetail || '-'}`)
    .line(`Analysis cache snapshot: key=${input.analysis?.bpmDebugCacheKey || '-'} bpm=${Number.isFinite(input.analysis?.bpmDebugCacheBpm) ? Math.round(Number(input.analysis?.bpmDebugCacheBpm)) : '-'}`)
    .line(`Tempo base BPM: ${Number.isFinite(input.analysis?.tempoDebugBaseBpm) ? Math.round(Number(input.analysis?.tempoDebugBaseBpm)) : '-'}`)
    .line(`Tempo decision: ${input.analysis?.tempoDebugSummary || '-'}`)
    .line(`Tempo gate: ${input.analysis?.tempoDebugGate || '-'}`)
    .line(`Tempo candidates: ${Array.isArray(input.analysis?.tempoDebugCandidates) && input.analysis.tempoDebugCandidates.length
      ? input.analysis.tempoDebugCandidates.map((candidate) => `${candidate.bpm}@${candidate.label}:${Number(candidate.score).toFixed(2)}`).join(', ')
      : '-'}`)
    .line(`Analysis confidence: ${Number.isFinite(input.analysis?.confidence) ? `${Math.round(Number(input.analysis?.confidence))}%` : '-'}`)
    .line(`Analysis raw confidence: ${Number.isFinite(input.analysis?.tempoRawConfidence) ? `${Math.round(Number(input.analysis?.tempoRawConfidence))}%` : '-'}`)
    .line(`Tempo decision confidence: ${Number.isFinite(input.analysis?.tempoDecisionConfidence) ? `${Math.round(Number(input.analysis?.tempoDecisionConfidence))}%` : '-'}`)
    .line(`Analysis status: ${input.analysis?.analysisStatus || '-'}, timing=${Number.isFinite(input.analysis?.analysisMs) ? `${Math.round(Number(input.analysis?.analysisMs))}ms` : '-'}`)
    .line(`Analysis timing split: fetch=${Number.isFinite(input.analysis?.analysisFetchMs) ? `${Math.round(Number(input.analysis?.analysisFetchMs))}ms` : '-'} | decode=${Number.isFinite(input.analysis?.analysisDecodeMs) ? `${Math.round(Number(input.analysis?.analysisDecodeMs))}ms` : '-'} | tempo=${Number.isFinite(input.analysis?.analysisTempoMs) ? `${Math.round(Number(input.analysis?.analysisTempoMs))}ms` : '-'}`)
    .line(`Analysis served by: ${input.analysis?.analysisServedBy || '-'} | audio completeness: ${input.analysis?.analysisAudioCompleteness || '-'}`)
    .line(`Worker pool: ${input.analysis?.workerPoolDebug || '-'}`)
    .lines(formatKeyAnalysisLines(input.analysis))
    .trace('Phase timeline:', phaseTimelineLines)
    .trace('Key process:', keyProcessLines);

  builder.section('playlist')
    .trace('Preload state:', preloadStateLines)
    .trace('Preload process:', preloadProcessLines);

  builder.section('analysis')
    .line(`Waveform: ${input.analysis?.waveform ? `ready (${input.analysis.waveform.buckets} buckets)` : 'none'}`)
    .line(`Waveform status: ${input.analysis?.waveformStatus || '-'}, timing=${Number.isFinite(input.analysis?.waveformMs) ? `${Math.round(Number(input.analysis?.waveformMs))}ms` : '-'}`)
    .line(`Waveform cache keys: content=${input.analysis?.waveformDebugContentKey || '-'} backend=${input.analysis?.waveformDebugBackendKey || '-'}`)
    .line(`Waveform source summary: analysis=${formatAudioSourceSummary(input.analysis?.sourceUrl)} resolved=${formatAudioSourceSummary(input.analysis?.resolvedAudioUrl)} duration=${Number.isFinite(input.analysis?.waveform?.duration) ? Number(input.analysis?.waveform?.duration).toFixed(2) : '-'}`)
    .line(`Waveform trace latest: ${findLastTraceEntry(input.keyAnalysisTrace, ['waveform-start', 'waveform-pending', 'waveform-settle', 'waveform-skip', 'waveform-seed', 'waveform-retry'])?.detail || '-'}`);

  builder.section('performance')
    .line(formatUiPerformanceLine(input.uiPerformance))
    .line(formatWaveformAnimationLine(input.uiPerformance))
    .lines(formatResourceDiagnosticsLines(input.resourceDiagnostics));

  builder.section('analysis')
    .line(`Chrome offscreen: ${input.analysis?.chromeOffscreenDebug || '-'}`);

  builder.section('metadata')
    .line(`Metadata match: trackId=${input.metadataResolution?.matchedTrackId || '-'}, reason=${input.metadataResolution?.selectedTrackReason || '-'}`)
    .line(`Metadata stream match: ${input.metadataResolution?.matchedStreamUrl || '-'}`)
    .line(`Metadata debug: trackId=${metadataDebug.trackId || '-'}, globals=${metadataDebug.globals || '-'}`)
    .line(`Metadata debug: linkedRelease=${metadataDebug.linkedReleaseUrl || '-'}`)
    .line(`Metadata debug: domIdentity=${metadataDebug.domIdentity || '-'}`)
    .line(`Metadata debug: domDetails=${metadataDebug.domDetails || '-'}`)
    .line(`Metadata debug: strictIdentity=${metadataDebug.strictIdentity || '-'}`)
    .line(`Metadata debug: candidates=${metadataDebug.candidates ?? '-'}, primary=${metadataDebug.primaryIdentity || '-'}, resolved=${metadataDebug.resolvedIdentity || '-'}, cached=${metadataDebug.cachedIdentity || '-'}`)
    .line(`Metadata debug: counters accepted=${metadataDebug.apiCandidateStrictAccepted ?? '-'}, rejected=${metadataDebug.apiCandidateRejected ?? '-'}, fallbackUsed=${metadataDebug.fallbackUsed ?? '-'}`)
    .line(`Metadata debug: strictApi=${metadataDebug.strictApiState || '-'}`)
    .line(`Metadata debug: apiProbe=${metadataDebug.apiProbeState || '-'}`)
    .line(`Metadata debug: lastDecision=${metadataDebug.pathLastDecision || '-'}`);

  builder.section('likes')
    .line(`LIKES phase/context: ${input.likesDebug.phase} / ${input.likesDebug.context}`)
    .line(`LIKES fan: slug=${input.likesDebug.fanSlug || '-'}, id=${input.likesDebug.fanId || '-'}`)
    .line(`LIKES sync: status=${input.likesDebug.syncStatus}, reason=${input.likesDebug.syncReason || '-'}, last=${formatIsoTime(input.likesDebug.lastSyncTs)}`)
    .line(`LIKES sync detail: run=${input.likesDebug.syncRunSeq}, inFlightSince=${formatIsoTime(input.likesDebug.syncInFlightSince)}`)
    .line(formatLikesAutoRefreshLine(input.likesDebug))
    .line(`LIKES deep: ${formatDeepSyncStatus(input.likesDebug)}`)
    .line(`LIKES bought cache: status=${input.likesDebug.boughtCacheStatus || '-'}, updated=${formatIsoTime(input.likesDebug.boughtCacheUpdatedAt)}, read=${formatIsoTime(input.likesDebug.boughtCacheLastReadAt)}, write=${formatIsoTime(input.likesDebug.boughtCacheLastWriteAt)}`)
    .line(`LIKES bought cache counts: cAId=${input.likesDebug.boughtCacheCollectionAlbumIds || 0}, cTId=${input.likesDebug.boughtCacheCollectionTrackIds || 0}, cAUrl=${input.likesDebug.boughtCacheCollectionAlbumUrls || 0}, cTUrl=${input.likesDebug.boughtCacheCollectionTrackUrls || 0}`)
    .line(`LIKES endpoints: wishlist=${input.likesDebug.endpointStatus.wishlist}, collection=${input.likesDebug.endpointStatus.collection}`)
    .line(`LIKES attempts: wishlist=${input.likesDebug.endpointAttempts.wishlist}, collection=${input.likesDebug.endpointAttempts.collection}, nextRetry=${formatIsoTime(input.likesDebug.nextRetryTs)}`)
    .line(`LIKES counts: wAId=${input.likesDebug.inventoryCounts.wishlistAlbumIds}, wTId=${input.likesDebug.inventoryCounts.wishlistTrackIds}, wAUrl=${input.likesDebug.inventoryCounts.wishlistAlbumUrls}, wTUrl=${input.likesDebug.inventoryCounts.wishlistTrackUrls}, cAId=${input.likesDebug.inventoryCounts.collectionAlbumIds}, cTId=${input.likesDebug.inventoryCounts.collectionTrackIds}, cAUrl=${input.likesDebug.inventoryCounts.collectionAlbumUrls}, cTUrl=${input.likesDebug.inventoryCounts.collectionTrackUrls}`)
    .line(`LIKES truth: album=${input.likesDebug.truthAlbumState}, track[${input.likesDebug.activeTrackIndex}]=${input.likesDebug.truthActiveTrackState}`)
    .line(`LIKES display: album=${input.likesDebug.displayAlbumState}, track[${input.likesDebug.activeTrackIndex}]=${input.likesDebug.displayActiveTrackState}, projection=${input.likesDebug.trackProjection || '-'}`)
    .trace('LIKES state changes:', likeStateChangeLines)
    .line(`LIKES ui: loading=${input.likeUiLoading ? '1' : '0'}, disabled=${input.likeUiDisabled ? '1' : '0'}, notice=${input.likeUiNotice || '-'}`)
    .line(`LIKES identity: trust=${input.likesDebug.identityTrust || '-'}, reason=${input.likesDebug.identityReason || '-'}`)
    .line(`LIKES action: ${input.likesDebug.lastAction || '-'} @ ${formatIsoTime(input.likesDebug.lastActionTs)} error=${input.likesDebug.lastError || '-'}`)
    .lines(formatLikeMutationLines(input.likesDebug))
    .trace('LIKES inventory mismatches:', inventoryMismatchLines)
    .trace('LIKES API phase:', likeApiPhaseLines);

  builder.section('transport')
    .trace('Jump diagnosis:', jumpDiagnosisLines);

  builder.section('playlist')
    .line(`Playlist source: ${input.playlistSource}`)
    .line(`Playlist tracks: ${input.playlistTrackCount}, current=${input.playlistCurrentIndex}`);

  builder.section('resolver')
    .line(`Resolver snapshot: src=${input.resolverSnapshot?.currentSrc || '-'}, track=${resolverDebug.trackId}, match=${resolverDebug.matchReason}`)
    .line(`Resolver snapshot: source=${resolverDebug.sourceLabel}, identity=${resolverDebug.identityLabel}, allowApi=${input.resolverSnapshot?.source.allowApiFetch ? '1' : '0'}, preferApi=${input.resolverSnapshot?.source.preferApi ? '1' : '0'}, stale=${input.resolverSnapshot?.source.staleTrack ? '1' : '0'}`)
    .line(`Resolver snapshot: playlistReason=${resolverDebug.playlistReason}, metadataAligned=${resolverDebug.metadataAlignedLabel}, strictMeta=${resolverDebug.strictMetaLabel}, strictPlaylist=${resolverDebug.strictPlaylistLabel}, playability=${input.resolverSnapshot?.flags.playabilityGated ? 'gated' : 'ok'}`);

  builder.section('runtime')
    .line(`Signalsmith runtime: ${input.runtimeStretchCapability
      ? (input.runtimeStretchCapability.reason === 'pending'
        ? 'pending'
        : (input.runtimeStretchCapability.supported ? 'supported' : 'blocked'))
      : 'unchecked'}`)
    .line(`Signalsmith reason: ${input.runtimeStretchCapability?.reason || '-'}`)
    .line(`Signalsmith detail: ${input.runtimeStretchCapability?.detail || '-'}`)
    .line(`Signalsmith checked: ${input.runtimeStretchCapability ? formatIsoTime(input.runtimeStretchCapability.checkedAt) : '-'}`)
    .line(`Runtime cache: prepared=${runtimeAudioEngineDebug?.preparedCount ?? 0}/${runtimeAudioEngineDebug?.maxPrepared ?? 0} active=${runtimeAudioEngineDebug?.activePrepareCount ?? 0} parallel=${runtimeAudioEngineDebug?.maxConcurrentPredecode ?? '-'} window=${runtimeAudioEngineDebug?.predecodeWindowTracks ?? '-'} policy=${runtimeAudioEngineDebug?.capacityReason || '-'} memory=${formatDeviceMemoryGb(runtimeAudioEngineDebug?.deviceMemoryGb)} pcm=${formatBytes(runtimeAudioEngineDebug?.preparedDecodedBytes ?? 0)}/${formatBytes(runtimeAudioEngineDebug?.maxDecodedBytes ?? 0)} encoded=${formatBytes(runtimeAudioEngineDebug?.preparedBytes ?? 0)} encodedCache=${runtimeAudioEngineDebug?.encodedCacheCount ?? 0}:${formatBytes(runtimeAudioEngineDebug?.encodedCacheBytes ?? 0)}/${formatBytes(runtimeAudioEngineDebug?.maxEncodedBytes ?? 0)} encHits=${runtimeAudioEngineDebug?.encodedCacheHits ?? 0} duration=${Number.isFinite(runtimeAudioEngineDebug?.preparedDurationSec) ? Number(runtimeAudioEngineDebug?.preparedDurationSec || 0).toFixed(1) : '0.0'}s`)
    .line(formatRuntimePlaylistPreparationLine(
      input.playlistTrackStreamUrls || [],
      runtimeAudioEngineDebug,
      input.playlistCurrentIndex,
      input.playlistTrackCount
    ))
    .line(`Runtime cache health: attempts=${runtimeAudioEngineDebug?.prepareAttemptCount ?? 0} evictions=${runtimeAudioEngineDebug?.evictionCount ?? 0} failures=${runtimeAudioEngineDebug?.prepareFailureCount ?? 0} lastFailure=${runtimeAudioEngineDebug?.lastPrepareFailure || '-'} staleFetch=${runtimeAudioEngineDebug?.staleFetchCount ?? 0} staleDecode=${runtimeAudioEngineDebug?.staleDecodeCount ?? 0} stalePrepare=${runtimeAudioEngineDebug?.stalePrepareCount ?? 0}`)
    .line(`Runtime cache current: lastPrepared=${runtimeAudioEngineDebug?.lastPreparedUrl || '-'} activeUrls=${runtimeAudioEngineDebug?.activePrepareUrls?.join(' | ') || '-'}`)
    .line(`Runtime cache entries: ${runtimeEngineEntriesLine}`);

  builder.section('handover')
    .line(`Runtime takeover: ${input.runtimeAudioDebug?.takeoverStage || 'idle'}`)
    .line(`Runtime takeover reason: ${input.runtimeAudioDebug?.takeoverReason || '-'}`)
    .line(`Runtime takeover detail: ${input.runtimeAudioDebug?.takeoverDetail || '-'}`)
    .line(`Runtime arm: ${input.runtimeAudioDebug?.armDetail || '-'}`);

  builder.section('runtime')
    .line(`Runtime prepare: ${input.runtimeAudioDebug?.prepareStage || 'idle'}`)
    .line(`Runtime prepare reason: ${input.runtimeAudioDebug?.prepareReason || '-'}`)
    .line(`Runtime prepare detail: ${input.runtimeAudioDebug?.prepareDetail || '-'}`)
    .line(`Runtime prepare keys: request=${input.runtimeAudioDebug?.prepareRequestKey || '-'} cache=${input.runtimeAudioDebug?.prepareSourceCacheKey || '-'} prepared=${input.runtimeAudioDebug?.prepareHasPreparedTrack ? '1' : '0'} inFlight=${(runtimeAudioEngineDebug?.activePrepareCount ?? 0) > 0 ? '1' : '0'}`)
    .line(`Runtime prepare fetchUrl: ${input.runtimeAudioDebug?.prepareFetchUrl || '-'}`)
    .line(`Runtime prepare trace: ${input.runtimeAudioDebug?.prepareTrace?.slice(-12).join(' | ') || '-'}`);

  builder.section('handover')
    .line(`Runtime ownership: state=${input.runtimeAudioDebug?.ownershipState || '-'} firstOriginAvailable=${input.runtimeAudioDebug?.firstOriginAvailable ? '1' : '0'}`)
    .line(`Runtime audio: owned=${input.runtimeAudioDebug?.runtimeOwned ? '1' : '0'} active=${input.runtimeAudioDebug?.runtimeActive ? '1' : '0'} src=${input.runtimeAudioDebug?.runtimeSrc ? input.runtimeAudioDebug.runtimeSrc.slice(-40) : '-'} paused=${input.runtimeAudioDebug?.runtimePaused ? '1' : '0'} t=${input.runtimeAudioDebug ? `${input.runtimeAudioDebug.runtimeTimeSec.toFixed(2)}/${input.runtimeAudioDebug.runtimeDurationSec.toFixed(2)}` : '-/-'}`)
    .line(`Runtime audio raw src: ${input.runtimeAudioDebug?.runtimeReportedSrc || '-'}`)
    .line(`Runtime handover: origin=${input.runtimeAudioDebug?.handoverOriginSnapshotTimeSec !== null && input.runtimeAudioDebug?.handoverOriginSnapshotTimeSec !== undefined ? input.runtimeAudioDebug.handoverOriginSnapshotTimeSec.toFixed(2) : '-'} seek=${input.runtimeAudioDebug?.handoverSeekTargetTimeSec !== null && input.runtimeAudioDebug?.handoverSeekTargetTimeSec !== undefined ? input.runtimeAudioDebug.handoverSeekTargetTimeSec.toFixed(2) : '-'} firstRuntime=${input.runtimeAudioDebug?.handoverFirstRuntimeTimeSec !== null && input.runtimeAudioDebug?.handoverFirstRuntimeTimeSec !== undefined ? input.runtimeAudioDebug.handoverFirstRuntimeTimeSec.toFixed(2) : '-'} delta=${input.runtimeAudioDebug?.handoverFirstRuntimeDeltaSec !== null && input.runtimeAudioDebug?.handoverFirstRuntimeDeltaSec !== undefined ? input.runtimeAudioDebug.handoverFirstRuntimeDeltaSec.toFixed(2) : '-'} pending=${input.runtimeAudioDebug?.awaitingFirstRuntimeSample ? '1' : '0'}`)
    .line(`Runtime origin mute: ${input.runtimeAudioDebug?.originMuteDetail || '-'}`)
    .line(`Runtime host load: ${input.runtimeAudioDebug?.hostLoadDetail || '-'}`)
    .line(`Runtime host resample: ${input.runtimeAudioDebug?.hostResampleDetail || '-'}`)
    .line(`Runtime host latency: ${input.runtimeAudioDebug?.hostLatencyDetail || '-'}`)
    .line(`Runtime host churn: ${input.runtimeAudioDebug?.hostChurnDetail || '-'}`)
    .line(`Runtime host pair: ${input.runtimeAudioDebug?.hostPairDetail || '-'}`)
    .line(`Runtime host schedule: ${input.runtimeAudioDebug?.hostScheduleDetail || '-'}`)
    .line(`Runtime host first window: ${input.runtimeAudioDebug?.hostFirstWindowDetail || '-'}`)
    .line(`Runtime trace: ${input.runtimeAudioDebug?.takeoverTrace?.slice(-12).join(' | ') || '-'}`)
    .line(`Audio incident: id=${runtimeAudioIncidentDebug?.currentTransitionId || '-'} reason=${runtimeAudioIncidentDebug?.currentReason || '-'} target=${runtimeAudioIncidentDebug?.targetSrc || '-'} stage=${runtimeAudioIncidentDebug?.targetStage || 'idle'} warnings=${runtimeAudioIncidentCurrentWarnings.length} priorWarnings=${runtimeAudioIncidentPriorWarningCount}`)
    .line(`Audio incident browser: ${runtimeAudioIncidentDebug?.browserAudio || '-'}`)
    .trace('Audio incident warnings:', runtimeAudioIncidentWarningLines)
    .trace('Audio incident timings:', runtimeAudioIncidentTimingLines)
    .trace('Audio incident timeline:', runtimeAudioIncidentEventLines)
    .trace('Audio incident recent:', runtimeAudioIncidentRecentLines)
    .line(`Playhead debug: selected=${input.playheadDebug?.selectedSource || '-'} reason=${input.playheadDebug?.selectedReason || '-'} t=${input.playheadDebug ? `${input.playheadDebug.selectedCurrentSec.toFixed(2)}/${input.playheadDebug.selectedDurationSec.toFixed(2)}` : '-/-'} frac=${input.playheadDebug ? input.playheadDebug.selectedFraction.toFixed(3) : '-'}`)
    .line(`Playhead debug: audio src=${input.playheadDebug?.audioSrc || '-'} paused=${input.playheadDebug?.audioPaused ? '1' : '0'} t=${input.playheadDebug ? `${input.playheadDebug.audioCurrentSec.toFixed(2)}/${input.playheadDebug.audioDurationSec.toFixed(2)}` : '-/-'}`)
    .line(`Playhead debug: bridge src=${input.playheadDebug?.bridgeSrc || '-'} origin=${input.playheadDebug?.bridgeOrigin || '-'} paused=${input.playheadDebug?.bridgePaused ? '1' : '0'} t=${input.playheadDebug ? `${input.playheadDebug.bridgeCurrentSec.toFixed(2)}/${input.playheadDebug.bridgeDurationSec.toFixed(2)}` : '-/-'}`)
    .line(`Playhead debug: pendingSeek=${input.playheadDebug?.pendingSeekFraction !== null && input.playheadDebug?.pendingSeekFraction !== undefined ? input.playheadDebug.pendingSeekFraction.toFixed(3) : '-'} ageMs=${input.playheadDebug?.pendingSeekAgeMs ?? '-'}`)
    .line(`Native seek: fraction=${input.nativeSeekDebug?.requestFraction !== null && input.nativeSeekDebug?.requestFraction !== undefined ? input.nativeSeekDebug.requestFraction.toFixed(3) : '-'} target=${input.nativeSeekDebug?.requestTargetTimeSec !== null && input.nativeSeekDebug?.requestTargetTimeSec !== undefined ? input.nativeSeekDebug.requestTargetTimeSec.toFixed(2) : '-'} mode=${input.nativeSeekDebug?.dispatchMode || '-'} selected=${input.nativeSeekDebug?.requestSelectedSource || '-'} runtimeOwned=${input.nativeSeekDebug?.requestRuntimeOwned ? '1' : '0'}`)
    .line(`Native seek request: src=${input.nativeSeekDebug?.requestSrc || '-'} paused=${input.nativeSeekDebug?.requestPaused ? '1' : '0'} ready=${input.nativeSeekDebug?.requestReadyState ?? '-'} network=${input.nativeSeekDebug?.requestNetworkState ?? '-'} bufferedAhead=${input.nativeSeekDebug?.requestBufferedAheadSec !== null && input.nativeSeekDebug?.requestBufferedAheadSec !== undefined ? input.nativeSeekDebug.requestBufferedAheadSec.toFixed(2) : '-'} at=${formatSince(input.nativeSeekDebug?.requestAt || 0)}`)
    .line(`Native seek dispatch: runtime=${input.nativeSeekDebug?.runtimeDispatchDetail || '-'} (${formatSince(input.nativeSeekDebug?.runtimeDispatchAt || 0)}) native=${input.nativeSeekDebug?.nativeDispatchDetail || '-'} (${formatSince(input.nativeSeekDebug?.nativeDispatchAt || 0)})`)
    .line(`Native seek lifecycle: last=${input.nativeSeekDebug?.lastEvent || '-'} (${formatSince(input.nativeSeekDebug?.lastEventAt || 0)}) detail=${input.nativeSeekDebug?.lastEventDetail || '-'} seeking=${input.nativeSeekDebug?.seekingAt ? formatSince(input.nativeSeekDebug.seekingAt) : '-'} seeked=${input.nativeSeekDebug?.seekedAt ? formatSince(input.nativeSeekDebug.seekedAt) : '-'} firstTimeupdate=${input.nativeSeekDebug?.firstTimeupdateAt ? formatSince(input.nativeSeekDebug.firstTimeupdateAt) : '-'}`)
    .trace('Playhead trace:', playheadTraceLines)
    .line(`Owned playback host: ${input.ownedPlaybackHostState?.status || 'unchecked'}`)
    .line(`Owned playback phase: ${input.ownedPlaybackHostState?.phase || '-'}`)
    .line(`Owned playback engine: ${input.ownedPlaybackHostState?.engine || '-'}`)
    .line(`Owned playback detail: ${input.ownedPlaybackHostState?.detail || '-'}`)
    .line(`Owned playback origin currentSrc: ${input.ownedPlaybackHostState?.currentSrc || '-'}`)
    .line(`Owned playback runtime currentSrc: ${input.runtimeAudioDebug?.runtimeReportedSrc || '-'}`)
    .line(`Owned playback flags: playing=${input.ownedPlaybackHostState?.playing ? '1' : '0'} detachedReady=${input.ownedPlaybackHostState?.detachedReady ? '1' : '0'} lastCommand=${input.ownedPlaybackHostState?.lastCommand || '-'}`)
    .line(`Owned playback command: detail=${input.ownedPlaybackHostState?.lastCommandDetail || '-'} (${formatSince(input.ownedPlaybackHostState?.lastCommandAt || 0)})`)
    .line(`Owned playback audio event: ${input.ownedPlaybackHostState?.lastAudioEvent || '-'} detail=${input.ownedPlaybackHostState?.lastAudioEventDetail || '-'} (${formatSince(input.ownedPlaybackHostState?.lastAudioEventAt || 0)})`);

  builder.section('transport')
    .line(`Transport debug: seq=${input.transportDebug.actionSeq}, ui=${input.transportDebug.lastUiAction} (${formatSince(input.transportDebug.lastUiActionAt)})`)
    .line(`Transport debug: uiDetail=${input.transportDebug.lastUiActionDetail}`)
    .line(`Transport debug: bridge=${input.transportDebug.lastBridgeEvent} (${formatSince(input.transportDebug.lastBridgeAt)})`)
    .line(`Transport debug: bridgeDetail=${input.transportDebug.lastBridgeDetail}`)
    .line(`Transport debug: counters ui=${input.transportDebug.uiCount}, selection=${input.transportDebug.selectionCount}, bridge=${input.transportDebug.bridgeCount}, align=${input.transportDebug.alignCount}, guard=${input.transportDebug.guardCount}`)
    .line(`Transport debug: selectionStats ok=${input.transportDebug.selectionOkCount}, miss=${input.transportDebug.selectionMissCount}, fallbackLoad=${input.transportDebug.fallbackLoadCount}, blocked=${input.transportDebug.blockedCount}`);

  builder.section('playlist')
    .line(`Playlist debug: selection=${input.transportDebug.lastSelection} (${formatSince(input.transportDebug.lastSelectionAt)})`)
    .line(`Playlist debug: selectionDetail=${input.transportDebug.lastSelectionDetail}`)
    .line(`Playlist debug: align=${input.transportDebug.lastPlaylistAlign} (${formatSince(input.transportDebug.lastPlaylistAlignAt)})`);

  builder.section('transport')
    .trace('Transport trace:', transportTraceLines.length ? transportTraceLines : ['(none)']);

  return builder.build();
}

export interface DiscoverDebugBodyInput {
  nowPlaying: {
    streamUrl: string;
    releaseUrl: string;
    isPlaying: boolean;
    trackId?: string;
    identity?: {
      bandId?: string;
      tralbumId?: string;
      tralbumType?: string;
      trackId?: string;
    } | null;
    sources: {
      title: string;
      artist: string;
      album: string;
      release: string;
      stream: string;
      identity: string;
    };
  };
  panelInput: PanelInput;
  playlistSource: string;
  runId: number;
  apiPolicyLine: string;
  apiShadowPolicyLine: string;
  hintDebug: string;
  discoverStrictMatchDebug?: string;
  resolverSnapshot?: NonReleaseResolverSnapshot | null;
  transportDebug: DiscoverTransportDebugState;
  likesDebug: LikesDebugSnapshot;
  keyAnalysisTrace?: KeyAnalysisTraceEntry[];
  jumpTrace?: KeyAnalysisTraceEntry[];
  preloadTrace?: KeyAnalysisTraceEntry[];
  preloadBpmBatchOpenTs?: number;
  preloadKeyBatchOpenTs?: number;
  preloadStateLines?: string[];
  resolverTrace?: KeyAnalysisTraceEntry[];
  metadataDebugLines?: string[];
  bridgeDebugLines?: string[];
  runtimeAudioEngineDebug?: RuntimeAudioEngineDebugSnapshot | null;
  resourceDiagnostics?: ResourceDiagnosticsDebugState | null;
}

export function buildDiscoverDebugSections(input: DiscoverDebugBodyInput): DebugSection[] {
  const transportTraceLines = formatDiscoverTransportTraceLines(input.transportDebug, 8);
  const streamTrackId = input.nowPlaying.trackId || '-';
  const identity = input.nowPlaying.identity
    ? `${input.nowPlaying.identity.bandId || '-'}:${input.nowPlaying.identity.tralbumId || '-'}:${input.nowPlaying.identity.tralbumType || '-'}:track=${input.nowPlaying.identity.trackId || '-'}`
    : '-';
  const likeApiPhaseLines = formatLikeApiPhaseLines(input.likesDebug);
  const likeStateChangeLines = formatLikeStateChangeLines(input.likesDebug);
  const inventoryMismatchLines = formatInventoryMismatchSummaryLines(input.likesDebug);
  const keyProcessLines = formatCurrentKeyProcessLines(input.keyAnalysisTrace);
  const jumpProcessLines = formatKeyProcessLines(input.jumpTrace, 40);
  const preloadProcessLines = formatPreloadProcessLines(input.preloadTrace);
  const phaseTimelineLines = formatPhaseTimelineLines(input.keyAnalysisTrace, input.preloadTrace, {
    preloadBpmBatchOpenTs: input.preloadBpmBatchOpenTs,
    preloadKeyBatchOpenTs: input.preloadKeyBatchOpenTs
  });
  const runtimeAudioEngineDebug = input.runtimeAudioEngineDebug || null;
  const runtimeEngineEntriesLine = runtimeAudioEngineDebug?.entries?.length
    ? runtimeAudioEngineDebug.entries
      .slice(0, 6)
      .map((entry) => {
        const ageMs = Math.max(0, Date.now() - Number(entry.preparedAt || 0));
        return `${entry.cacheKey || entry.url.slice(-36)}@v${entry.sourceVersion}:pcm=${formatBytes(entry.decodedByteLength)}:encoded=${formatBytes(entry.byteLength)}:${entry.durationSec.toFixed(1)}s:${entry.hasBuffer ? 'buf' : 'host'}:fetch=${entry.fetchMs}ms:decode=${entry.decodeMs}ms:total=${entry.totalMs}ms:age=${ageMs}ms`;
      })
      .join(' | ')
    : '-';
  const resolverProcessLines = formatKeyProcessLines(input.resolverTrace);
  const resolverDebug = resolveResolverDebugSummary({
    resolverSnapshot: input.resolverSnapshot,
    metadataResolution: null,
    playlistSource: input.playlistSource
  });
  const preloadStateLines = Array.isArray(input.preloadStateLines) && input.preloadStateLines.length
    ? input.preloadStateLines
    : ['(none)'];
  const metadataDebugLines = Array.isArray(input.metadataDebugLines) && input.metadataDebugLines.length
    ? input.metadataDebugLines
    : ['Metadata display: -'];
  const bridgeDebugLines = Array.isArray(input.bridgeDebugLines) && input.bridgeDebugLines.length
    ? input.bridgeDebugLines
    : ['Bridge host: -'];

  const builder = createDebugBuilder();

  builder.section('context')
    .line('Page type: discover');

  builder.section('playback')
    .line(`Playback gate: ${input.nowPlaying.streamUrl ? 'opened' : 'waiting for origin-site play click'}`)
    .line(`Audio URL: ${input.nowPlaying.streamUrl || '(none)'}`)
    .line('Audio element: missing (expected on discover)')
    .line(`Playback: ${input.nowPlaying.isPlaying ? 'playing' : 'paused'}`)
    .line(`Metadata: ${input.panelInput.metadata.artistName} | ${input.panelInput.metadata.trackTitle} | ${input.panelInput.metadata.albumTitle}`);

  builder.section('metadata')
    .line(`Metadata confidence: ${input.panelInput.metadata.confidence}`)
    .line(`Metadata sources: title=${input.panelInput.metadata.sources.title}, artist=${input.panelInput.metadata.sources.artist}, album=${input.panelInput.metadata.sources.album}`)
    .line(`Metadata origin path: ${formatMetadataOriginPath(input.panelInput.metadata)}`);

  builder.section('analysis')
    .line(`Analysis BPM: ${Number.isFinite(input.panelInput.analysis?.bpm) ? Math.round(Number(input.panelInput.analysis?.bpm)) : '-'}`)
    .line(`Analysis source: ${input.panelInput.analysis?.bpmDebugSource || '-'}`)
    .line(`Analysis source detail: ${input.panelInput.analysis?.bpmDebugDetail || '-'}`)
    .line(`Analysis cache snapshot: key=${input.panelInput.analysis?.bpmDebugCacheKey || '-'} bpm=${Number.isFinite(input.panelInput.analysis?.bpmDebugCacheBpm) ? Math.round(Number(input.panelInput.analysis?.bpmDebugCacheBpm)) : '-'}`)
    .line(`Tempo base BPM: ${Number.isFinite(input.panelInput.analysis?.tempoDebugBaseBpm) ? Math.round(Number(input.panelInput.analysis?.tempoDebugBaseBpm)) : '-'}`)
    .line(`Tempo decision: ${input.panelInput.analysis?.tempoDebugSummary || '-'}`)
    .line(`Tempo gate: ${input.panelInput.analysis?.tempoDebugGate || '-'}`)
    .line(`Tempo candidates: ${Array.isArray(input.panelInput.analysis?.tempoDebugCandidates) && input.panelInput.analysis.tempoDebugCandidates.length
      ? input.panelInput.analysis.tempoDebugCandidates.map((candidate) => `${candidate.bpm}@${candidate.label}:${Number(candidate.score).toFixed(2)}`).join(', ')
      : '-'}`)
    .line(`Analysis confidence: ${Number.isFinite(input.panelInput.analysis?.confidence) ? `${Math.round(Number(input.panelInput.analysis?.confidence))}%` : '-'}`)
    .line(`Analysis raw confidence: ${Number.isFinite(input.panelInput.analysis?.tempoRawConfidence) ? `${Math.round(Number(input.panelInput.analysis?.tempoRawConfidence))}%` : '-'}`)
    .line(`Tempo decision confidence: ${Number.isFinite(input.panelInput.analysis?.tempoDecisionConfidence) ? `${Math.round(Number(input.panelInput.analysis?.tempoDecisionConfidence))}%` : '-'}`)
    .line(`Analysis status: ${input.panelInput.analysis?.analysisStatus || '-'}, timing=${Number.isFinite(input.panelInput.analysis?.analysisMs) ? `${Math.round(Number(input.panelInput.analysis?.analysisMs))}ms` : '-'}`)
    .line(`Analysis timing split: fetch=${Number.isFinite(input.panelInput.analysis?.analysisFetchMs) ? `${Math.round(Number(input.panelInput.analysis?.analysisFetchMs))}ms` : '-'} | decode=${Number.isFinite(input.panelInput.analysis?.analysisDecodeMs) ? `${Math.round(Number(input.panelInput.analysis?.analysisDecodeMs))}ms` : '-'} | tempo=${Number.isFinite(input.panelInput.analysis?.analysisTempoMs) ? `${Math.round(Number(input.panelInput.analysis?.analysisTempoMs))}ms` : '-'}`)
    .line(`Analysis served by: ${input.panelInput.analysis?.analysisServedBy || '-'} | audio completeness: ${input.panelInput.analysis?.analysisAudioCompleteness || '-'}`)
    .line(`Worker pool: ${input.panelInput.analysis?.workerPoolDebug || '-'}`)
    .lines(formatKeyAnalysisLines(input.panelInput.analysis))
    .trace('Phase timeline:', phaseTimelineLines)
    .trace('Key process:', keyProcessLines)
    .line(`Waveform: ${input.panelInput.analysis?.waveform ? `ready (${input.panelInput.analysis.waveform.buckets} buckets)` : 'none'}`)
    .line(`Waveform status: ${input.panelInput.analysis?.waveformStatus || '-'}, timing=${Number.isFinite(input.panelInput.analysis?.waveformMs) ? `${Math.round(Number(input.panelInput.analysis?.waveformMs))}ms` : '-'}`)
    .line(`Waveform cache keys: content=${input.panelInput.analysis?.waveformDebugContentKey || '-'} backend=${input.panelInput.analysis?.waveformDebugBackendKey || '-'}`)
    .line(`Waveform trace latest: ${findLastTraceEntry(input.keyAnalysisTrace, ['waveform-start', 'waveform-pending', 'waveform-settle', 'waveform-skip', 'waveform-seed', 'waveform-retry'])?.detail || '-'}`);

  builder.section('performance')
    .line(formatUiPerformanceLine(input.panelInput.uiPerformance))
    .line(formatWaveformAnimationLine(input.panelInput.uiPerformance))
    .lines(formatResourceDiagnosticsLines(input.resourceDiagnostics));

  builder.section('analysis')
    .line(`Chrome offscreen: ${input.panelInput.analysis?.chromeOffscreenDebug || '-'}`);

  builder.section('metadata')
    .line(`Metadata debug (bootstrap): release=${input.nowPlaying.releaseUrl || '-'}, stream=${input.nowPlaying.streamUrl || '-'}`)
    .line(`Metadata debug (bootstrap): streamTrackId=${streamTrackId}`)
    .line(`Metadata debug (bootstrap): identity=${identity}`)
    .line(`Metadata debug (bootstrap sources): ${formatDiscoverRawMetadataSourcesLine({
      title: input.nowPlaying.sources.title,
      artist: input.nowPlaying.sources.artist,
      album: input.nowPlaying.sources.album,
      release: input.nowPlaying.sources.release,
      stream: input.nowPlaying.sources.stream,
      identity: input.nowPlaying.sources.identity
    })}`)
    .line(`Metadata debug (strict): ${input.discoverStrictMatchDebug || '-'}`)
    .line(`Metadata debug (resolved): title:${input.panelInput.metadata.sources.title}, artist:${input.panelInput.metadata.sources.artist}, album:${input.panelInput.metadata.sources.album}, confidence:${input.panelInput.metadata.confidence}`)
    .line(`Metadata debug (resolved resolver): track=${resolverDebug.trackId}, source=${resolverDebug.sourceLabel}, identity=${resolverDebug.identityLabel}, match=${resolverDebug.matchReason}, playlist=${resolverDebug.playlistReason}`);

  builder.section('likes')
    .line(`LIKES phase/context: ${input.likesDebug.phase} / ${input.likesDebug.context}`)
    .line(`LIKES fan: slug=${input.likesDebug.fanSlug || '-'}, id=${input.likesDebug.fanId || '-'}`)
    .line(`LIKES sync: status=${input.likesDebug.syncStatus}, reason=${input.likesDebug.syncReason || '-'}, last=${formatIsoTime(input.likesDebug.lastSyncTs)}`)
    .line(`LIKES sync detail: run=${input.likesDebug.syncRunSeq}, inFlightSince=${formatIsoTime(input.likesDebug.syncInFlightSince)}`)
    .line(formatLikesAutoRefreshLine(input.likesDebug))
    .line(`LIKES deep: ${formatDeepSyncStatus(input.likesDebug)}`)
    .line(`LIKES bought cache: status=${input.likesDebug.boughtCacheStatus || '-'}, updated=${formatIsoTime(input.likesDebug.boughtCacheUpdatedAt)}, read=${formatIsoTime(input.likesDebug.boughtCacheLastReadAt)}, write=${formatIsoTime(input.likesDebug.boughtCacheLastWriteAt)}`)
    .line(`LIKES bought cache counts: cAId=${input.likesDebug.boughtCacheCollectionAlbumIds || 0}, cTId=${input.likesDebug.boughtCacheCollectionTrackIds || 0}, cAUrl=${input.likesDebug.boughtCacheCollectionAlbumUrls || 0}, cTUrl=${input.likesDebug.boughtCacheCollectionTrackUrls || 0}`)
    .line(`LIKES endpoints: wishlist=${input.likesDebug.endpointStatus.wishlist}, collection=${input.likesDebug.endpointStatus.collection}`)
    .line(`LIKES attempts: wishlist=${input.likesDebug.endpointAttempts.wishlist}, collection=${input.likesDebug.endpointAttempts.collection}, nextRetry=${formatIsoTime(input.likesDebug.nextRetryTs)}`)
    .line(`LIKES counts: wAId=${input.likesDebug.inventoryCounts.wishlistAlbumIds}, wTId=${input.likesDebug.inventoryCounts.wishlistTrackIds}, wAUrl=${input.likesDebug.inventoryCounts.wishlistAlbumUrls}, wTUrl=${input.likesDebug.inventoryCounts.wishlistTrackUrls}, cAId=${input.likesDebug.inventoryCounts.collectionAlbumIds}, cTId=${input.likesDebug.inventoryCounts.collectionTrackIds}, cAUrl=${input.likesDebug.inventoryCounts.collectionAlbumUrls}, cTUrl=${input.likesDebug.inventoryCounts.collectionTrackUrls}`)
    .line(`LIKES truth: album=${input.likesDebug.truthAlbumState}, track[${input.likesDebug.activeTrackIndex}]=${input.likesDebug.truthActiveTrackState}`)
    .line(`LIKES display: album=${input.likesDebug.displayAlbumState}, track[${input.likesDebug.activeTrackIndex}]=${input.likesDebug.displayActiveTrackState}, projection=${input.likesDebug.trackProjection || '-'}`)
    .trace('LIKES state changes:', likeStateChangeLines)
    .line(`LIKES ui: loading=${input.panelInput.likeState.loading ? '1' : '0'}, disabled=${input.panelInput.likeState.disabled ? '1' : '0'}, notice=${input.panelInput.likeState.notice || '-'}`)
    .line(`LIKES identity: trust=${input.likesDebug.identityTrust || '-'}, reason=${input.likesDebug.identityReason || '-'}`)
    .line(`LIKES action: ${input.likesDebug.lastAction || '-'} @ ${formatIsoTime(input.likesDebug.lastActionTs)} error=${input.likesDebug.lastError || '-'}`)
    .lines(formatLikeMutationLines(input.likesDebug))
    .trace('LIKES inventory mismatches:', inventoryMismatchLines)
    .trace('LIKES API phase:', likeApiPhaseLines);

  builder.section('playlist')
    .line(`Playlist source: ${input.playlistSource}`)
    .line(`Playlist tracks: ${input.panelInput.playlist.tracks.length}, current=${input.panelInput.playlist.currentIndex}, loading=${input.panelInput.playlist.loading}, run=${input.runId}`);

  builder.section('metadata')
    .line(`API policy: ${input.apiPolicyLine}`)
    .line(`API shadow: ${input.apiShadowPolicyLine}`);

  builder.section('resolver')
    .line(`Resolver snapshot: src=${input.resolverSnapshot?.currentSrc || '-'}, track=${resolverDebug.trackId}, match=${resolverDebug.matchReason}`)
    .line(`Resolver snapshot: source=${resolverDebug.sourceLabel}, identity=${resolverDebug.identityLabel}, allowApi=${input.resolverSnapshot?.source.allowApiFetch ? '1' : '0'}, preferApi=${input.resolverSnapshot?.source.preferApi ? '1' : '0'}, stale=${input.resolverSnapshot?.source.staleTrack ? '1' : '0'}`)
    .line(`Resolver snapshot: playlistReason=${resolverDebug.playlistReason}, metadataAligned=${resolverDebug.metadataAlignedLabel}, strictMeta=${resolverDebug.strictMetaLabel}, strictPlaylist=${resolverDebug.strictPlaylistLabel}, playability=${input.resolverSnapshot?.flags.playabilityGated ? 'gated' : 'ok'}`);

  builder.section('playlist')
    .line(`Playlist debug: hints=${input.hintDebug}`);

  builder.section('metadata')
    .lines(metadataDebugLines);

  builder.section('handover')
    .lines(bridgeDebugLines);

  builder.section('runtime')
    .line(`Runtime cache: prepared=${runtimeAudioEngineDebug?.preparedCount ?? 0}/${runtimeAudioEngineDebug?.maxPrepared ?? 0} active=${runtimeAudioEngineDebug?.activePrepareCount ?? 0} parallel=${runtimeAudioEngineDebug?.maxConcurrentPredecode ?? '-'} window=${runtimeAudioEngineDebug?.predecodeWindowTracks ?? '-'} policy=${runtimeAudioEngineDebug?.capacityReason || '-'} memory=${formatDeviceMemoryGb(runtimeAudioEngineDebug?.deviceMemoryGb)} pcm=${formatBytes(runtimeAudioEngineDebug?.preparedDecodedBytes ?? 0)}/${formatBytes(runtimeAudioEngineDebug?.maxDecodedBytes ?? 0)} encoded=${formatBytes(runtimeAudioEngineDebug?.preparedBytes ?? 0)} encodedCache=${runtimeAudioEngineDebug?.encodedCacheCount ?? 0}:${formatBytes(runtimeAudioEngineDebug?.encodedCacheBytes ?? 0)}/${formatBytes(runtimeAudioEngineDebug?.maxEncodedBytes ?? 0)} encHits=${runtimeAudioEngineDebug?.encodedCacheHits ?? 0} duration=${Number.isFinite(runtimeAudioEngineDebug?.preparedDurationSec) ? Number(runtimeAudioEngineDebug?.preparedDurationSec || 0).toFixed(1) : '0.0'}s`)
    .line(formatRuntimePlaylistPreparationLine(
      input.panelInput.playlist.tracks.map((track) => String(track.streamUrl || '').trim()),
      runtimeAudioEngineDebug,
      input.panelInput.playlist.currentIndex,
      input.panelInput.playlist.tracks.length
    ))
    .line(`Runtime cache health: attempts=${runtimeAudioEngineDebug?.prepareAttemptCount ?? 0} evictions=${runtimeAudioEngineDebug?.evictionCount ?? 0} failures=${runtimeAudioEngineDebug?.prepareFailureCount ?? 0} lastFailure=${runtimeAudioEngineDebug?.lastPrepareFailure || '-'} staleFetch=${runtimeAudioEngineDebug?.staleFetchCount ?? 0} staleDecode=${runtimeAudioEngineDebug?.staleDecodeCount ?? 0} stalePrepare=${runtimeAudioEngineDebug?.stalePrepareCount ?? 0}`)
    .line(`Runtime cache current: lastPrepared=${runtimeAudioEngineDebug?.lastPreparedUrl || '-'} activeUrls=${runtimeAudioEngineDebug?.activePrepareUrls?.join(' | ') || '-'}`)
    .line(`Runtime cache entries: ${runtimeEngineEntriesLine}`);

  builder.section('resolver')
    .trace('Resolver process:', resolverProcessLines);

  builder.section('transport')
    .trace('Jump diagnosis:', jumpProcessLines);

  builder.section('playlist')
    .trace('Preload state:', preloadStateLines)
    .trace('Preload process:', preloadProcessLines);

  builder.section('transport')
    .line(`Transport debug: seq=${input.transportDebug.actionSeq}, action=${input.transportDebug.lastAction} (${formatSince(input.transportDebug.lastActionAt)})`)
    .line(`Transport debug: actionDetail=${input.transportDebug.lastActionDetail}`)
    .line(`Transport debug: result=${input.transportDebug.lastResult} (${formatSince(input.transportDebug.lastResultAt)})`)
    .line(`Transport debug: resultDetail=${input.transportDebug.lastResultDetail}`)
    .trace('Transport trace:', transportTraceLines.length ? transportTraceLines : ['(none)']);

  return builder.build();
}

export interface DebugPanelLike {
  push(snapshot: { title: string; sections: DebugSection[] }): void;
  isVisible(): boolean;
  isActive?(): boolean;
}

export function createThrottledDebugPush(
  panel: DebugPanelLike,
  minIntervalMs = 350
): (title: string, sectionsFactory: DebugSectionsFactory) => void {
  let lastPushAt = 0;
  return (title: string, sectionsFactory: DebugSectionsFactory): void => {
    if (typeof panel.isActive === 'function' && !panel.isActive()) {
      return;
    }
    if (!panel.isVisible()) {
      return;
    }
    const now = Date.now();
    if (now - lastPushAt < minIntervalMs) {
      return;
    }
    lastPushAt = now;
    panel.push({ title, sections: sectionsFactory() });
  };
}
