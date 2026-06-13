import type { KeyAnalysisParams } from '@/shared/types';
import type { WindowBounds } from '@/background/key/types';

export function generateWindows(
  signalLength: number,
  sampleRate: number,
  bpm: number,
  adaptiveStartSample: number,
  params: KeyAnalysisParams
): WindowBounds[] {
  if (!Number.isFinite(signalLength) || signalLength <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return [];
  }

  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secondsPerBeat = 60 / safeBpm;
  const windowSamples = Math.max(1, Math.floor(params.windowBeats * secondsPerBeat * sampleRate));
  const hopSamples = Math.max(1, Math.floor(params.hopBeats * secondsPerBeat * sampleRate));
  const start = Math.max(0, Math.floor(adaptiveStartSample || 0));

  if (start + windowSamples > signalLength) {
    return [];
  }

  const windows: WindowBounds[] = [];
  let index = 0;
  for (let ws = start; ws + windowSamples <= signalLength; ws += hopSamples) {
    windows.push({
      index,
      startSample: ws,
      endSample: ws + windowSamples
    });
    index += 1;
  }

  return windows;
}
