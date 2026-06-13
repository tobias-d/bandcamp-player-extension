export interface ReleaseIdentity {
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't';
}

export interface ApiHintMatch {
  identity: ReleaseIdentity;
  url: string;
  trackId: string;
  ts: number;
  score: number;
}

export interface DomReleaseCandidate {
  url: string;
  score: number;
  source: string;
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't' | '';
}
