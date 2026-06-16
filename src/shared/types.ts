import type { KeyboardShortcutAction, KeyboardShortcutMap } from '@/shared/keyboard-shortcuts';
import type { ContextResourceSample } from '@/shared/resource-sampler';

export type BeatTypeAuto = 'straight' | 'breakbeat' | 'unknown';

export interface WaveformBands {
  peaksLow: number[];
  peaksMid: number[];
  peaksHigh: number[];
  duration: number;
  buckets: number;
}

export interface WaveformLoadingPerformanceDebug {
  active: boolean;
  dotCount: number;
  sampleCount: number;
  longFrameCount: number;
  avgFrameMs: number;
  maxFrameMs: number;
  lastFrameMs: number;
  durationMs: number;
  lastUpdateTs: number;
}

export interface RenderPerformanceDebug {
  panelUpdateMs: number;
  debugSnapshotMs: number;
  totalRenderMs: number;
  renderCount: number;
  lastRenderAt: number;
}

export interface UiPerformanceDebug {
  waveformLoading?: WaveformLoadingPerformanceDebug;
  render?: RenderPerformanceDebug;
}

// Per-worker resource report assembled pool-side. `busyFraction` is exact (measured at the
// pool's busy/idle transitions, not from the worker), so it stays accurate even when the
// worker is blocked in WASM and its own `sample` request times out (sample === null).
export interface WorkerResourceReport {
  index: number;
  ready: boolean;
  busyFraction: number;
  sample: ContextResourceSample | null;
  wasmHeapBytes: number | null;
}

// One backend context's resource picture (the background page/SW, or the Chrome offscreen
// analysis host). `caches` is a compact counts/bytes-only token line — never keys, URLs,
// paths, or identity.
export interface HostResourceDiagnostics {
  context: 'background' | 'offscreen-analysis-host';
  awakeForDiagnostics: boolean;
  sample: ContextResourceSample | null;
  pool: { total: number; ready: number; busy: number; queued: number; busyFraction: number } | null;
  workers: WorkerResourceReport[];
  caches: string;
  essentiaHeapBytes: number | null;
  ts: number;
}

// Reply to GET_RESOURCE_DIAGNOSTICS. `sessionActive` is whether the requesting sessionId is
// still registered in the receiver's active set — false means the (MV3) service worker was
// suspended and dropped its session state, so the content controller re-opens the session.
export interface ResourceDiagnosticsResponse {
  background: HostResourceDiagnostics;
  offscreen: HostResourceDiagnostics | null;
  sessionActive: boolean;
  ts: number;
}

export interface AnalysisResult {
  bpm?: number;
  bpmDebugSource?: string;
  bpmDebugDetail?: string;
  bpmDebugCacheKey?: string;
  bpmDebugCacheBpm?: number;
  keyDebugSource?: string;
  keyDebugDetail?: string;
  keyDebugCacheKey?: string;
  keyDebugTimingMs?: number;
  keyDebugDecodeMs?: number;
  keyDebugPreprocessMs?: number;
  keyDebugComputeMs?: number;
  confidence?: number;
  tempoRawConfidence?: number;
  tempoDecisionConfidence?: number;
  beatTypeAuto?: BeatTypeAuto;
  breakbeatScore?: number;
  analysisStatus?: string;
  analysisMs?: number;
  analysisFetchMs?: number;
  analysisDecodeMs?: number;
  analysisTempoMs?: number;
  waveform?: WaveformBands | null;
  waveformStatus?: string;
  waveformMs?: number;
  waveformDebugContentKey?: string;
  waveformDebugBackendKey?: string;
  analysisServedBy?: string;
  analysisAudioCompleteness?: string;
  chromeOffscreenDebug?: string;
  sourceUrl?: string;
  resolvedAudioUrl?: string;
  error?: string;
  tempoDebugBaseBpm?: number;
  /** Pre-round float of the base estimate; instrumentation for BPM-offset analysis only. */
  tempoDebugBaseRawBpm?: number;
  tempoDebugSummary?: string;
  tempoDebugGate?: string;
  tempoDebugCandidates?: Array<{
    bpm: number;
    label: string;
    score: number;
  }>;
  workerPoolDebug?: string;
  keyStatus?: KeyAnalysisStatus;
  ts: number;
  keyAnalysis?: KeyAnalysisResult;
}

export interface TrackMetadata {
  artistName: string;
  trackTitle: string;
  albumTitle: string;
  releaseDate?: TrackReleaseDate;
  combined: string;
  confidence: 'high' | 'medium' | 'low';
  sources: {
    title: string;
    artist: string;
    album: string;
  };
}

export interface TrackReleaseDate {
  raw: string;
  iso: string;
  epochMs: number;
  source: string;
}

export interface MetadataResolution {
  metadata: TrackMetadata;
  sourceUrl: string;
  matchedTrackId: string;
  matchedStreamUrl: string;
  selectedTrackIndex: number;
  selectedTrackReason: 'trackId' | 'streamUrl' | 'cacheTrackId' | 'none';
}

export interface NonReleaseActiveTrackIdentity {
  sourceTrackId: string;
  sourceStreamUrl: string;
  sourceStreamContentId: string;
  matchedTrackId: string;
  matchedStreamUrl: string;
  matchedReason: string;
}

export interface NonReleaseResolverSourceIdentity {
  tralbumSource: 'TralbumData' | 'TralbumAPI' | 'none';
  identitySource: 'TralbumData' | 'TralbumAPI' | 'none';
  allowApiFetch: boolean;
  preferApi: boolean;
  staleTrack: boolean;
}

export interface NonReleaseResolverFlags {
  metadataAlignedWithSource: boolean;
  metadataStrictTrackMatch: boolean;
  playlistMatchedSource: boolean;
  playlistMatchedViaMetadata: boolean;
  playabilityGated: boolean;
  strictPlaylistBinding: boolean;
}

export interface NonReleaseResolverSnapshot {
  context: 'player' | 'discover';
  currentSrc: string;
  metadata: TrackMetadata;
  metadataResolution: MetadataResolution;
  playlist: PlaylistState;
  playlistSource: string;
  playlistCurrentIndexReason: string;
  source: NonReleaseResolverSourceIdentity;
  activeTrack: NonReleaseActiveTrackIdentity;
  flags: NonReleaseResolverFlags;
  tralbum: unknown | null;
}

export type LikeState = 'unknown' | 'disliked' | 'liked' | 'bought';

export interface LikeIdentity {
  itemId: string | number;
  itemType: 'album' | 'track';
  bandId?: string | number;
  pageUrl?: string;
}

export interface LikeViewState {
  albumState: LikeState;
  loading: boolean;
  disabled: boolean;
  notice?: string;
  trackStates: Record<number, LikeState>;
}

export interface LikeInventoryCounts {
  wishlistAlbumIds: number;
  wishlistTrackIds: number;
  wishlistAlbumUrls: number;
  wishlistTrackUrls: number;
  collectionAlbumIds: number;
  collectionTrackIds: number;
  collectionAlbumUrls: number;
  collectionTrackUrls: number;
}

export interface SerializedLikeInventory {
  wishlistAlbumIds: string[];
  wishlistTrackIds: string[];
  wishlistAlbumUrls: string[];
  wishlistTrackUrls: string[];
  collectionAlbumIds: string[];
  collectionTrackIds: string[];
  collectionAlbumUrls: string[];
  collectionTrackUrls: string[];
}

export interface SerializedBoughtLikeInventory {
  collectionAlbumIds: string[];
  collectionTrackIds: string[];
  collectionAlbumUrls: string[];
  collectionTrackUrls: string[];
}

export type LikeSyncStatus = 'idle' | 'in-flight' | 'success' | 'error';

export interface LikeEndpointDebug {
  wishlist: string;
  collection: string;
}

export interface LikeEndpointAttempts {
  wishlist: number;
  collection: number;
}

export interface SharedLikesCacheSnapshot {
  fanId: string;
  fanSlug: string;
  syncStatus: LikeSyncStatus;
  syncReason: string;
  lastSyncTs: number;
  nextRetryTs: number;
  endpointStatus: LikeEndpointDebug;
  endpointAttempts: LikeEndpointAttempts;
  inventory: SerializedLikeInventory;
  updatedAt: number;
}

export interface PersistentBoughtLikesSnapshot {
  fanId: string;
  fanSlug: string;
  inventory: SerializedBoughtLikeInventory;
  updatedAt: number;
}

export interface LikeProcessEvent {
  ts: number;
  stage: string;
  detail: string;
}

export type LikeMutationTarget = 'album' | 'track' | 'none';
export type LikeMutationAction = 'collect' | 'uncollect' | 'none';
export type LikeMutationGate = 'allowed' | 'blocked' | 'n/a';

export interface LikeMutationDebug {
  enabled: boolean;
  inFlight: boolean;
  target: LikeMutationTarget;
  action: LikeMutationAction;
  key: string;
  gate: LikeMutationGate;
  reasonCode: string;
  requestOrigin: string;
  requestContextFamily: string;
  requestContextVariant: string;
  selectedOriginReason: string;
  endpointPath: string;
  status: number;
  ok: boolean;
  cooldownMsRemaining: number;
  identityItemId: string;
  identityItemType: string;
  identityBandId: string;
  identityPageUrl: string;
  pageHost: string;
  targetHost: string;
  sameHost: boolean;
  fanIdPresent: boolean;
  fanIdValue: string;
  crumbPresent: boolean;
  crumbLength: number;
  crumbSource: string;
  retryCount: number;
  preflightReason: string;
  requestPreview: string;
  responsePreview: string;
  transport: string;
  preflightAt: number;
  dispatchAt: number;
  completedAt: number;
  durationMs: number;
  ts: number;
}

export interface LikesDebugSnapshot {
  phase: string;
  context: string;
  contextFamily: string;
  contextVariant: string;
  fanSlug: string;
  fanId: string;
  syncStatus: LikeSyncStatus;
  syncReason: string;
  syncRunSeq: number;
  syncInFlightSince: number;
  lastSyncTs: number;
  endpointStatus: LikeEndpointDebug;
  endpointAttempts: LikeEndpointAttempts;
  nextRetryTs: number;
  inventoryCounts: LikeInventoryCounts;
  boughtCacheStatus: string;
  boughtCacheUpdatedAt: number;
  boughtCacheLastReadAt: number;
  boughtCacheLastWriteAt: number;
  boughtCacheCollectionAlbumIds: number;
  boughtCacheCollectionTrackIds: number;
  boughtCacheCollectionAlbumUrls: number;
  boughtCacheCollectionTrackUrls: number;
  albumState: LikeState;
  activeTrackIndex: number;
  activeTrackState: LikeState | 'n/a';
  truthAlbumState: LikeState;
  truthActiveTrackState: LikeState | 'n/a';
  displayAlbumState: LikeState;
  displayActiveTrackState: LikeState | 'n/a';
  trackProjection: string;
  identityTrust: string;
  identityReason: string;
  lastAction: string;
  lastActionTs: number;
  lastError: string;
  mutation: LikeMutationDebug;
  processEvents: LikeProcessEvent[];
}

export interface PlaylistTrack {
  index: number;
  title: string;
  artistName?: string;
  albumTitle?: string;
  releaseDate?: TrackReleaseDate;
  durationSec: number;
  bpm?: number;
  playable?: boolean;
  isCurrent: boolean;
  isAnalyzing?: boolean;
  analysisFailed?: boolean;
  trackId?: string;
  pageUrl?: string;
  streamUrl?: string;
  identitySource?: string;
  cacheKey?: string;
  key1?: string;
  key2?: string;
  key1Level?: 'level-low' | 'level-medium' | 'level-high' | 'level-unknown';
  key2Level?: 'level-low' | 'level-medium' | 'level-high' | 'level-unknown';
  key1Score?: number;
  key2Score?: number;
  key1Loading?: boolean;
  key2Loading?: boolean;
  likeState?: LikeState;
}

export interface PlaylistState {
  tracks: PlaylistTrack[];
  currentIndex: number;
  expanded: boolean;
  loading: boolean;
  sortKey: 'index' | 'bpm' | 'title' | 'key' | 'key2';
  sortAsc: boolean;
  releasePageUrl?: string;
}

export interface RuntimePlaylistPreparationUiState {
  status: 'idle' | 'preparing' | 'error';
  prepared: number;
  total: number;
  active: number;
  capacity: number;
  detail: string;
}

export interface TempoAdjustUiState {
  detectedBpm?: number;
  controlsEnabled: boolean;
  offsetBpm: number;
  masterTempoEnabled: boolean;
}

export type WaveformSeekMode = 'continuous' | 'commit-on-release';

export interface PanelInput {
  metadata: TrackMetadata;
  metadataLoading?: boolean;
  isPlaying: boolean;
  playheadFraction: number;
  currentTimeSec: number;
  durationSec: number;
  volume?: number;
  muted?: boolean;
  analysis: AnalysisResult | null;
  playlist: PlaylistState;
  releasePageUrl?: string;
  likeState: LikeViewState;
  preloadTracks: boolean;
  keyAnalysisEnabled: boolean;
  autoPlayEnabled: boolean;
  // Chrome-only Performance mode toggle state; rendered only on the Chrome build.
  performanceModeEnabled?: boolean;
  keyboardShortcuts?: KeyboardShortcutMap;
  tempoScale?: number;
  tempoAdjust?: TempoAdjustUiState;
  likeNotice?: string;
  waveformSeekMode?: WaveformSeekMode;
  seekPending?: boolean;
  seekPendingFraction?: number | null;
  runtimePlaylistPreparation?: RuntimePlaylistPreparationUiState;
  runtimePlaylistSelectionPending?: boolean;
  uiPerformance?: UiPerformanceDebug;
}

export interface PanelHandlers {
  onTogglePlayPause(): void;
  onSetVolume(volume: number): void;
  onSeekToFraction(fraction: number): void;
  onPrevTrack(): void;
  onNextTrack(): void;
  onSelectPlaylistTrack(index: number): void;
  onTogglePlaylistSort(key: PlaylistState['sortKey']): void;
  onTogglePlaylist(): void;
  onOpenBackgroundTab(url: string): void;
  onToggleAlbumLike(): void;
  onToggleTrackLike(index: number): void;
  onTogglePreloadTracks(enabled: boolean): void;
  onToggleKeyAnalysis(enabled: boolean): void;
  onToggleAutoPlay(enabled: boolean): void;
  onTogglePerformanceMode(enabled: boolean): void;
  onKeyboardShortcutsChanged(shortcuts: KeyboardShortcutMap): void;
  onSetTempoAdjustOffsetBpm(offsetBpm: number): void;
  onSetTempoAdjustMasterTempoEnabled(enabled: boolean): void;
  onClosePanel(): void;
}

export interface PageGlobals {
  tralbum: unknown | null;
  band: unknown | null;
  page: unknown | null;
  fan?: unknown | null;
  collection?: unknown | null;
  wishlist?: unknown | null;
  bc?: unknown | null;
  ts: number;
}

export type FanEndpoint = 'wishlist_items' | 'collection_items';

export interface FetchTralbumRequest {
  type: 'FETCH_TRALBUM';
  url?: string;
  bandId?: string | number;
  tralbumId?: string | number;
  tralbumType?: 'a' | 't';
  trackId?: string | number;
  allowHtmlFallback?: boolean;
}

export interface NotifyPlaybackStartedRequest {
  type: 'NOTIFY_PLAYBACK_STARTED';
  src: string;
  context: 'player' | 'discover';
}

export interface FetchPlaybackAudioRequest {
  type: 'FETCH_PLAYBACK_AUDIO';
  url: string;
  includeCredentials?: boolean;
  requestId?: string;
}

export interface FetchPlaybackAudioResponse {
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  /** Base64-encoded audio bytes. Chrome's sendResponse uses JSON serialisation
   *  which silently converts ArrayBuffer → {}, so we encode as a string instead. */
  audioDataBase64?: string;
  error?: string;
  ts: number;
}

export interface CancelPlaybackAudioRequest {
  type: 'CANCEL_PLAYBACK_AUDIO';
  requestId: string;
}

export interface CancelPlaybackAudioResponse {
  ok: boolean;
  requestId: string;
  cancelled: boolean;
  ts: number;
}

export type ContentMessage =
  | { type: 'ANALYZE_TRACK'; url: string; fetchUrl?: string; cacheKey?: string; enableKeyAnalysis?: boolean }
  | { type: 'ANALYZE_TRACK_SILENT'; url: string; fetchUrl?: string; cacheKey?: string; enableKeyAnalysis?: boolean }
  | { type: 'CANCEL_ANALYSIS'; url?: string; cacheKey?: string }
  | { type: 'ANALYZE_KEY'; url: string; bpm: number; cacheKey?: string }
  | { type: 'CANCEL_KEY_ANALYSIS'; url?: string }
  | { type: 'GET_WAVEFORM'; url: string; fetchUrl?: string; cacheKey?: string }
  | { type: 'CLEAR_ANALYSIS_CACHE' }
  | AnalyzeBpmPrototypeMessage
  | AnalyzeKeyDebugMessage
  | CancelPlaybackAudioRequest
  | FetchPlaybackAudioRequest
  | FetchTralbumRequest
  | NotifyPlaybackStartedRequest
  | { type: 'OPEN_BACKGROUND_TAB'; url: string }
  | { type: 'RESOLVE_FAN_ID'; fanSlug?: string; fanIdHint?: string | number }
  | { type: 'GET_SHARED_LIKES_CACHE'; fanId?: string | number }
  | { type: 'SET_SHARED_LIKES_CACHE'; snapshot: SharedLikesCacheSnapshot }
  | { type: 'GET_PERSISTENT_BOUGHT_LIKES_CACHE'; fanId?: string | number }
  | { type: 'SET_PERSISTENT_BOUGHT_LIKES_CACHE'; snapshot: PersistentBoughtLikesSnapshot }
  | {
      type: 'FETCH_FANCOLLECTION_ITEMS';
      endpoint: FanEndpoint;
      fanId: string | number;
      olderThanToken?: string;
      count?: number;
    }
  | { type: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION'; sessionId: string }
  | { type: 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION'; sessionId: string }
  | { type: 'GET_RESOURCE_DIAGNOSTICS'; sessionId: string }
;

export type BackgroundPush =
  | ({ type: 'ANALYSIS_PARTIAL'; url: string } & Partial<AnalysisResult>)
  | { type: 'PING'; ts: number }
  | { type: 'PAUSE_LOCAL_PLAYBACK'; reason: 'other-tab-started'; fromTabId?: number; src?: string }
  | { type: 'PLAYBACK_SHORTCUT_COMMAND'; action: KeyboardShortcutAction; source: 'media-key' };

export interface TralbumFetchResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  debugDecision?: string;
}


export interface DebugEvent {
  tag: LogTag;
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
  ts: number;
}

export type LogTag =
  | 'AUDIO'
  | 'ANALYZER'
  | 'METADATA'
  | 'PLAYLIST'
  | 'LIKES'
  | 'MESSAGING'
  | 'UI'
  | 'DISCOVER'
  | 'BRIDGE'
  | 'KEY'
  | 'BACKGROUND'
  | 'WORKER-POOL';

export interface PlayerStateSnapshot {
  pageType: string;
  currentUrl: string;
  currentAudioSrc: string;
  isPlaying: boolean;
  hasAudioElement: boolean;
  metadata: TrackMetadata;
  lastMessages: DebugEvent[];
}

export interface KeyCandidate {
  camelot: string;
  key: string;
  weight: number;
}

export interface KeyAnalysisParams {
  windowBeats: number;
  hopBeats: number;
  pitchSalienceThreshold: number;
  hfcPercentileThreshold: number;
  prefilterFrameCount: number;
  relativeEnergyGate: number;
  reliabilityFloor: number;
  dualCenterGapThreshold: number;
  minCandidateWeight: number;
  smoothingWindowSize: number;
  minSegmentWindows: number;
  profileType: string;
  pcpSize: number;
  profileMix: boolean;
  rankMode: 'baseline' | 'consensus';
}

export interface KeySegment {
  startSeconds: number;
  endSeconds: number;
  camelot: string;
}

export interface KeyAnalysisResult {
  topKeys: KeyCandidate[];
  dualCenter: boolean;
  segments: KeySegment[];
  method: 'essentia-hpcp-key';
  windowsAnalyzed: number;
  windowsTotal: number;
  reliability: number;
}

export type KeyAnalysisStatus = 'disabled' | 'pending-bpm' | 'analyzing' | 'ready' | 'empty' | 'error';

export interface KeyWindowData {
  index: number;
  startSample: number;
  endSample: number;
  startSeconds: number;
  endSeconds: number;
  pitchSalience: number;
  hfc: number;
  hfcPercentile: number;
  dissonance: number;
  passedPrefilter: boolean;
  prefilterReason: 'pitch-salience' | 'hfc' | null;
  meanHPCP: number[] | null;
  harmonicEnergy: number | null;
  passedEnergyGate: boolean | null;
  key: string | null;
  scale: string | null;
  camelot: string | null;
  keyStrength: number | null;
  firstToSecondRelativeStrength: number | null;
  combinedWeight: number | null;
}

export interface KeyAnalysisDebugResult {
  result: KeyAnalysisResult;
  windows: KeyWindowData[];
  params: KeyAnalysisParams;
}

export interface AnalyzeKeyDebugMessage {
  type: 'ANALYZE_KEY_DEBUG';
  url: string;
  bpm?: number;
  params: KeyAnalysisParams;
}

export interface AnalyzeKeyDebugResponse {
  type: 'ANALYZE_KEY_DEBUG_RESPONSE';
  debug: KeyAnalysisDebugResult | null;
  error?: string;
}

export interface BpmPrototypeSegmentResult {
  index: number;
  startSeconds: number;
  endSeconds: number;
  baseBpm: number;
  currentBpm: number;
  winningLabel: string;
  winningBpm: number;
  winningScore: number;
  baseScore: number;
  stableLabel: string | null;
  stableBpm: number | null;
  reliability: number;
  supportType: 'direct' | 'remapped-base' | 'weak-base' | 'low-score' | 'outlier';
  candidates: Array<{
    bpm: number;
    label: string;
    score: number;
  }>;
}

export interface BpmPrototypeVoteSummary {
  label: string;
  count: number;
  share: number;
  weight: number;
  weightedShare: number;
  medianBpm: number;
  averageScore: number;
  directCount: number;
  remappedCount: number;
}

export interface BpmPrototypeRecommendation {
  action: 'keep-base' | 'promote-slower';
  label: string;
  bpm: number;
  confidence: number;
  reason: string;
}

export interface BpmPrototypeAnalysisResult {
  method: 'segment-vote-v1' | 'segment-vote-v2' | 'sparse-window-v1' | 'sparse-window-v2';
  segmentLengthSec: number;
  hopLengthSec: number;
  segmentsAnalyzed: number;
  stableSegments: number;
  votes: BpmPrototypeVoteSummary[];
  recommendation: BpmPrototypeRecommendation;
  segments: BpmPrototypeSegmentResult[];
}

export interface BpmPrototypeSimulatedResult {
  bpm: number;
  action: 'keep-base' | 'promote-slower';
  label: string;
  confidence: number;
  reason: string;
  gate?: string;
}

export interface AnalyzeBpmPrototypeMessage {
  type: 'ANALYZE_BPM_PROTOTYPE';
  url: string;
  tempoAnalysisMode?: 'corrected' | 'base-only';
}

/**
 * EXPERIMENT (panel-only): beat-grid precision refinement.
 * Percival's BPM is quantised to a coarse lag grid (7500/n), so true integer
 * tempos round to ±1. When the finer beat-counter tempo agrees with Percival on
 * the same pulse (within `toleranceBpm`), we take the finer value. The fine
 * source is RhythmExtractor2013's aggregated `bpm` (NOT the raw interval median,
 * which proved too noisy). Measured in the BPM prototype panel before any runtime use.
 */
export interface TempoGridRefinement {
  baseBpm: number;       // Percival raw float (the coarse grid value)
  fineBpm: number;       // RhythmExtractor aggregated bpm — finer resolution, 0 if unavailable
  refinedBpm: number;    // fineBpm when agreed, else baseBpm
  agreed: boolean;       // fineBpm within toleranceBpm of baseBpm (same pulse)
  toleranceBpm: number;
}

export interface AnalyzeBpmPrototypeResponse {
  type: 'ANALYZE_BPM_PROTOTYPE_RESPONSE';
  analysis: AnalysisResult | null;
  prototype: BpmPrototypeAnalysisResult | null;
  simulated: BpmPrototypeSimulatedResult | null;
  precision?: TempoGridRefinement | null;
  error?: string;
}
