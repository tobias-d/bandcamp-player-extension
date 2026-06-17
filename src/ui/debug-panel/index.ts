import type { DebugEvent } from '@/shared/types';
import { dispatchDebugClearCachesRequest } from '@/shared/debug-cache-reset';
import { copyToClipboard, flashButtonLabel } from '@/ui/debug-panel/clipboard';
import {
  formatAnonymizedDebugText,
  formatAudioIncidentSnapshotText,
  formatEventLine,
  type DebugPanelSectionEntry
} from '@/ui/debug-panel/format';
import { createDebugPanelElements } from '@/ui/debug-panel/view';
import { injectPanelStyles } from '@/ui/styles';
import { dom, setText } from '@/utils/dom';
import { clearDebugEvents, getRecentDebugEvents } from '@/utils/debug';
import { toDebugJSON, type DebugSection } from '@/shared/debug-trace';

export interface DebugPanelSnapshot {
  title: string;
  sections: DebugSection[];
}

export interface DebugPanelController {
  destroy(): void;
  open(): void;
  push(snapshot: DebugPanelSnapshot): void;
  isVisible(): boolean;
  isActive(): boolean;
}

interface DebugTraceArea {
  id: string;
  title: string;
  entries: DebugPanelSectionEntry[];
}

type DebugStatusState = 'loading' | 'preparing' | 'limited' | 'idle' | 'disabled' | 'warning' | 'error' | 'complete';

interface DebugStatusItem {
  label: string;
  state: DebugStatusState;
  detail: string;
  visibleDetail?: string;
}

interface DebugStatusContext {
  staleMetadataSignature: string;
}

const MAX_EVENT_ROWS = 200;

function createEmptyState(message: string): HTMLElement {
  return dom('div', { class: 'bc-debug-empty' }, [message]);
}

function createSectionEntry(entry: DebugPanelSectionEntry): HTMLElement {
  if (entry.kind === 'heading') {
    return dom('div', { class: 'bc-debug-section-subheading' }, [entry.label]);
  }
  if (entry.kind === 'text') {
    return dom('div', { class: 'bc-debug-section-text' }, [entry.value]);
  }

  const row = dom('div', { class: 'bc-debug-section-row' });
  const label = dom('div', { class: 'bc-debug-section-row-label' }, [entry.label]);
  const value = dom('div', { class: 'bc-debug-section-row-value' }, [entry.value]);
  row.appendChild(label);
  row.appendChild(value);
  return row;
}

function entryToText(entry: DebugPanelSectionEntry): string {
  if (entry.kind === 'heading') {
    return `${entry.label}:`;
  }
  if (entry.kind === 'entry') {
    return `${entry.label}: ${entry.value}`;
  }
  return entry.value;
}

function areaToText(area: DebugTraceArea): string {
  return [area.title, ...area.entries.map((entry) => entryToText(entry))].join('\n').trim();
}

function createTextEntry(value: string): DebugPanelSectionEntry {
  return {
    kind: 'text',
    label: '',
    value,
    raw: value,
    searchable: value.toLowerCase()
  };
}

function summarizeEntries(entries: DebugPanelSectionEntry[]): string {
  const summary = entries
    .filter((entry) => entry.kind !== 'heading')
    .slice(0, 2)
    .map((entry) => entryToText(entry))
    .join(' | ');
  return summary || `${entries.length} rows`;
}

function findEntryValue(areas: DebugTraceArea[], label: string): string {
  for (const area of areas) {
    for (const entry of area.entries) {
      if (entry.kind === 'entry' && entry.label === label) {
        return entry.value;
      }
    }
  }
  return '';
}

function readTokenValue(value: string, token: string): string {
  const match = value.match(new RegExp(`(?:^|\\s)${token}=([^\\s]+)`));
  return match?.[1] && match[1] !== '-' ? match[1] : '';
}

function readDelimitedTokenValue(value: string, token: string): string {
  const match = value.match(new RegExp(`(?:^|[\\s,])${token}=([^,\\s]+)`));
  const tokenValue = match?.[1] || '';
  return tokenValue && tokenValue !== '-' ? tokenValue : '';
}

function hasTokenFlag(value: string, token: string): boolean {
  return new RegExp(`(?:^|\\s)${token}=1(?:\\s|$)`).test(value);
}

function resolveTraceTrackKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === '-' || normalized === '(none)') {
    return '';
  }

  const explicitTrack = normalized.match(/\btrack=(\d+)/i)?.[1];
  if (explicitTrack) {
    return `track:${explicitTrack}`;
  }

  const streamTrack = normalized.match(/[?&]track_id=(\d+)/i)?.[1];
  if (streamTrack) {
    return `track:${streamTrack}`;
  }

  return `source:${normalized}`;
}

function resolveCurrentTrackKey(areas: DebugTraceArea[]): string {
  const audioUrlKey = resolveTraceTrackKey(findEntryValue(areas, 'Audio URL'));
  if (audioUrlKey) {
    return audioUrlKey;
  }

  const currentLineKey = resolveTraceTrackKey(readTokenValue(findEntryValue(areas, 'current'), 'key'));
  return currentLineKey;
}

function resolveCurrentTrackKeys(areas: DebugTraceArea[]): string[] {
  return Array.from(new Set([
    resolveTraceTrackKey(findEntryValue(areas, 'Audio URL')),
    resolveTraceTrackKey(readTokenValue(findEntryValue(areas, 'current'), 'key'))
  ].filter(Boolean)));
}

function resolveMetadataSignature(areas: DebugTraceArea[]): string {
  return [
    findEntryValue(areas, 'Metadata'),
    findEntryValue(areas, 'Metadata confidence'),
    findEntryValue(areas, 'Metadata sources')
  ].join(' | ');
}

function tokenMatchesTrackKey(value: string, token: string, currentTrackKey: string): boolean {
  const tokenValue = readTokenValue(value, token);
  return Boolean(tokenValue && resolveTraceTrackKey(tokenValue) === currentTrackKey);
}

function tokenMatchesAnyTrackKey(value: string, token: string, currentTrackKeys: string[]): boolean {
  return currentTrackKeys.some((key) => tokenMatchesTrackKey(value, token, key));
}

function hasFailureText(value: string): boolean {
  return /\b(error|failed|failure)\b/i.test(value);
}

function readRuntimePlaylistPrepCounts(value: string): {
  prepared: number;
  total: number;
  active: number;
  capacity: number;
} {
  const match = value.match(/\bprepared=(\d+)\/\d+/);
  const totalMatch = value.match(/\bprepared=\d+\/(\d+)/);
  const activeMatch = value.match(/\bactive=(\d+)/);
  const capacityMatch = value.match(/\bcapacity=(\d+)/);
  return {
    prepared: match ? Number(match[1]) : 0,
    total: totalMatch ? Number(totalMatch[1]) : 0,
    active: activeMatch ? Number(activeMatch[1]) : 0,
    capacity: capacityMatch ? Number(capacityMatch[1]) : 0
  };
}

function readPlaylistAnalysisProgress(value: string): {
  prepared: number;
  total: number;
  active: number;
  queue: number;
  failed: number;
  missing: number;
  state: string;
  enabled: boolean;
} {
  const preparedMatch = value.match(/\bprepared=(\d+)\/(\d+)/);
  const activeMatch = value.match(/\bactive=(\d+)/);
  const queueMatch = value.match(/\bqueue=(\d+)/);
  const failedMatch = value.match(/\bfailed=(\d+)/);
  const missingMatch = value.match(/\bmissing=(\d+)/);
  const stateMatch = value.match(/\bstate=([^\s]+)/);
  const enabledMatch = value.match(/\benabled=([01])/);
  return {
    prepared: preparedMatch ? Number(preparedMatch[1]) : 0,
    total: preparedMatch ? Number(preparedMatch[2]) : 0,
    active: activeMatch ? Number(activeMatch[1]) : 0,
    queue: queueMatch ? Number(queueMatch[1]) : 0,
    failed: failedMatch ? Number(failedMatch[1]) : 0,
    missing: missingMatch ? Number(missingMatch[1]) : 0,
    state: stateMatch?.[1] || '',
    enabled: enabledMatch ? enabledMatch[1] === '1' : true
  };
}

function formatPlaylistAnalysisDetail(progress: ReturnType<typeof readPlaylistAnalysisProgress>, fallback: string): string {
  if (progress.total <= 0) {
    return fallback || 'waiting';
  }
  const suffix = progress.state === 'disabled'
    ? ', disabled'
    : progress.failed > 0
      ? `, failed ${progress.failed}`
      : progress.missing > 0
        ? `, missing ${progress.missing}`
        : '';
  const activity = progress.active > 0 || progress.queue > 0
    ? `, active ${progress.active}, queue ${progress.queue}`
    : '';
  return `${progress.prepared}/${progress.total} tracks${suffix}${activity}`;
}

function resolvePlaylistAnalysisStatus(
  progress: ReturnType<typeof readPlaylistAnalysisProgress>,
  fallback: DebugStatusState
): DebugStatusState {
  if (progress.state === 'disabled' || !progress.enabled) {
    return 'disabled';
  }
  if (progress.failed > 0 || progress.state === 'error') {
    return 'error';
  }
  if (progress.total > 0 && progress.prepared >= progress.total) {
    return 'complete';
  }
  if (progress.total > 0 && (progress.active > 0 || progress.queue > 0 || progress.state === 'preparing')) {
    return 'preparing';
  }
  if (progress.total > 0) {
    return 'idle';
  }
  return fallback;
}

function endpointStatusIsComplete(status: string): boolean {
  return /^ok:pages=\d+:complete$/.test(String(status || ''));
}

function endpointStatusIsUnavailable(status: string): boolean {
  const normalized = String(status || '').trim();
  return !normalized || normalized === 'n/a' || normalized === '-';
}

function endpointStatusIsError(status: string): boolean {
  return /\b(error|failed|failure|timeout|denied|forbidden|unauthorized)\b/i.test(String(status || ''));
}

function resolveWishlistCollectionSyncItem(areas: DebugTraceArea[]): DebugStatusItem {
  const syncLine = findEntryValue(areas, 'LIKES sync');
  const syncDetailLine = findEntryValue(areas, 'LIKES sync detail');
  const endpointLine = findEntryValue(areas, 'LIKES endpoints');
  const attemptsLine = findEntryValue(areas, 'LIKES attempts');
  const uiLine = findEntryValue(areas, 'LIKES ui');
  const fanLine = findEntryValue(areas, 'LIKES fan');
  const deepLine = findEntryValue(areas, 'LIKES deep');
  const boughtCacheLine = findEntryValue(areas, 'LIKES bought cache');

  const syncStatus = readDelimitedTokenValue(syncLine, 'status') || 'idle';
  const syncReason = readDelimitedTokenValue(syncLine, 'reason') || '-';
  const wishlistStatus = readDelimitedTokenValue(endpointLine, 'wishlist');
  const collectionStatus = readDelimitedTokenValue(endpointLine, 'collection');
  const wishlistAttempts = Number(readDelimitedTokenValue(attemptsLine, 'wishlist') || 0);
  const collectionAttempts = Number(readDelimitedTokenValue(attemptsLine, 'collection') || 0);
  const uiLoading = readDelimitedTokenValue(uiLine, 'loading') === '1';
  const fanId = readDelimitedTokenValue(fanLine, 'id');
  const boughtCacheStatus = readDelimitedTokenValue(boughtCacheLine, 'status') || '-';

  const wishlistComplete = endpointStatusIsComplete(wishlistStatus);
  const collectionComplete = endpointStatusIsComplete(collectionStatus);
  const anyEndpointStarted =
    !endpointStatusIsUnavailable(wishlistStatus) ||
    !endpointStatusIsUnavailable(collectionStatus) ||
    wishlistAttempts > 0 ||
    collectionAttempts > 0;
  const endpointProblem =
    endpointStatusIsError(wishlistStatus) ||
    endpointStatusIsError(collectionStatus);

  const detail = [
    `sync=${syncStatus}`,
    `reason=${syncReason}`,
    `wishlist=${wishlistStatus || '-'}`,
    `collection=${collectionStatus || '-'}`,
    boughtCacheStatus !== '-' ? `boughtCache=${boughtCacheStatus}` : ''
  ].filter(Boolean).join(', ');

  if (syncStatus === 'in-flight' || uiLoading || deepLine === 'in-flight') {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'loading', detail);
  }
  if (endpointProblem) {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'error', detail);
  }
  if (syncStatus === 'error') {
    return createStatusItem(
      'WISHLIST AND COLLECTION SYNC',
      syncReason === 'fan-id-unavailable' ? 'warning' : 'error',
      detail
    );
  }
  if (syncStatus === 'success' && wishlistComplete && collectionComplete) {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'complete', detail);
  }
  if (syncStatus === 'success') {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'warning', detail);
  }
  if (!fanId && anyEndpointStarted) {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'warning', detail);
  }
  if (syncDetailLine || syncLine || endpointLine) {
    return createStatusItem('WISHLIST AND COLLECTION SYNC', 'loading', detail);
  }
  return createStatusItem('WISHLIST AND COLLECTION SYNC', 'idle', 'waiting');
}

function isNumericValue(value: string): boolean {
  return Number.isFinite(Number(value.trim()));
}

function createStatusItem(
  label: string,
  state: DebugStatusState,
  detail: string,
  visibleDetail?: string
): DebugStatusItem {
  return {
    label,
    state,
    detail: detail || '-',
    visibleDetail
  };
}

function isCrucialErrorLine(value: string): boolean {
  const normalized = String(value || '').trim();
  if (/\[[^\]]+\]\s+ERROR\b/i.test(normalized)) {
    return true;
  }
  if (/\[[^\]]+\]\s+WARN\b/i.test(normalized)) {
    return /\b(error|failed|failure|timeout|denied|forbidden|unauthorized|exception|abort)\b/i.test(normalized);
  }
  return false;
}

function formatCrucialErrorLine(value: string): string {
  return String(value || '')
    .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function resolveCrucialErrorKind(value: string): string {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('[audio]') || normalized.includes('runtime') || normalized.includes('signalsmith')) {
    return 'Runtime';
  }
  if (normalized.includes('[metadata]') || normalized.includes('metadata') || normalized.includes('tralbum')) {
    return 'Metadata';
  }
  if (normalized.includes('[likes]') || normalized.includes('wishlist') || normalized.includes('collection')) {
    return 'Likes';
  }
  if (normalized.includes('analysis (bpm)') || normalized.includes('tempo') || normalized.includes('bpm')) {
    return 'BPM';
  }
  if (normalized.includes('analysis (key)') || normalized.includes('key')) {
    return 'Key';
  }
  if (
    normalized.includes('fetch') ||
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return 'Network';
  }
  if (normalized.includes('playback') || normalized.includes('audio url') || normalized.includes('source')) {
    return 'Playback';
  }
  return 'General';
}

function resolveCrucialErrorsItem(areas: DebugTraceArea[], statusItems: DebugStatusItem[]): DebugStatusItem {
  const errors: Array<{ kind: string; detail: string }> = [];
  const seen = new Set<string>();
  const addError = (value: string): void => {
    const formatted = formatCrucialErrorLine(value);
    if (!formatted || seen.has(formatted)) {
      return;
    }
    seen.add(formatted);
    errors.push({
      kind: resolveCrucialErrorKind(value),
      detail: formatted
    });
  };

  statusItems.forEach((item) => {
    if (item.state === 'error') {
      addError(`${item.label}: ${item.detail}`);
    }
  });

  for (const area of areas) {
    for (const entry of area.entries) {
      const value = entry.raw || entry.value;
      if (isCrucialErrorLine(value)) {
        addError(value);
      }
    }
  }

  const detail = errors.length
    ? errors.slice(0, 3).map((error) => `${error.kind}: ${error.detail}`).join(' | ')
    : 'No crucial errors found';
  const kinds = Array.from(new Set(errors.map((error) => error.kind)));
  const visibleDetail = !errors.length
    ? 'None'
    : kinds.length === 1
      ? `${kinds[0]}: ${errors.length}`
      : `${kinds[0]} +${kinds.length - 1}`;
  return createStatusItem(
    'CRUCIAL ERRORS',
    errors.length ? 'error' : 'complete',
    detail,
    visibleDetail
  );
}

function resolveStatusItems(areas: DebugTraceArea[], context: DebugStatusContext): DebugStatusItem[] {
  const metadata = findEntryValue(areas, 'Metadata');
  const metadataConfidence = findEntryValue(areas, 'Metadata confidence');
  const metadataSources = findEntryValue(areas, 'Metadata sources');
  const metadataText = `${metadata} ${metadataConfidence} ${metadataSources}`;
  const metadataSignature = [metadata, metadataConfidence, metadataSources].join(' | ');

  const runtimePrepare = findEntryValue(areas, 'Runtime prepare');
  const runtimePrepareKeys = findEntryValue(areas, 'Runtime prepare keys');
  const runtimeCache = findEntryValue(areas, 'Runtime cache');
  const runtimePlaylistPrep = findEntryValue(areas, 'Runtime playlist prep');
  const runtimeText = `${runtimePrepare} ${runtimePrepareKeys} ${runtimeCache} ${runtimePlaylistPrep}`;

  const analysisBpm = findEntryValue(areas, 'Analysis BPM');
  const analysisStatus = findEntryValue(areas, 'Analysis status');
  const analysisSourceDetail = findEntryValue(areas, 'Analysis source detail');
  const analysisText = `${analysisBpm} ${analysisStatus} ${analysisSourceDetail}`;

  const keyLifecycle = findEntryValue(areas, 'Key lifecycle');
  const keyResult = findEntryValue(areas, 'Key result');
  const keyDetailText = findEntryValue(areas, 'Key detail');
  const keyText = `${keyLifecycle} ${keyResult} ${keyDetailText}`;
  const currentTrackKeys = resolveCurrentTrackKeys(areas);
  const currentLine = findEntryValue(areas, 'current');
  const currentBpmFailed = hasTokenFlag(currentLine, 'failed');
  const currentHasBpm = hasTokenFlag(currentLine, 'hasBpm');
  const currentHasKey = hasTokenFlag(currentLine, 'hasKey');
  const bpmPlaylistProgress = readPlaylistAnalysisProgress(findEntryValue(areas, 'Preload BPM analysis'));
  const keyPlaylistProgress = readPlaylistAnalysisProgress(findEntryValue(areas, 'Preload key analysis'));
  const runtimePlaylistPrepCounts = readRuntimePlaylistPrepCounts(runtimePlaylistPrep);
  const runtimePlaylistPrepared =
    runtimePlaylistPrepCounts.total > 0 &&
    runtimePlaylistPrepCounts.prepared >= runtimePlaylistPrepCounts.total;
  const runtimePlaylistIdle =
    runtimePlaylistPrepCounts.total > 0 &&
    runtimePlaylistPrepCounts.prepared < runtimePlaylistPrepCounts.total &&
    runtimePlaylistPrepCounts.active <= 0;
  const runtimePlaylistPreparing =
    runtimePlaylistPrepCounts.total > 0 &&
    runtimePlaylistPrepCounts.prepared < runtimePlaylistPrepCounts.total &&
    runtimePlaylistPrepCounts.active > 0;
  const runtimePlaylistCapacityFull =
    runtimePlaylistIdle &&
    runtimePlaylistPrepCounts.capacity > 0 &&
    runtimePlaylistPrepCounts.prepared >= runtimePlaylistPrepCounts.capacity;
  const runtimePlaylistDetail = runtimePlaylistPrepCounts.total > 0
    ? `${runtimePlaylistPrepCounts.prepared}/${runtimePlaylistPrepCounts.total} tracks` +
      (runtimePlaylistCapacityFull
        ? `, capacity ${runtimePlaylistPrepCounts.capacity}`
        : (runtimePlaylistIdle ? ', idle' : (runtimePlaylistPreparing ? ', preparing' : '')))
    : (runtimePrepare || 'waiting');
  const runtimePlaylistVisibleDetail = runtimePlaylistPrepCounts.total > 0
    ? `${runtimePlaylistPrepCounts.prepared}/${runtimePlaylistPrepCounts.total} tracks`
    : '';
  const analysisCacheMatchesCurrent =
    Boolean(currentTrackKeys.length) &&
    tokenMatchesAnyTrackKey(findEntryValue(areas, 'Analysis cache snapshot'), 'key', currentTrackKeys);
  const currentBpmStatus: DebugStatusState = hasFailureText(analysisText) || currentBpmFailed
    ? 'error'
    : (currentHasBpm || (analysisCacheMatchesCurrent && isNumericValue(analysisBpm)))
      ? 'complete'
      : 'loading';
  const currentKeyStatus: DebugStatusState = hasFailureText(keyText)
    ? 'error'
    : (currentHasKey || /(disabled|empty)/i.test(keyLifecycle))
      ? 'complete'
      : 'loading';
  const bpmStatus = resolvePlaylistAnalysisStatus(bpmPlaylistProgress, currentBpmStatus);
  const keyStatus = resolvePlaylistAnalysisStatus(keyPlaylistProgress, currentKeyStatus);
  const bpmDetail = formatPlaylistAnalysisDetail(bpmPlaylistProgress, analysisStatus || analysisBpm || 'waiting');
  const keyDetail = formatPlaylistAnalysisDetail(keyPlaylistProgress, keyLifecycle || keyResult || 'waiting');
  // `title=default` is the final state on album/track pages: the panel sources the track
  // title from the playlist, not metadata.title, so artist+album can resolve at high
  // confidence while metadata.title legitimately stays default. Treat a high-confidence
  // resolve as ready regardless of title source; an unresolved title only keeps the chip
  // in "loading" while confidence is still below high (the genuine early-load window).
  const metadataLooksReady =
    Boolean(
      metadata &&
      metadata !== '--- | --- | ---' &&
      (/^high$/i.test(metadataConfidence) || !metadataSources.includes('title=default'))
    ) &&
    metadataSignature !== context.staleMetadataSignature;

  const statusItems = [
    createStatusItem(
      'METADATA',
      hasFailureText(metadataText)
        ? 'error'
        : metadataLooksReady
          ? 'complete'
          : 'loading',
      metadataConfidence || metadata || 'waiting'
    ),
    createStatusItem(
      'RUNTIME PREPARATION',
      hasFailureText(runtimeText)
        ? 'error'
        : runtimePlaylistPrepared
          ? 'complete'
          : runtimePlaylistCapacityFull
            ? 'limited'
            : runtimePlaylistIdle
              ? 'idle'
              : runtimePlaylistPreparing
                ? 'preparing'
                : 'loading',
      runtimePlaylistDetail,
      runtimePlaylistVisibleDetail
    ),
    resolveWishlistCollectionSyncItem(areas),
    createStatusItem(
      'ANALYSIS (BPM)',
      bpmStatus,
      bpmDetail
    ),
    createStatusItem(
      'ANALYSIS (KEY)',
      keyStatus,
      keyDetail
    )
  ];
  return [
    resolveCrucialErrorsItem(areas, statusItems),
    ...statusItems
  ];
}

function createStatusBox(item: DebugStatusItem): HTMLElement {
  const stateLabel = item.state.charAt(0).toUpperCase() + item.state.slice(1);
  const box = dom('div', {
    class: `bc-debug-status-box bc-debug-status-box-${item.state}`,
    title: `${item.label}: ${stateLabel} (${item.detail})`
  });
  box.appendChild(dom('span', { class: 'bc-debug-status-box-label' }, [item.label]));
  box.appendChild(dom('span', { class: 'bc-debug-status-box-state' }, [stateLabel]));
  if (item.visibleDetail) {
    box.appendChild(dom('span', { class: 'bc-debug-status-box-detail' }, [item.visibleDetail]));
  }
  return box;
}

function buildTraceAreas(snapshot: DebugPanelSnapshot, events: DebugEvent[]): DebugTraceArea[] {
  const eventLines = events.map((event) => formatEventLine(event));
  return [
    ...snapshot.sections,
    {
      id: 'recent-messages',
      title: 'Recent Messages',
      entries: eventLines.length ? eventLines.map((line) => createTextEntry(line)) : [createTextEntry('(none)')]
    }
  ];
}

function filterTraceAreas(areas: DebugTraceArea[], query: string): DebugTraceArea[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return areas;
  }

  return areas
    .map((area) => {
      const areaMatches =
        area.title.toLowerCase().includes(normalizedQuery) ||
        summarizeEntries(area.entries).toLowerCase().includes(normalizedQuery);
      if (areaMatches) {
        return area;
      }

      const entries = area.entries.filter((entry) =>
        entry.searchable.includes(normalizedQuery) ||
        entry.raw.toLowerCase().includes(normalizedQuery)
      );
      return entries.length
        ? {
            ...area,
            entries
          }
        : null;
    })
    .filter((area): area is DebugTraceArea => Boolean(area));
}

function createCopyButton(
  label: string,
  title: string,
  resolveText: () => string,
  onCopied: () => void,
  className = ''
): HTMLButtonElement {
  const button = dom('button', {
    class: `bc-debug-btn bc-debug-copy-btn ${className}`.trim(),
    type: 'button',
    title
  }, [label]);
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const copied = await copyToClipboard(resolveText().trim() || '(empty)');
    flashButtonLabel(button, copied ? 'Copied' : 'Copy failed');
    if (copied) {
      onCopied();
    }
  });
  return button;
}

function createAreaDetails(
  area: DebugTraceArea,
  openAreaIds: Set<string>,
  areaScrollTops: Map<string, number>
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'bc-debug-area';
  details.dataset.areaId = area.id;
  details.open = openAreaIds.has(area.id);

  const summary = dom('summary', { class: 'bc-debug-area-summary' });
  const titleGroup = dom('span', { class: 'bc-debug-area-title-group' });
  const title = dom('span', { class: 'bc-debug-area-title' }, [area.title]);
  const meta = dom('span', { class: 'bc-debug-area-meta' }, [`${area.entries.length} rows`]);
  const preview = dom('span', { class: 'bc-debug-area-preview' }, [summarizeEntries(area.entries)]);
  titleGroup.appendChild(title);
  titleGroup.appendChild(meta);
  summary.appendChild(titleGroup);
  summary.appendChild(preview);

  const body = dom('div', { class: 'bc-debug-area-body' });
  body.addEventListener('scroll', () => {
    areaScrollTops.set(area.id, body.scrollTop);
  });
  for (const entry of area.entries) {
    body.appendChild(createSectionEntry(entry));
  }
  body.scrollTop = areaScrollTops.get(area.id) ?? 0;

  details.appendChild(summary);
  details.appendChild(body);
  details.addEventListener('toggle', () => {
    if (details.open) {
      openAreaIds.add(area.id);
    } else {
      openAreaIds.delete(area.id);
    }
  });
  return details;
}

export interface DebugPanelOptions {
  // Fired on every show/hide transition. Used to gate panel-open-only work (e.g. resource
  // diagnostics sampling) so nothing runs while the panel is closed.
  onVisibilityChange?: (visible: boolean) => void;
}

export function createDebugPanel(
  getSnapshot: () => DebugPanelSnapshot,
  options?: DebugPanelOptions
): DebugPanelController {
  injectPanelStyles();

  const {
    root,
    drag,
    statusBadge,
    pauseButton,
    clearCachesButton,
    clearEventsButton,
    closeButton,
    statusList,
    searchInput,
    copyButtonList,
    areaList,
    stats,
    copyNotice
  } = createDebugPanelElements();

  document.body.appendChild(root);

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let dragPointerId: number | null = null;

  let paused = false;
  let latestSnapshot: DebugPanelSnapshot = getSnapshot();
  let pendingSnapshot: DebugPanelSnapshot | null = null;
  let frozenEvents: DebugEvent[] = [];
  let renderedTitle = 'Debugger';
  let renderedAreas = buildTraceAreas(latestSnapshot, getRecentDebugEvents(MAX_EVENT_ROWS));
  let currentStatusTrackKey = resolveCurrentTrackKey(renderedAreas);
  let previousMetadataSignature = resolveMetadataSignature(renderedAreas);
  let staleMetadataSignature = '';
  const openAreaIds = new Set<string>();
  const areaScrollTops = new Map<string, number>();
  let pointerInsidePanel = false;
  let copyNoticeTimeoutId = 0;

  const endDrag = (event: PointerEvent): void => {
    if (!dragging || dragPointerId !== event.pointerId) {
      return;
    }
    dragging = false;
    dragPointerId = null;
    try {
      drag.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures caused by browser-specific pointer state.
    }
  };

  drag.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, a, [role="button"]')) {
      return;
    }
    dragging = true;
    dragPointerId = event.pointerId;
    const rect = root.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    drag.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  drag.addEventListener('pointermove', (event) => {
    if (!dragging || dragPointerId !== event.pointerId) {
      return;
    }
    root.style.top = `${event.clientY - offsetY}px`;
    root.style.left = `${event.clientX - offsetX}px`;
    root.style.bottom = 'auto';
    root.style.right = 'auto';
  });

  drag.addEventListener('pointerup', endDrag);
  drag.addEventListener('pointercancel', endDrag);

  const isSelectingInsidePanel = (): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return false;
    }
    return Boolean(
      (selection.anchorNode && root.contains(selection.anchorNode)) ||
        (selection.focusNode && root.contains(selection.focusNode))
    );
  };

  const getSourceEvents = (): DebugEvent[] => paused
    ? frozenEvents
    : getRecentDebugEvents(MAX_EVENT_ROWS);

  const syncStatus = (): void => {
    statusBadge.textContent = paused ? 'PAUSED' : 'LIVE';
    statusBadge.classList.toggle('bc-debug-status-paused', paused);
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.title = paused ? 'Resume live trace updates' : 'Pause live trace updates';
  };

  const showCopyNotice = (): void => {
    copyNotice.classList.add('bc-debug-copy-notice-visible');
    if (copyNoticeTimeoutId) {
      window.clearTimeout(copyNoticeTimeoutId);
    }
    copyNoticeTimeoutId = window.setTimeout(() => {
      copyNotice.classList.remove('bc-debug-copy-notice-visible');
      copyNoticeTimeoutId = 0;
    }, 2600);
  };

  const renderStatusItems = (areas: DebugTraceArea[]): void => {
    const nextStatusTrackKey = resolveCurrentTrackKey(areas);
    if (nextStatusTrackKey && nextStatusTrackKey !== currentStatusTrackKey) {
      staleMetadataSignature = previousMetadataSignature;
      currentStatusTrackKey = nextStatusTrackKey;
    }

    statusList.replaceChildren(
      ...resolveStatusItems(areas, { staleMetadataSignature }).map((item) => createStatusBox(item))
    );
    previousMetadataSignature = resolveMetadataSignature(areas);
  };

  const renderRecord = (snapshot: DebugPanelSnapshot): void => {
    latestSnapshot = snapshot;
    renderedTitle = 'Debugger';
    renderedAreas = buildTraceAreas(snapshot, getSourceEvents());
    const filteredAreas = filterTraceAreas(renderedAreas, searchInput.value);
    renderStatusItems(renderedAreas);

    copyButtonList.replaceChildren(
      createCopyButton('Copy Anonymized Debug', 'Copy a privacy-filtered debugger report', () =>
        formatAnonymizedDebugText(renderedTitle, latestSnapshot.sections, getSourceEvents()),
      showCopyNotice, 'bc-debug-copy-btn-anonymized'),
      createCopyButton('Copy All', 'Copy the full debugger trace', () =>
        [renderedTitle, ...renderedAreas.map((area) => areaToText(area))].join('\n\n'),
      showCopyNotice
      ),
      createCopyButton('Copy JSON', 'Copy the machine-readable debugger trace', () =>
        toDebugJSON(renderedTitle, latestSnapshot.sections, getSourceEvents().map((event) => formatEventLine(event))),
      showCopyNotice),
      createCopyButton('Copy Audio', 'Copy compact audio incident snapshot', () =>
        formatAudioIncidentSnapshotText(renderedTitle, latestSnapshot.sections),
      showCopyNotice),
      ...renderedAreas.map((area) =>
        createCopyButton(`Copy ${area.title}`, `Copy ${area.title}`, () => areaToText(area), showCopyNotice)
      )
    );

    areaList.textContent = '';
    if (!filteredAreas.length) {
      areaList.appendChild(createEmptyState('No debugger areas match the current search.'));
    } else {
      filteredAreas.forEach((area) => {
        areaList.appendChild(createAreaDetails(area, openAreaIds, areaScrollTops));
      });
    }

    const visibleRows = filteredAreas.reduce((sum, area) => sum + area.entries.length, 0);
    const totalRows = renderedAreas.reduce((sum, area) => sum + area.entries.length, 0);
    setText(stats, `${filteredAreas.length}/${renderedAreas.length} areas · ${visibleRows}/${totalRows} rows`);
  };

  const renderLiveStatus = (snapshot: DebugPanelSnapshot): void => {
    renderStatusItems(buildTraceAreas(snapshot, getRecentDebugEvents(MAX_EVENT_ROWS)));
  };

  const refreshLiveSnapshot = (): void => {
    if (paused) {
      return;
    }
    const snapshot = getSnapshot();
    if (pointerInsidePanel || isSelectingInsidePanel()) {
      pendingSnapshot = snapshot;
      renderLiveStatus(snapshot);
      return;
    }
    renderRecord(snapshot);
  };

  const setPaused = (next: boolean): void => {
    paused = next;
    if (paused) {
      frozenEvents = getRecentDebugEvents(MAX_EVENT_ROWS);
      latestSnapshot = pendingSnapshot || getSnapshot();
      pendingSnapshot = null;
    } else {
      frozenEvents = [];
      latestSnapshot = pendingSnapshot || getSnapshot();
      pendingSnapshot = null;
    }
    syncStatus();
    renderRecord(latestSnapshot);
  };

  // Panel starts hidden (view sets display:none), so the initial notified state is false.
  let lastNotifiedVisible = false;
  const notifyVisibility = (visible: boolean): void => {
    if (visible === lastNotifiedVisible) {
      return;
    }
    lastNotifiedVisible = visible;
    options?.onVisibilityChange?.(visible);
  };

  const openPanel = (): void => {
    root.style.display = 'block';
    if (!paused) {
      latestSnapshot = getSnapshot();
    }
    renderRecord(latestSnapshot);
    notifyVisibility(true);
  };

  searchInput.addEventListener('input', () => {
    renderRecord(latestSnapshot);
  });
  root.addEventListener('pointerenter', () => {
    pointerInsidePanel = true;
  });
  root.addEventListener('pointerleave', () => {
    pointerInsidePanel = false;
    if (!paused && pendingSnapshot) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = null;
      renderRecord(snapshot);
    }
  });

  closeButton.addEventListener('click', () => {
    root.style.display = 'none';
    notifyVisibility(false);
  });

  pauseButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPaused(!paused);
  });

  clearCachesButton.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await dispatchDebugClearCachesRequest();
      flashButtonLabel(clearCachesButton, 'Caches Cleared');
    } catch {
      flashButtonLabel(clearCachesButton, 'Clear Failed');
    }
  });

  clearEventsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearDebugEvents();
    if (paused) {
      frozenEvents = [];
    }
    renderRecord(latestSnapshot);
  });

  const keydown = (event: KeyboardEvent): void => {
    const isDKey = event.code === 'KeyD' || event.key.toLowerCase() === 'd' || event.key === '∂';
    if (!event.altKey || !isDKey) {
      return;
    }
    event.preventDefault();
    const show = root.style.display === 'none';
    if (show) {
      openPanel();
      return;
    }
    root.style.display = 'none';
    notifyVisibility(false);
  };

  window.addEventListener('keydown', keydown);

  const liveRefreshIntervalId = window.setInterval(() => {
    if (root.style.display === 'none') {
      return;
    }
    refreshLiveSnapshot();
  }, 1000);

  syncStatus();
  renderRecord(latestSnapshot);

  return {
    push(snapshot) {
      if (paused) {
        pendingSnapshot = snapshot;
        return;
      }
      if (pointerInsidePanel || isSelectingInsidePanel()) {
        pendingSnapshot = snapshot;
        renderLiveStatus(snapshot);
        return;
      }
      latestSnapshot = snapshot;
      if (root.style.display === 'none') {
        return;
      }
      renderRecord(snapshot);
    },
    open: openPanel,
    isVisible() {
      return root.style.display !== 'none';
    },
    isActive() {
      return true;
    },
    destroy() {
      notifyVisibility(false);
      window.removeEventListener('keydown', keydown);
      window.clearInterval(liveRefreshIntervalId);
      if (copyNoticeTimeoutId) {
        window.clearTimeout(copyNoticeTimeoutId);
      }
      root.remove();
    }
  };
}
