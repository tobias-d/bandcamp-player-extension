const PROVISIONAL_LOW_BAND_MIN_BPM = 80;
const PROVISIONAL_LOW_BAND_MAX_BPM = 110;

function isFiniteTempoValue(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isRefiningTempoStatus(status: string | undefined): boolean {
  return String(status || '').trim().toLowerCase().includes('refining');
}

export function shouldSuppressProvisionalLowBandTempo(
  bpm: number | undefined,
  options?: { isAnalyzing?: boolean; analysisStatus?: string }
): boolean {
  if (!isFiniteTempoValue(bpm)) {
    return false;
  }

  const isAnalyzing = Boolean(options?.isAnalyzing);
  const isRefining = isRefiningTempoStatus(options?.analysisStatus);
  if (!isAnalyzing && !isRefining) {
    return false;
  }

  return bpm >= PROVISIONAL_LOW_BAND_MIN_BPM && bpm <= PROVISIONAL_LOW_BAND_MAX_BPM;
}
