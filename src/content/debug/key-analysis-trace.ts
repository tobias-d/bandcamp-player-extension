export interface KeyAnalysisTraceEntry {
  ts: number;
  stage: string;
  detail: string;
}

const MAX_TRACE_ENTRIES = 80;

export function appendKeyAnalysisTrace(
  trace: KeyAnalysisTraceEntry[],
  stage: string,
  detail: string,
  ts = Date.now()
): void {
  trace.push({
    ts: Number.isFinite(ts) ? ts : Date.now(),
    stage: String(stage || '-'),
    detail: String(detail || '-')
  });
  if (trace.length > MAX_TRACE_ENTRIES) {
    trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
  }
}

export function clearKeyAnalysisTrace(trace: KeyAnalysisTraceEntry[]): void {
  if (trace.length > 0) {
    trace.splice(0, trace.length);
  }
}
