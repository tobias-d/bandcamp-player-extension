import type { PageGlobals } from '@/shared/types';

export interface BridgeMessage {
  source: string;
  type:
    | 'DISCOVER_OBSERVED'
    | 'DISCOVER_SELECTION'
    | 'PAGE_GLOBALS'
    | 'API_HINT'
    | 'DISCOVER_AUDIO_STATE'
    | 'DISCOVER_AUDIO_ENDED'
    | 'OWNED_PLAYBACK_HOST_STATE'
    | 'LIKES_MUTATION_RESULT'
    | 'DISCOVER_ORIGIN_TRACK_CHANGE';
  payload: unknown;
  ts: number;
}

export interface ApiIdentityHint {
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't' | '';
  trackId?: string;
  url: string;
  ts: number;
}

export interface DiscoverAudioState {
  src: string;
  paused: boolean;
  ended: boolean;
  currentTimeSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  ts: number;
}

export interface DiscoverAudioEndedEvent {
  src: string;
  currentTimeSec: number;
  durationSec: number;
  ts: number;
}

export interface OwnedPlaybackHostState {
  status: 'booting' | 'ready' | 'error';
  phase: string;
  engine: string;
  detail: string;
  currentSrc: string;
  playing: boolean;
  detachedReady: boolean;
  lastCommand: string;
  lastCommandDetail: string;
  lastCommandAt: number;
  lastAudioEvent: string;
  lastAudioEventDetail: string;
  lastAudioEventAt: number;
  trackedAudioCount: number;
  knownAudioCount: number;
  playingAudioCount: number;
  activeSrc: string;
  playingSrcs: string[];
  ts: number;
}

export interface DiscoverPayloadTrackMatch {
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  releaseUrl: string;
  streamUrl: string;
  ts: number;
}

export interface LikesMutationBridgeRequest {
  action: 'collect' | 'uncollect';
  fanId: string | number;
  itemId: string | number;
  itemType: 'album' | 'track';
  crumb?: string;
  bandId?: string | number;
  pageUrl?: string;
  requestContextFamily?: string;
  requestContextVariant?: string;
}

export interface LikesMutationBridgeResult {
  ok: boolean;
  status?: number;
  error?: string;
  reason?: string;
}

export interface PendingLikesMutation {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timerId: number;
}

export interface BridgeStateSnapshot {
  latestPayload: { data: unknown; ts: number } | null;
  latestSelection: { url: string; ts: number } | null;
  latestGlobals: PageGlobals | null;
  apiIdentityHints: ApiIdentityHint[];
  latestDiscoverAudioState: DiscoverAudioState | null;
  latestDiscoverAudioEnded: DiscoverAudioEndedEvent | null;
  latestOwnedPlaybackHostState: OwnedPlaybackHostState | null;
  latestPayloadTrackMatchesByTrackId: Map<string, DiscoverPayloadTrackMatch>;
}
