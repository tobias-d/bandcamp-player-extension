import type { KeySegment } from '@/shared/types';
import type { WindowBounds } from '@/background/key/types';

function toOddAtLeastOne(value: number): number {
  const clamped = Math.max(1, Math.floor(value || 1));
  return clamped % 2 === 1 ? clamped : clamped + 1;
}

export function smoothKeySequence(
  labels: Array<string | null>,
  smoothingWindowSize: number
): Array<string | null> {
  if (!labels.length) {
    return [];
  }

  const size = toOddAtLeastOne(smoothingWindowSize);
  const radius = Math.floor(size / 2);
  const output: Array<string | null> = new Array(labels.length).fill(null);

  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === null) {
      output[i] = null;
      continue;
    }

    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - radius); j <= Math.min(labels.length - 1, i + radius); j += 1) {
      const label = labels[j];
      if (!label) {
        continue;
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    let bestLabel: string | null = labels[i];
    let bestCount = -1;
    for (const [label, count] of counts.entries()) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      } else if (count === bestCount && label === labels[i]) {
        bestLabel = label;
      }
    }

    output[i] = bestLabel;
  }

  return output;
}

export function buildSegments(
  windows: readonly WindowBounds[],
  labels: Array<string | null>,
  sampleRate: number,
  minSegmentWindows: number
): KeySegment[] {
  if (!windows.length || !labels.length || windows.length !== labels.length || sampleRate <= 0) {
    return [];
  }

  const minLen = Math.max(1, Math.floor(minSegmentWindows || 1));
  const segments: KeySegment[] = [];

  let runLabel: string | null = null;
  let runStart = -1;
  let runEnd = -1;

  const flush = (): void => {
    if (!runLabel || runStart < 0 || runEnd < runStart) {
      return;
    }
    const count = runEnd - runStart + 1;
    if (count < minLen) {
      return;
    }

    const first = windows[runStart];
    const last = windows[runEnd];
    segments.push({
      startSeconds: first.startSample / sampleRate,
      endSeconds: last.endSample / sampleRate,
      camelot: runLabel
    });
  };

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (!label) {
      flush();
      runLabel = null;
      runStart = -1;
      runEnd = -1;
      continue;
    }

    if (runLabel === label) {
      runEnd = i;
      continue;
    }

    flush();
    runLabel = label;
    runStart = i;
    runEnd = i;
  }

  flush();

  const unique = new Set(segments.map((segment) => segment.camelot));
  if (unique.size <= 1) {
    return [];
  }

  return segments;
}
