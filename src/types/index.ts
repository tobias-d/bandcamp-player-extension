/**
 * Shared TypeScript types for Bandcamp Player Extension
 */

// ============================================================================
// AUDIO & ANALYSIS TYPES
// ============================================================================

export interface AudioAnalysisRequest {
  audioBuffer: AudioBuffer;
  sampleRate: number;
  options?: AnalysisOptions;
}

export interface AnalysisOptions {
  enableBPM?: boolean;
  enableWaveform?: boolean;
  beatMode?: BeatMode;
}

export type BeatMode = 'straight' | 'breakbeat' | 'auto';

export interface AnalysisResult {
  bpm?: number;
  confidence?: number;
  beatType?: BeatType;
  breakbeatScore?: number;
  waveform?: WaveformData;
  timestamp: number;
}

export type BeatType = 'straight' | 'breakbeat' | 'unknown';

export interface TempoResult {
  bpm: number;
  confidence: number;
  beatTypeAuto: BeatType;
  breakbeatScore: number;
  beatMode: BeatMode;
  _support?: number;  // Internal field
}

// ============================================================================
// WAVEFORM TYPES
// ============================================================================

export interface WaveformData {
  peaks: Float32Array;
  length: number;
  sampleRate?: number;
  duration?: number;
}

export interface WaveformOptions {
  width?: number;
  height?: number;
  samplesPerPixel?: number;
  color?: string;
}

// ============================================================================
// STORAGE TYPES
// ============================================================================

export interface StoredAnalysis {
  trackUrl: string;
  result: AnalysisResult;
  cachedAt: number;
  expiresAt?: number;
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// MESSAGING TYPES
// ============================================================================

export type MessageType = 
  | 'ANALYZE_TRACK'
  | 'ANALYSIS_COMPLETE'
  | 'ANALYSIS_PROGRESS'
  | 'ANALYSIS_ERROR'
  | 'GET_CACHED_RESULT'
  | 'STORE_RESULT'
  | 'CLEAR_CACHE';

export interface Message<T = any> {
  type: MessageType;
  payload: T;
  requestId?: string;
}

export interface AnalyzeTrackMessage {
  audioUrl: string;
  trackInfo?: TrackInfo;
  options?: AnalysisOptions;
}

export interface AnalysisProgressMessage {
  progress: number;
  stage: string;
  preliminaryResult?: Partial<AnalysisResult>;
}

export interface AnalysisErrorMessage {
  error: string;
  details?: string;
}

// ============================================================================
// BANDCAMP TYPES
// ============================================================================

export interface TrackInfo {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  track_num?: number;
  file?: Record<string, string>;
}

export interface TralbumData {
  artist: string;
  current: {
    title: string;
    release_date?: string;
  };
  trackinfo: TrackInfo[];
  url?: string;
}

// ============================================================================
// TEMPO ANALYSIS TYPES (Internal)
// ============================================================================

export interface OnsetResult {
  oenv: Float32Array;
  frameRate: number;
}

export interface TempoCandidateResult {
  bpm: number;
  score: number;
}

export interface TempoCluster {
  center: number;
  items: Array<{ bpm: number; weight: number }>;
  weightSum: number;
}

export interface MeterEvidence {
  bpm: number;
  support: number;
  dom: number;
  score: number;
  beatType: BeatType;
  breakbeatScore: number;
}

// ============================================================================
// UI TYPES
// ============================================================================

export interface ResultsPanelElements {
  container: HTMLElement;
  bpmDisplay?: HTMLElement;
  confidenceBar?: HTMLElement;
  waveformCanvas?: HTMLCanvasElement;
  beatTypeDisplay?: HTMLElement;
}

export interface ResultsPanelOptions {
  showWaveform?: boolean;
  showConfidence?: boolean;
  theme?: 'light' | 'dark';
}
