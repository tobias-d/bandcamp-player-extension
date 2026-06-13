export type ChromeAnalysisHostAction =
  | 'PING'
  | 'ANALYZE_TRACK'
  | 'CANCEL_ANALYSIS'
  | 'ANALYZE_KEY'
  | 'GET_WAVEFORM'
  | 'OPEN_RESOURCE_DIAGNOSTICS_SESSION'
  | 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION'
  | 'GET_RESOURCE_DIAGNOSTICS';

interface ChromeAnalysisHostEnvelope {
  target: 'chrome-analysis-host';
  requestId: string;
}

export type ChromeAnalysisHostRequest =
  | (ChromeAnalysisHostEnvelope & {
    action: 'PING';
    payload?: undefined;
  })
  | (ChromeAnalysisHostEnvelope & {
    action: 'ANALYZE_TRACK';
    payload: {
      url: string;
      fetchUrl?: string;
      cacheKey?: string;
      enableKeyAnalysis?: boolean;
    };
  })
  | (ChromeAnalysisHostEnvelope & {
    action: 'CANCEL_ANALYSIS';
    payload: {
      url?: string;
      cacheKey?: string;
    };
  })
  | (ChromeAnalysisHostEnvelope & {
    action: 'ANALYZE_KEY';
    payload: {
      url: string;
      bpm: number;
      cacheKey?: string;
    };
  })
  | (ChromeAnalysisHostEnvelope & {
    action: 'GET_WAVEFORM';
    payload: {
      url: string;
      fetchUrl?: string;
      cacheKey?: string;
    };
  })
  | (ChromeAnalysisHostEnvelope & {
    action: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION' | 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION' | 'GET_RESOURCE_DIAGNOSTICS';
    payload: {
      sessionId: string;
    };
  });

export interface ChromeAnalysisHostSuccess<T = unknown> extends ChromeAnalysisHostEnvelope {
  ok: true;
  action: ChromeAnalysisHostAction;
  result: T;
}

export interface ChromeAnalysisHostFailure extends ChromeAnalysisHostEnvelope {
  ok: false;
  action: ChromeAnalysisHostAction;
  error: string;
}

export type ChromeAnalysisHostResponse<T = unknown> =
  | ChromeAnalysisHostSuccess<T>
  | ChromeAnalysisHostFailure;
