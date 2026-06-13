import type {
  AnalysisResult,
  LikesDebugSnapshot,
  LikeViewState,
  MetadataResolution,
  NonReleaseResolverSnapshot,
  PlaylistState,
  TrackMetadata,
  UiPerformanceDebug
} from '@/shared/types';
import type { OwnedPlaybackHostState } from '@/content/discover/origin-bridge/types';
import type { KeyAnalysisTraceEntry } from '@/content/debug/key-analysis-trace';
import type {
  RuntimeAudioEngineDebugSnapshot,
  RuntimeAudioIncidentDebugSnapshot,
  RuntimeAudioOwnershipState,
  RuntimeStretchCapability
} from '@/content/player/runtime-audio/types';
import {
  createDefaultLikesDebugSnapshot,
  DEFAULT_LIKE_VIEW_STATE,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import { createTransportDebugState, type TransportDebugState } from '@/content/debug/debugger';
import type { ResourceDiagnosticsDebugState } from '@/content/debug/resource-diagnostics';

export class PlayerState {
  public activeAudio: HTMLAudioElement | null = null;
  public detachedPlaybackActive = false;
  public bridgeAudioState: {
    src: string;
    origin: 'runtime' | 'origin-audio' | 'bridge-observer';
    paused: boolean;
    currentTimeSec: number;
    durationSec: number;
    volume: number;
    muted: boolean;
    ts: number;
  } | null = null;
  public currentSrc = '';
  public hasPlaybackStarted = false;
  public pendingSeekFraction: number | null = null;
  public pendingSeekAtMs = 0;
  public seekWaitOverlayActive = false;
  public playheadTransitionGuardUntilMs = 0;
  public runtimePlaybackOwned = false;
  public playheadDebug: {
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
    lastObservedSrc: string;
    lastObservedSelectedSource: 'audio' | 'bridge';
    lastObservedCurrentSec: number;
  } = {
    selectedSource: 'audio',
    selectedReason: 'init',
    selectedCurrentSec: 0,
    selectedDurationSec: 0,
    selectedFraction: 0,
    audioSrc: '',
    audioPaused: true,
    audioCurrentSec: 0,
    audioDurationSec: 0,
    bridgeSrc: '',
    bridgeOrigin: '-',
    bridgePaused: true,
    bridgeCurrentSec: 0,
    bridgeDurationSec: 0,
    pendingSeekFraction: null,
    pendingSeekAgeMs: null,
    lastUpdateTs: 0,
    trace: [],
    lastObservedSrc: '',
    lastObservedSelectedSource: 'audio',
    lastObservedCurrentSec: 0
  };
  public nativeSeekDebug: {
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
  } = {
    requestAt: 0,
    requestFraction: null,
    requestTargetTimeSec: null,
    requestSelectedSource: 'audio',
    requestRuntimeOwned: false,
    requestSrc: '',
    requestPaused: true,
    requestReadyState: null,
    requestNetworkState: null,
    requestBufferedAheadSec: null,
    dispatchMode: '-',
    runtimeDispatchAt: 0,
    runtimeDispatchDetail: '-',
    nativeDispatchAt: 0,
    nativeDispatchDetail: '-',
    lastEvent: '-',
    lastEventDetail: '-',
    lastEventAt: 0,
    seekingAt: 0,
    seekedAt: 0,
    firstTimeupdateAt: 0,
    eventCurrentTimeSec: null,
    eventDurationSec: null,
    eventReadyState: null,
    eventNetworkState: null,
    eventBufferedAheadSec: null
  };

  public renderScheduled = false;
  public rafId = 0;
  public uiPerformanceDebug: UiPerformanceDebug = {};
  // Live reference to the resource-diagnostics controller's debug state (mutated in place); read
  // synchronously by the debug-body builder. Null until the controller is wired in.
  public resourceDiagnostics: ResourceDiagnosticsDebugState | null = null;

  public lastAnalysis: AnalysisResult | null = null;
  public analysisRunId = 0;

  public tempoScale = 1.0;
  public tempoAdjustOffsetBpm = 0;
  public tempoAdjustMasterTempoEnabled = true;
  public runtimeTempoAdjustReady = false;
  public runtimePlaylistSelectionPending = false;

  public likeNoticeText = '';
  public likeNoticeExpiresAt = 0;
  public keyAnalysisTrace: KeyAnalysisTraceEntry[] = [];
  public runtimeStretchCapability: RuntimeStretchCapability | null = null;
  public runtimeAudioEngineDebug: RuntimeAudioEngineDebugSnapshot | null = null;
  public runtimeAudioIncidentDebug: RuntimeAudioIncidentDebugSnapshot = {
    transitionSeq: 0,
    currentTransitionId: '-',
    currentReason: '-',
    targetSrc: '',
    targetStage: 'idle',
    browserAudio: '-',
    recentIncidents: [],
    warnings: [],
    timings: [],
    events: []
  };
  public runtimeAudioDebug: {
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
  } | null = null;
  public ownedPlaybackHostState: OwnedPlaybackHostState | null = null;
  public preloadTrace: KeyAnalysisTraceEntry[] = [];
  public preloadStateLines: string[] = [];
  public preloadDebugSnapshot: {
    trace: KeyAnalysisTraceEntry[];
    stateLines: string[];
    preloadBpmBatchOpenTs?: number;
    preloadKeyBatchOpenTs?: number;
  } = { trace: [], stateLines: [] };

  public metadata: TrackMetadata = { ...DEFAULT_TRACK_METADATA };
  public metadataResolution: MetadataResolution | null = null;
  public nonReleaseSnapshot: NonReleaseResolverSnapshot | null = null;
  public nonReleaseSnapshotVersion = -1;
  public sourceVersion = 0;
  public playlistSelectionRunId = 0;
  public playlistJumpLockTrackId = '';
  public playlistJumpLockUntil = 0;
  public playlist: PlaylistState = { ...DEFAULT_PLAYLIST_STATE, tracks: [] };
  public playlistSource = 'none';
  public forceUnifiedNonReleaseSnapshot = false;
  public originDetachedFromPage = false;
  public transportDebug: TransportDebugState = createTransportDebugState();
  public likesDebug: LikesDebugSnapshot = createDefaultLikesDebugSnapshot('player');
  public likeViewState: LikeViewState = { ...DEFAULT_LIKE_VIEW_STATE, trackStates: {} };
}
