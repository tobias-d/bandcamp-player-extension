import type {
  AnalysisResult,
  AnalyzeBpmPrototypeResponse,
  BpmPrototypeAnalysisResult,
  BpmPrototypeSimulatedResult,
  PlaylistTrack,
  TempoGridRefinement,
  TralbumFetchResponse
} from '@/shared/types';
import { sendMessage } from '@/utils/messaging';
import { dom } from '@/utils/dom';
import { buildTrackRows, getTrackLists, asTralbumRecord } from '@/content/playlist/resolver-tracklist';
import { normalizeUrl, readTrackIdFromUrl } from '@/content/playlist/resolver-url';
import {
  getDefaultBpmPrototypeTracks,
  readCustomBpmPrototypeTracks,
  writeCustomBpmPrototypeTracks,
  type BpmPrototypeTrackEntry
} from '@/content/player/bpm-prototype-tracks';
import {
  ensureBpmPrototypePanel,
  isBpmPrototypePanelOpen,
  readBpmPrototypePanelFamily,
  readBpmPrototypePanelMode,
  removeBpmPrototypePanel,
  type BpmPrototypePanelRefs
} from '@/ui/bpm-prototype-panel';

export interface BpmPrototypeController {
  toggle(): void;
  destroy(): void;
}

interface BpmPrototypeControllerOptions {
  getCurrentAnalysisUrl: () => string;
  getCurrentSaveUrl: () => string;
  getCurrentMetadata: () => { artistName: string; trackTitle: string; albumTitle: string };
}

interface ResolvedTrackAnalysis {
  inputUrl: string;
  resolvedAudioUrl: string;
  matchedTrack?: PlaylistTrack;
  pageUrl?: string;
}

interface PrototypeTrackHints {
  label?: string;
}

let refs: BpmPrototypePanelRefs | null = null;
let customTracks: BpmPrototypeTrackEntry[] = readCustomBpmPrototypeTracks();
let latestResult = 'No analysis yet.';
let batchRunInFlight = false;

function isGenericPrototypeLabel(label: string): boolean {
  return /^bandcamp stream \d+$/i.test(String(label || '').trim());
}

function getTrackUrlKey(url: string): string {
  const raw = String(url || '').trim();
  const trackId = readTrackIdFromUrl(raw);
  if (trackId) {
    return `track:${trackId}`;
  }
  return normalizeUrl(raw) || raw.toLowerCase();
}

function mergePrototypeTrackEntries(
  existing: BpmPrototypeTrackEntry,
  incoming: BpmPrototypeTrackEntry
): BpmPrototypeTrackEntry {
  const custom = Boolean(existing.custom || incoming.custom);
  const richerLabel = !isGenericPrototypeLabel(incoming.label) && (isGenericPrototypeLabel(existing.label) || incoming.custom);
  const richerNotes = String(incoming.notes || '').trim().length > String(existing.notes || '').trim().length;
  const preferIncomingUrl = incoming.custom && !existing.custom;

  return {
    ...existing,
    ...incoming,
    id: existing.id,
    label: richerLabel ? incoming.label : existing.label,
    url: preferIncomingUrl ? incoming.url : existing.url,
    bucket: existing.bucket || incoming.bucket,
    expectedBpm: Number.isFinite(existing.expectedBpm) ? existing.expectedBpm : incoming.expectedBpm,
    notes: richerNotes ? incoming.notes : (existing.notes || incoming.notes),
    custom
  };
}

function isLikelyAudioUrl(url: string): boolean {
  return /stream_redirect|\/stream\/|\.mp3(\?|$)|\.m4a(\?|$)|\.ogg(\?|$)/i.test(String(url || '').trim());
}

function formatPercent(value: number | undefined): string {
  return Number.isFinite(value) ? `${Math.round(Number(value))}%` : '-';
}

function formatCandidates(result: AnalysisResult | null | undefined): string {
  if (!Array.isArray(result?.tempoDebugCandidates) || !result?.tempoDebugCandidates.length) {
    return '-';
  }
  return result.tempoDebugCandidates
    .map((candidate) => `${candidate.bpm}@${candidate.label}:${Number(candidate.score).toFixed(2)}`)
    .join(', ');
}

function formatTimingBreakdown(result: AnalysisResult | null | undefined): string {
  const fetchMs = Number(result?.analysisFetchMs);
  const decodeMs = Number(result?.analysisDecodeMs);
  const tempoMs = Number(result?.analysisTempoMs);
  if (![fetchMs, decodeMs, tempoMs].some(Number.isFinite)) {
    return '-';
  }
  return [
    `fetch=${Number.isFinite(fetchMs) ? `${Math.round(fetchMs)}ms` : '-'}`,
    `decode=${Number.isFinite(decodeMs) ? `${Math.round(decodeMs)}ms` : '-'}`,
    `tempo=${Number.isFinite(tempoMs) ? `${Math.round(tempoMs)}ms` : '-'}`
  ].join(', ');
}

function getAllTracks(): BpmPrototypeTrackEntry[] {
  const merged = [...getDefaultBpmPrototypeTracks(), ...customTracks];
  const dedupedByKey = new Map<string, BpmPrototypeTrackEntry>();

  for (const entry of merged) {
    const key = getTrackUrlKey(entry.url);
    const existing = dedupedByKey.get(key);
    if (existing) {
      dedupedByKey.set(key, mergePrototypeTrackEntries(existing, entry));
    } else {
      dedupedByKey.set(key, entry);
    }
  }

  return Array.from(dedupedByKey.values());
}

function getAvailableBuckets(tracks: ReadonlyArray<BpmPrototypeTrackEntry>): string[] {
  return Array.from(new Set(
    tracks
      .map((entry) => String(entry.bucket || '').trim())
      .filter(Boolean)
  )).sort((left, right) => left.localeCompare(right));
}

function getSelectedBatchFamily(): string {
  return refs?.familySelect.value || readBpmPrototypePanelFamily();
}

function getSelectedTracks(): BpmPrototypeTrackEntry[] {
  const tracks = getAllTracks();
  const selectedFamily = getSelectedBatchFamily();
  if (!selectedFamily || selectedFamily === 'all') {
    return tracks;
  }
  return tracks.filter((entry) => entry.bucket === selectedFamily);
}

function refreshFamilySelect(): void {
  if (!refs) {
    return;
  }

  const tracks = getAllTracks();
  const buckets = getAvailableBuckets(tracks);
  const currentValue = getSelectedBatchFamily();

  refs.familySelect.replaceChildren(
    dom('option', { value: 'all' }, [`All Families (${tracks.length})`]),
    ...buckets.map((bucket) => {
      const count = tracks.filter((entry) => entry.bucket === bucket).length;
      return dom('option', { value: bucket }, [`${bucket} (${count})`]);
    })
  );

  refs.familySelect.value = buckets.includes(currentValue) || currentValue === 'all'
    ? currentValue
    : 'all';
}

function absolutizeUrl(url: string, fallbackBase: string): string {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw, fallbackBase).toString();
  } catch {
    return raw;
  }
}

function normalizeComparableText(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseLabelTrackHints(label: string): { artistName: string; trackTitle: string } {
  const raw = String(label || '').trim();
  if (!raw) {
    return { artistName: '', trackTitle: '' };
  }

  const separator = raw.includes(' - ') ? ' - ' : (raw.includes(' — ') ? ' — ' : '');
  if (!separator) {
    return { artistName: '', trackTitle: raw };
  }

  const [artistName, ...titleParts] = raw.split(separator);
  return {
    artistName: String(artistName || '').trim(),
    trackTitle: titleParts.join(separator).trim()
  };
}

function findTrackByPrototypeHints(
  tracks: PlaylistTrack[],
  hints: PrototypeTrackHints | null | undefined
): PlaylistTrack | null {
  const parsed = parseLabelTrackHints(String(hints?.label || ''));
  const normalizedTitle = normalizeComparableText(parsed.trackTitle);
  const normalizedArtist = normalizeComparableText(parsed.artistName);
  if (!normalizedTitle) {
    return null;
  }

  const titleMatches = tracks.filter((track) => normalizeComparableText(String(track.title || '')) === normalizedTitle);
  if (titleMatches.length === 1) {
    return titleMatches[0];
  }

  if (normalizedArtist) {
    const exactMatches = titleMatches.filter(
      (track) => normalizeComparableText(String(track.artistName || '')) === normalizedArtist
    );
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
  }

  return null;
}

function setStatus(text: string): void {
  if (!refs) {
    return;
  }
  refs.status.textContent = text;
}

function setResult(text: string): void {
  latestResult = text;
  if (!refs) {
    return;
  }
  refs.result.textContent = text;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) {
    throw new Error('Copy failed');
  }
}

function makeCustomId(url: string): string {
  return `custom:${Date.now()}:${Math.abs(hashString(url)).toString(36)}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function fillFormFromTrack(entry: BpmPrototypeTrackEntry): void {
  if (!refs) {
    return;
  }
  refs.urlInput.value = entry.url;
  refs.labelInput.value = entry.label;
  refs.expectedBpmInput.value = Number.isFinite(entry.expectedBpm) ? String(Math.round(Number(entry.expectedBpm))) : '';
  refs.notesInput.value = String(entry.notes || '');
}

function persistCustomTracks(): void {
  writeCustomBpmPrototypeTracks(customTracks);
}

function removeCustomTrack(id: string): void {
  customTracks = customTracks.filter((entry) => entry.id !== id);
  persistCustomTracks();
  refreshFamilySelect();
  renderTrackList();
}

function upsertCustomTrack(entry: BpmPrototypeTrackEntry): void {
  const targetKey = getTrackUrlKey(entry.url);
  const existingIndex = customTracks.findIndex((track) => getTrackUrlKey(track.url) === targetKey);
  if (existingIndex >= 0) {
    customTracks[existingIndex] = { ...customTracks[existingIndex], ...entry, custom: true };
  } else {
    customTracks.unshift({ ...entry, custom: true });
  }
  persistCustomTracks();
  refreshFamilySelect();
  renderTrackList();
}

function renderTrackList(): void {
  if (!refs) {
    return;
  }
  const list = refs.trackList;
  list.replaceChildren();

  const selectedFamily = getSelectedBatchFamily();
  const tracks = getSelectedTracks();
  setStatus(
    selectedFamily === 'all'
      ? `Showing all saved tracks (${tracks.length}).`
      : `Showing family ${selectedFamily} (${tracks.length} track${tracks.length === 1 ? '' : 's'}).`
  );

  for (const entry of tracks) {
    const metaBits = [
      entry.bucket,
      Number.isFinite(entry.expectedBpm) ? `target ${Math.round(Number(entry.expectedBpm))}` : '',
      entry.notes || '',
      entry.url
    ].filter(Boolean);

    const info = dom('div', {}, [
      dom('div', { class: 'bc-bpm-proto-title' }, [entry.label]),
      dom('div', { class: 'bc-bpm-proto-meta' }, [metaBits.join(' | ')])
    ]);

    const loadButton = dom('button', { type: 'button' }, ['Load']) as HTMLButtonElement;
    loadButton.addEventListener('click', () => {
      fillFormFromTrack(entry);
      setStatus(`Loaded ${entry.label}`);
    });

    const analyzeButton = dom('button', { type: 'button' }, ['Analyze']) as HTMLButtonElement;
    analyzeButton.addEventListener('click', () => {
      fillFormFromTrack(entry);
      void analyzeUrl(entry.url, entry);
    });

    const actions = dom('div', { class: 'bc-bpm-proto-actions' }, [loadButton, analyzeButton]);
    if (entry.custom) {
      const removeButton = dom('button', { type: 'button' }, ['Remove']) as HTMLButtonElement;
      removeButton.addEventListener('click', () => removeCustomTrack(entry.id));
      actions.appendChild(removeButton);
    }

    const row = dom('div', { class: `bc-bpm-proto-track${entry.custom ? ' is-custom' : ''}` }, [
      info,
      actions
    ]);
    list.appendChild(row);
  }
}

async function resolveTrackAnalysisTarget(
  inputUrl: string,
  hints?: PrototypeTrackHints | null
): Promise<ResolvedTrackAnalysis> {
  const normalizedInput = String(inputUrl || '').trim();
  if (!normalizedInput) {
    throw new Error('Paste a Bandcamp track URL first.');
  }

  if (isLikelyAudioUrl(normalizedInput)) {
    return {
      inputUrl: normalizedInput,
      resolvedAudioUrl: normalizedInput
    };
  }

  const response = await sendMessage<TralbumFetchResponse>({
    type: 'FETCH_TRALBUM',
    url: normalizedInput
  });
  if (!response?.ok || !response.data) {
    throw new Error(response?.error || 'Could not resolve Bandcamp track details.');
  }

  const tralbumRecord = asTralbumRecord(response.data);
  const { primary, secondary } = getTrackLists(response.data);
  const tracks = buildTrackRows(
    primary,
    true,
    secondary,
    {
      artistName: String(tralbumRecord?.artist || '').trim() || undefined,
      albumTitle: String(tralbumRecord?.album_title || tralbumRecord?.albumTitle || tralbumRecord?.title || '').trim() || undefined
    },
    normalizedInput
  ).filter((track) => String(track.streamUrl || '').trim());

  if (!tracks.length) {
    throw new Error('Resolved the release page, but no playable track stream URL was found.');
  }

  const normalizedPageUrl = normalizeUrl(normalizedInput);
  let matchedTrack = tracks.find((track) => normalizeUrl(String(track.pageUrl || '').trim()) === normalizedPageUrl);
  if (!matchedTrack) {
    matchedTrack = findTrackByPrototypeHints(tracks, hints) || undefined;
  }
  if (!matchedTrack && tracks.length === 1) {
    matchedTrack = tracks[0];
  }
  if (!matchedTrack) {
    throw new Error(
      /\/album\//i.test(normalizedInput)
        ? 'The album URL did not resolve to a unique track. Use the exact track URL, or save/analyze a labeled entry so the intended track can be matched.'
        : 'The pasted page URL did not match a specific playable track. Use a track URL instead of the album page.'
    );
  }

  return {
    inputUrl: normalizedInput,
    resolvedAudioUrl: String(matchedTrack.streamUrl || '').trim(),
    matchedTrack,
    pageUrl: absolutizeUrl(String(matchedTrack.pageUrl || '').trim() || normalizedInput, normalizedInput)
  };
}

function buildResultText(
  entry: BpmPrototypeTrackEntry | null,
  resolved: ResolvedTrackAnalysis,
  result: AnalysisResult,
  tempoAnalysisMode: 'corrected' | 'base-only',
  precision: TempoGridRefinement | null | undefined
): string {
  const targetBpm = entry?.expectedBpm;
  const observedBpm = Number(result.bpm);
  const delta = Number.isFinite(targetBpm) && Number.isFinite(observedBpm)
    ? Math.round(observedBpm - Number(targetBpm))
    : Number.NaN;
  const baseRawBpm = Number(result.tempoDebugBaseRawBpm);
  const rawDelta = Number.isFinite(targetBpm) && Number.isFinite(baseRawBpm)
    ? baseRawBpm - Number(targetBpm)
    : Number.NaN;
  const refinedBpm = precision ? Number(precision.refinedBpm) : Number.NaN;
  const refinedDelta = Number.isFinite(targetBpm) && Number.isFinite(refinedBpm)
    ? refinedBpm - Number(targetBpm)
    : Number.NaN;

  return [
    `Track: ${entry?.label || resolved.matchedTrack?.title || '-'}`,
    `Bucket: ${entry?.bucket || 'custom'}`,
    `Input URL: ${resolved.inputUrl}`,
    `Resolved page URL: ${resolved.pageUrl || resolved.matchedTrack?.pageUrl || '-'}`,
    `Resolved audio URL: ${resolved.resolvedAudioUrl}`,
    `Tempo mode: ${tempoAnalysisMode}`,
    `Expected BPM: ${Number.isFinite(targetBpm) ? Math.round(Number(targetBpm)) : '-'}`,
    `Observed BPM: ${Number.isFinite(observedBpm) ? Math.round(observedBpm) : '-'}`,
    `Delta: ${Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${delta}` : '-'}`,
    `Base BPM: ${Number.isFinite(result.tempoDebugBaseBpm) ? Math.round(Number(result.tempoDebugBaseBpm)) : '-'}`,
    `Base raw BPM: ${Number.isFinite(baseRawBpm) ? baseRawBpm.toFixed(3) : '-'}`,
    `Raw delta vs expected: ${Number.isFinite(rawDelta) ? `${rawDelta >= 0 ? '+' : ''}${rawDelta.toFixed(3)}` : '-'}`,
    `Refined BPM: ${precision && Number.isFinite(refinedBpm) ? refinedBpm.toFixed(3) : '-'}`,
    `Refined delta vs expected: ${Number.isFinite(refinedDelta) ? `${refinedDelta >= 0 ? '+' : ''}${refinedDelta.toFixed(3)}` : '-'}`,
    `Refined agreed: ${precision ? (precision.agreed ? 'yes' : 'no') : '-'}  (fineBpm=${precision && Number.isFinite(precision.fineBpm) ? Number(precision.fineBpm).toFixed(3) : '-'} tol=${precision ? precision.toleranceBpm : '-'})`,
    `Tempo decision: ${result.tempoDebugSummary || '-'}`,
    `Tempo gate: ${result.tempoDebugGate || '-'}`,
    `Tempo candidates: ${formatCandidates(result)}`,
    `Decision confidence: ${formatPercent(result.tempoDecisionConfidence)}`,
    `Raw confidence: ${formatPercent(result.tempoRawConfidence)}`,
    `Status: ${result.analysisStatus || '-'}`,
    `Timing: ${Number.isFinite(result.analysisMs) ? `${Math.round(Number(result.analysisMs))}ms` : '-'}`,
    `Timing breakdown: ${formatTimingBreakdown(result)}`
  ].join('\n');
}

function formatPrototypeSummary(prototype: BpmPrototypeAnalysisResult | null | undefined): string {
  if (!prototype) {
    return 'Prototype: -';
  }

  const voteLine = prototype.votes.length
    ? prototype.votes
      .map(
        (vote) => `${vote.label}:${vote.count}/${prototype.stableSegments}@${vote.medianBpm}`
          + ` score=${vote.averageScore.toFixed(2)}`
          + ` weight=${vote.weight.toFixed(2)}`
          + ` wshare=${Math.round(vote.weightedShare * 100)}%`
          + ` direct=${vote.directCount}`
          + ` remap=${vote.remappedCount}`
      )
      .join(', ')
    : '-';
  const segmentLine = prototype.segments.length
    ? prototype.segments
      .map((segment) => {
        if (!segment.stableLabel) {
          return `${segment.index}:ignored(${segment.winningLabel}@${segment.winningBpm}:${segment.supportType})`;
        }
        const source = segment.supportType === 'remapped-base'
          ? `${segment.stableLabel}<-${segment.winningLabel === segment.stableLabel ? 'derived' : segment.winningLabel}`
          : segment.stableLabel;
        return `${segment.index}:${source}@${segment.stableBpm}:${segment.reliability.toFixed(2)}`;
      })
      .join(' | ')
    : '-';
  const segmentCandidateLine = prototype.segments.length
    ? prototype.segments
      .map((segment) => {
        const candidates = segment.candidates.length
          ? segment.candidates
            .slice(0, 3)
            .map((candidate) => `${candidate.label}@${candidate.bpm}:${candidate.score.toFixed(2)}`)
            .join(',')
          : '-';
        return `${segment.index}:${candidates}`;
      })
      .join(' | ')
    : '-';

  return [
    `Prototype method: ${prototype.method}`,
    `Prototype segments: ${prototype.segmentsAnalyzed} total, ${prototype.stableSegments} stable (len=${prototype.segmentLengthSec}s hop=${prototype.hopLengthSec}s)`,
    `Prototype votes: ${voteLine}`,
    `Prototype recommendation: ${prototype.recommendation.action} ${prototype.recommendation.label}@${prototype.recommendation.bpm}`,
    `Prototype confidence: ${prototype.recommendation.confidence}%`,
    `Prototype reason: ${prototype.recommendation.reason}`,
    `Prototype segment winners: ${segmentLine}`,
    `Prototype segment candidates: ${segmentCandidateLine}`
  ].join('\n');
}

function formatSimulatedSummary(
  simulated: BpmPrototypeSimulatedResult | null | undefined,
  runtime: AnalysisResult
): string {
  if (!simulated) {
    return 'Current deferred refinement: -';
  }

  const currentBpm = Number(runtime?.bpm);
  const futureBpm = Number(simulated.bpm);
  const delta = Number.isFinite(currentBpm) && Number.isFinite(futureBpm)
    ? Math.round(futureBpm - currentBpm)
    : Number.NaN;

  return [
    `Current deferred refinement BPM: ${Number.isFinite(futureBpm) ? Math.round(futureBpm) : '-'}`,
    `Current deferred refinement action: ${simulated.action} ${simulated.label}@${simulated.bpm}`,
    `Current deferred refinement delta vs runtime: ${Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${delta}` : '-'}`,
    `Current deferred refinement confidence: ${simulated.confidence}%`,
    `Current deferred refinement reason: ${simulated.reason}`,
    `Current deferred refinement gate: ${simulated.gate || '-'}`
  ].join('\n');
}

async function runAnalysis(url: string, selectedEntry?: BpmPrototypeTrackEntry | null): Promise<string> {
  const inputUrl = String(url || '').trim();
  if (!inputUrl) {
    throw new Error('Paste a Bandcamp track URL first.');
  }

  const tempoAnalysisMode = refs?.modeSelect.value === 'base-only' ? 'base-only' : readBpmPrototypePanelMode();
  const resolved = await resolveTrackAnalysisTarget(inputUrl, selectedEntry ? { label: selectedEntry.label } : null);
  const response = await sendMessage<AnalyzeBpmPrototypeResponse>({
    type: 'ANALYZE_BPM_PROTOTYPE',
    url: resolved.resolvedAudioUrl,
    tempoAnalysisMode
  });
  if (typeof response?.error === 'string' && response.error.trim()) {
    throw new Error(response.error);
  }
  if (!response?.analysis) {
    throw new Error('Prototype analysis did not return a BPM result.');
  }

  return [
    buildResultText(selectedEntry || null, resolved, response.analysis, tempoAnalysisMode, response.precision),
    '',
    formatSimulatedSummary(response.simulated, response.analysis),
    '',
    formatPrototypeSummary(response.prototype)
  ].join('\n');
}

function setButtonsDisabled(disabled: boolean): void {
  if (!refs) {
    return;
  }
  refs.analyzeBtn.disabled = disabled;
  refs.analyzeAllBtn.disabled = disabled;
  refs.useCurrentBtn.disabled = disabled;
  refs.addCustomBtn.disabled = disabled;
  refs.addCurrentBtn.disabled = disabled;
  refs.clearCustomBtn.disabled = disabled;
}

async function analyzeUrl(url: string, selectedEntry?: BpmPrototypeTrackEntry | null): Promise<void> {
  if (!refs) {
    return;
  }

  const labelHint = String(selectedEntry?.label || refs.labelInput.value || '').trim();
  setButtonsDisabled(true);
  setStatus('Resolving track URL...');
  setResult('Resolving Bandcamp URL...');

  try {
    const selectedOrHintedEntry = selectedEntry || (labelHint ? { label: labelHint } as BpmPrototypeTrackEntry : null);
    const report = await runAnalysis(url, selectedOrHintedEntry);
    setStatus('Analysis complete.');
    setResult(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Analyze failed: ${message}`);
    setResult(`Error\n${message}`);
  } finally {
    setButtonsDisabled(false);
  }
}

async function analyzeAllTracks(): Promise<void> {
  if (!refs || batchRunInFlight) {
    return;
  }

  const tracks = getSelectedTracks();
  if (!tracks.length) {
    setStatus('No tracks available to analyze.');
    return;
  }

  const selectedFamily = getSelectedBatchFamily();
  batchRunInFlight = true;
  setButtonsDisabled(true);
  setResult(
    selectedFamily === 'all'
      ? `Preparing batch run for ${tracks.length} tracks...`
      : `Preparing batch run for family ${selectedFamily} (${tracks.length} tracks)...`
  );
  const reports: string[] = [];

  try {
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      setStatus(`Analyzing ${index + 1}/${tracks.length}: ${track.label}`);
      try {
        const report = await runAnalysis(track.url, track);
        reports.push(report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reports.push([
          `Track: ${track.label}`,
          `Bucket: ${track.bucket}`,
          `Input URL: ${track.url}`,
          `Expected BPM: ${Number.isFinite(track.expectedBpm) ? Math.round(Number(track.expectedBpm)) : '-'}`,
          `Error: ${message}`
        ].join('\n'));
      }
      setResult(reports.join('\n\n' + '='.repeat(72) + '\n\n'));
    }
    setStatus(
      selectedFamily === 'all'
        ? `Batch analysis complete: ${tracks.length} tracks.`
        : `Batch analysis complete for ${selectedFamily}: ${tracks.length} tracks.`
    );
  } finally {
    batchRunInFlight = false;
    setButtonsDisabled(false);
  }
}

export function createBpmPrototypeController(options: BpmPrototypeControllerOptions): BpmPrototypeController {
  const bindHandlers = (): void => {
    if (!refs || refs.container.dataset.handlersBound === '1') {
      return;
    }
    refs.closeBtn.addEventListener('click', () => {
      removeBpmPrototypePanel();
      refs = null;
    });
    refs.useCurrentBtn.addEventListener('click', () => {
      const currentUrl = String(options.getCurrentAnalysisUrl() || '').trim();
      if (!currentUrl || !refs) {
        setStatus('No current track URL available.');
        return;
      }
      refs.urlInput.value = currentUrl;
      const metadata = options.getCurrentMetadata();
      refs.labelInput.value = [metadata.artistName, metadata.trackTitle].filter(Boolean).join(' - ') || currentUrl;
      setStatus('Loaded current track for analysis.');
    });
    refs.analyzeBtn.addEventListener('click', () => {
      if (!refs) {
        return;
      }
      void analyzeUrl(refs.urlInput.value.trim(), null);
    });
    refs.analyzeAllBtn.addEventListener('click', () => {
      void analyzeAllTracks();
    });
    refs.familySelect.addEventListener('change', () => {
      refreshFamilySelect();
      renderTrackList();
    });
    refs.copyReportBtn.addEventListener('click', () => {
      void copyTextToClipboard(latestResult)
        .then(() => {
          setStatus('Copied report to clipboard.');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(`Copy failed: ${message}`);
        });
    });
    refs.addCustomBtn.addEventListener('click', () => {
      if (!refs) {
        return;
      }
      const url = String(refs.urlInput.value || '').trim();
      if (!url) {
        setStatus('Paste a URL before adding a custom entry.');
        return;
      }
      const label = String(refs.labelInput.value || '').trim() || url;
      const expectedBpm = Number(refs.expectedBpmInput.value);
      upsertCustomTrack({
        id: makeCustomId(url),
        label,
        url,
        bucket: 'custom',
        expectedBpm: Number.isFinite(expectedBpm) ? expectedBpm : undefined,
        notes: String(refs.notesInput.value || '').trim() || undefined,
        custom: true
      });
      setStatus(`Saved custom track: ${label}`);
    });
    refs.addCurrentBtn.addEventListener('click', () => {
      const saveUrl = String(options.getCurrentSaveUrl() || '').trim();
      const analysisUrl = String(options.getCurrentAnalysisUrl() || '').trim();
      const currentUrl = analysisUrl || saveUrl;
      if (!currentUrl) {
        setStatus('No current track URL available.');
        return;
      }
      const metadata = options.getCurrentMetadata();
      const label = [metadata.artistName, metadata.trackTitle].filter(Boolean).join(' - ') || currentUrl;
      const notes = [
        metadata.albumTitle ? `Album: ${metadata.albumTitle}` : '',
        saveUrl && saveUrl !== currentUrl ? `Page: ${saveUrl}` : ''
      ].filter(Boolean).join(' | ') || undefined;
      upsertCustomTrack({
        id: makeCustomId(currentUrl),
        label,
        url: currentUrl,
        bucket: 'custom',
        notes,
        custom: true
      });
      if (refs) {
        refs.urlInput.value = currentUrl;
        refs.labelInput.value = label;
        refs.notesInput.value = notes || '';
      }
      setStatus(`Saved current track: ${label}`);
    });
    refs.clearCustomBtn.addEventListener('click', () => {
      customTracks = [];
      persistCustomTracks();
      refreshFamilySelect();
      renderTrackList();
      setStatus('Cleared custom tracks.');
    });
    refs.container.dataset.handlersBound = '1';
  };

  const render = (): void => {
    refs = ensureBpmPrototypePanel();
    bindHandlers();
    refreshFamilySelect();
    refs.result.textContent = latestResult;
    renderTrackList();
  };

  const openPanel = (): void => {
    render();
    const currentUrl = String(options.getCurrentAnalysisUrl() || '').trim();
    if (refs && currentUrl && !refs.urlInput.value.trim()) {
      refs.urlInput.value = currentUrl;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.code !== 'KeyB' || event.repeat) {
      return;
    }
    event.preventDefault();
    if (isBpmPrototypePanelOpen()) {
      removeBpmPrototypePanel();
      refs = null;
      return;
    }
    openPanel();
  };

  document.addEventListener('keydown', onKeyDown, true);

  return {
    toggle(): void {
      if (isBpmPrototypePanelOpen()) {
        removeBpmPrototypePanel();
        refs = null;
        return;
      }
      openPanel();
    },
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown, true);
      removeBpmPrototypePanel();
      refs = null;
    }
  };
}
