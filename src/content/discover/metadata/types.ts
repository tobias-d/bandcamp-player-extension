export interface DiscoverIdentity {
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't';
  trackId: string;
  url: string;
}

export interface DiscoverNowPlaying {
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  releaseUrl: string;
  streamUrl: string;
  trackId: string;
  currentTimeSec: number;
  durationSec: number;
  playbackTs: number;
  identity: DiscoverIdentity | null;
  isPlaying: boolean;
  sources: {
    title: string;
    artist: string;
    album: string;
    release: string;
    stream: string;
    identity: string;
  };
}

export interface PayloadMatch {
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  releaseUrl: string;
  streamUrl: string;
  trackId: string;
  identity: DiscoverIdentity | null;
}

export interface DiscoverReleaseProbe {
  url: string;
  source: string;
}

export interface MediaSessionState {
  title: string;
  artist: string;
  album: string;
  isPlaying: boolean;
}
