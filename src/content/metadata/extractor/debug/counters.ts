export interface MetadataPathCountersSnapshot {
  apiCandidateStrictAccepted: number;
  apiCandidateRejected: number;
  fallbackUsed: number;
  lastDecision: string;
}

const counters: MetadataPathCountersSnapshot = {
  apiCandidateStrictAccepted: 0,
  apiCandidateRejected: 0,
  fallbackUsed: 0,
  lastDecision: '-'
};

let lastDecisionKey = '';

export function noteMetadataPathDecision(input: {
  pageType: string;
  trackId: string;
  strictAccepted: boolean;
  strictRejected: boolean;
  fallbackUsed: boolean;
  titleSource: string;
  artistSource: string;
  albumSource: string;
  selectedTrackReason: string;
}): void {
  const pageType = String(input.pageType || '').trim() || '-';
  const trackId = String(input.trackId || '').trim() || '-';
  const titleSource = String(input.titleSource || '').trim() || '-';
  const artistSource = String(input.artistSource || '').trim() || '-';
  const albumSource = String(input.albumSource || '').trim() || '-';
  const selectedTrackReason = String(input.selectedTrackReason || '').trim() || '-';

  const decisionKey = [
    pageType,
    trackId,
    input.strictAccepted ? '1' : '0',
    input.strictRejected ? '1' : '0',
    input.fallbackUsed ? '1' : '0',
    selectedTrackReason,
    titleSource,
    artistSource,
    albumSource
  ].join('|');

  if (decisionKey === lastDecisionKey) {
    return;
  }
  lastDecisionKey = decisionKey;

  if (input.strictAccepted) {
    counters.apiCandidateStrictAccepted += 1;
  }
  if (input.strictRejected) {
    counters.apiCandidateRejected += 1;
  }
  if (input.fallbackUsed) {
    counters.fallbackUsed += 1;
  }

  counters.lastDecision =
    `track=${trackId} page=${pageType} strict=${input.strictAccepted ? 'accepted' : input.strictRejected ? 'rejected' : '-'} ` +
    `fallback=${input.fallbackUsed ? '1' : '0'} reason=${selectedTrackReason} ` +
    `src=t:${titleSource}|a:${artistSource}|al:${albumSource}`;
}

export function getMetadataPathCountersSnapshot(): MetadataPathCountersSnapshot {
  return {
    ...counters
  };
}
