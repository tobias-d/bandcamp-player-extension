export interface WindowBounds {
  index: number;
  startSample: number;
  endSample: number;
}

export interface PrefilterResult {
  pitchSalience: number;
  hfc: number;
  dissonance: number;
}

export interface HPCPResult {
  meanHPCP: Float32Array;
  harmonicEnergy: number;
}

export interface HPCPFrameResult {
  startSample: number;
  endSample: number;
  hpcp: Float32Array;
  harmonicEnergy: number;
}

export interface HPCPFrameStageTiming {
  frameCount: number;
  vectorMs: number;
  windowingMs: number;
  spectrumMs: number;
  peaksMs: number;
  whiteningMs: number;
  hpcpMs: number;
  extractMs: number;
}

export interface KeyScoreResult {
  key: string;
  scale: string;
  camelot: string | null;
  keyStrength: number;
  firstToSecondRelativeStrength: number;
  combinedWeight: number;
}
