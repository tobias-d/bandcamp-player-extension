import type { KeyAnalysisDebugResult, KeyAnalysisParams, KeyAnalysisResult, TrackMetadata } from '@/shared/types';

export type KeyTuningPanelStatus = 'idle' | 'analyzing' | 'ready' | 'error';

export interface KeyTuningPanelInput {
  status?: KeyTuningPanelStatus;
  statusText?: string;
  debugData?: KeyAnalysisDebugResult | null;
  params?: KeyAnalysisParams;
  url?: string;
  bpm?: number;
  metadata?: Pick<TrackMetadata, 'artistName' | 'trackTitle' | 'albumTitle' | 'confidence'>;
}

export interface KeyTuningPanelHandlers {
  onAnalyzeUrl?: ((url: string, bpm?: number) => void) | null;
  onParamsChange?: ((params: KeyAnalysisParams) => void) | null;
  onUseCurrentTrack?: (() => { url: string; bpm?: number } | null) | null;
  onClose?: (() => void) | null;
}

export interface ReaggregateOutcome {
  result: KeyAnalysisResult;
  hfcCutoff: number;
  preFloorCandidates: Array<{ camelot: string; weight: number }>;
  windowStates: Array<{
    passedPrefilter: boolean;
    prefilterReason: 'pitch-salience' | 'hfc' | null;
    passedEnergyGate: boolean;
    included: boolean;
  }>;
}
