import type { KeyAnalysisDebugResult, KeyAnalysisParams, KeyAnalysisResult } from '@/shared/types';
import { evaluateDecision } from '@/ui/key-tuning/decision';
import type { KeyTuningRefs } from '@/ui/key-tuning/dom';
import type { ReaggregateOutcome } from '@/ui/key-tuning/types';

type SortColumn = 'index' | 'keyStr' | 'key' | 'weight';
type SortDirection = 'asc' | 'desc';

const KEY_NAME_TO_CAMELOT = new Map<string, string>([
  ['am', '8A'], ['a min', '8A'], ['a minor', '8A'], ['cm', '5A'], ['c minor', '5A'],
  ['em', '9A'], ['e minor', '9A'], ['bm', '10A'], ['b minor', '10A'], ['f#m', '11A'],
  ['f# minor', '11A'], ['g#m', '1A'], ['g# minor', '1A'], ['bbm', '3A'], ['bb minor', '3A'],
  ['dm', '7A'], ['d minor', '7A'], ['gm', '6A'], ['g minor', '6A'], ['c#m', '12A'],
  ['c# minor', '12A'], ['fm', '4A'], ['f minor', '4A'], ['c', '8B'], ['c maj', '8B'],
  ['c major', '8B'], ['g', '9B'], ['g major', '9B'], ['d', '10B'], ['d major', '10B'],
  ['a', '11B'], ['a major', '11B'], ['e', '12B'], ['e major', '12B'], ['b', '1B'],
  ['b major', '1B'], ['f#', '2B'], ['f# major', '2B'], ['db', '3B'], ['db major', '3B'],
  ['ab', '4B'], ['ab major', '4B'], ['eb', '5B'], ['eb major', '5B'], ['bb', '6B'],
  ['bb major', '6B'], ['f', '7B'], ['f major', '7B']
]);

function normalizeCamelot(raw: string | null | undefined): string | null {
  const stripped = String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  const value = stripped.toUpperCase();
  if (!value) return null;
  const exact = value.match(/^(1[0-2]|[1-9])\s*([AB])$/);
  if (exact) return `${exact[1]}${exact[2]}`;
  const embedded = value.match(/(?:^|[^0-9])(1[0-2]|[1-9])\s*([AB])(?:$|[^A-Z])/);
  if (embedded) return `${embedded[1]}${embedded[2]}`;
  const normalizedName = stripped.toLowerCase().replace(/\s+/g, ' ');
  return KEY_NAME_TO_CAMELOT.get(normalizedName) || null;
}

function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '0';
}

function fmtTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function renderParams(refs: KeyTuningRefs, params: KeyAnalysisParams): void {
  refs.sliderPitchSalience.value = String(params.pitchSalienceThreshold);
  refs.sliderHfc.value = String(params.hfcPercentileThreshold);
  refs.sliderPrefilterFrames.value = String(params.prefilterFrameCount);
  refs.sliderEnergyGate.value = String(params.relativeEnergyGate);
  refs.sliderReliabilityFloor.value = String(params.reliabilityFloor);
  refs.sliderDualCenter.value = String(params.dualCenterGapThreshold);
  refs.sliderMinCandidateWeight.value = String(params.minCandidateWeight);
  refs.sliderSmoothing.value = String(params.smoothingWindowSize);
  refs.sliderMinSegment.value = String(params.minSegmentWindows);
  refs.selectProfile.value = params.profileType;
  refs.selectProfileMix.value = params.profileMix ? 'on' : 'off';
  refs.selectPcpSize.value = String(params.pcpSize);
  refs.selectRankMode.value = params.rankMode || 'baseline';
}

export function renderSliderValues(refs: KeyTuningRefs, params: KeyAnalysisParams, outcome: ReaggregateOutcome | null): void {
  const candidates = (outcome?.preFloorCandidates || []).slice(0, 5).map((c) => `${c.camelot}:${fmt(c.weight, 1)}`).join(', ');
  refs.sliderValues.textContent = [
    `Pitch ${fmt(params.pitchSalienceThreshold)}`,
    `HFC ${fmt(params.hfcPercentileThreshold)}`,
    `Frames ${params.prefilterFrameCount}`,
    `Energy ${fmt(params.relativeEnergyGate)}`,
    `Floor ${fmt(params.reliabilityFloor)}`,
    `Dual ${fmt(params.dualCenterGapThreshold)}`,
    `MinWeight ${params.minCandidateWeight}`,
    `Smooth ${params.smoothingWindowSize}`,
    `MinSeg ${params.minSegmentWindows}`,
    `Profile ${params.profileType}`,
    `Mix ${params.profileMix ? 'on' : 'off'}`,
    `pcpSize ${params.pcpSize}`,
    `Rank ${params.rankMode || 'baseline'}`,
    candidates ? `Pre-floor ${candidates}` : ''
  ].filter(Boolean).join(' | ');
}

export function renderStatus(refs: KeyTuningRefs, text: string): void {
  refs.status.textContent = text;
}

export function renderResult(
  refs: KeyTuningRefs,
  result: KeyAnalysisResult,
  params: KeyAnalysisParams,
  referenceCamelot?: string | null
): void {
  const decision = evaluateDecision(result, normalizeCamelot(referenceCamelot));
  if (result.reliability < params.reliabilityFloor) {
    refs.result.textContent = `below reliability floor (${fmt(result.reliability, 3)} < ${fmt(params.reliabilityFloor, 3)}) | decision ${decision.decision}`;
    return;
  }

  const keys = result.topKeys.map((k, idx) => `${idx + 1}) ${k.camelot} (${fmt(k.weight, 2)}%)`).join(' | ');
  refs.result.textContent = `${keys || 'no candidates'} | reliability ${fmt(result.reliability, 3)} | windows ${result.windowsAnalyzed}/${result.windowsTotal} | dual-center ${result.dualCenter ? 'yes' : 'no'} | decision ${decision.decision}`;
}

export function renderAgreement(
  refs: KeyTuningRefs,
  result: KeyAnalysisResult,
  referenceCamelot: string | null,
  allCandidates?: readonly string[]
): void {
  const reference = normalizeCamelot(referenceCamelot);
  if (!reference) {
    refs.agreement.hidden = true;
    refs.agreement.textContent = '';
    return;
  }

  refs.agreement.hidden = false;
  if (!result.topKeys.length) {
    refs.agreement.textContent = 'no output';
    return;
  }
  if (normalizeCamelot(result.topKeys[0].camelot) === reference) {
    refs.agreement.textContent = 'top-1 match';
    return;
  }
  if (result.topKeys.some((k) => normalizeCamelot(k.camelot) === reference)) {
    refs.agreement.textContent = 'in top-3';
    return;
  }
  if ((allCandidates || []).some((candidate) => normalizeCamelot(candidate) === reference)) {
    refs.agreement.textContent = 'present (outside top-3)';
    return;
  }
  refs.agreement.textContent = 'no match';
}

export function renderWindowTable(
  refs: KeyTuningRefs,
  data: KeyAnalysisDebugResult,
  outcome: ReaggregateOutcome,
  sortColumn: SortColumn,
  sortDirection: SortDirection,
  referenceCamelot?: string | null
): void {
  const reference = normalizeCamelot(referenceCamelot);
  const compare = (a: number, b: number): number => {
    const wa = data.windows[a];
    const wb = data.windows[b];
    if (sortColumn === 'index') {
      return a - b;
    }
    if (sortColumn === 'keyStr') {
      return (wa.keyStrength ?? -Infinity) - (wb.keyStrength ?? -Infinity);
    }
    if (sortColumn === 'weight') {
      return (wa.combinedWeight ?? -Infinity) - (wb.combinedWeight ?? -Infinity);
    }
    const ka = (wa.camelot || (wa.key && wa.scale ? `${wa.key} ${wa.scale}` : '')).toLowerCase();
    const kb = (wb.camelot || (wb.key && wb.scale ? `${wb.key} ${wb.scale}` : '')).toLowerCase();
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  };

  const sorted = data.windows.map((_w, i) => i).sort((a, b) => {
    const c = compare(a, b);
    return sortDirection === 'asc' ? c : -c;
  });

  const arrow = (column: SortColumn): string =>
    sortColumn === column ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const makeTh = (label: string, sortKey?: SortColumn): HTMLTableCellElement => {
    const th = document.createElement('th');
    if (sortKey) {
      th.dataset.sort = sortKey;
      th.textContent = `${label}${arrow(sortKey)}`;
    } else {
      th.textContent = label;
    }
    return th;
  };

  headerRow.append(
    makeTh('#', 'index'),
    makeTh('Time'),
    makeTh('PitchSal'),
    makeTh('HFC'),
    makeTh('HFC%'),
    makeTh('Diss'),
    makeTh('Filter'),
    makeTh('keyStr', 'keyStr'),
    makeTh('Key', 'key'),
    makeTh('Weight', 'weight')
  );
  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');

  sorted.forEach((i) => {
    const w = data.windows[i];
    const state = outcome.windowStates[i];
    const rowCamelot = normalizeCamelot(w.camelot || (w.key && w.scale ? `${w.key} ${w.scale}` : null));
    const isMatch = Boolean(reference && rowCamelot && rowCamelot === reference);
    const filter = !state
      ? '—'
      : (!state.passedPrefilter
        ? (state.prefilterReason === 'pitch-salience' ? 'SKIP (pitch)' : 'SKIP (hfc)')
        : (state.passedEnergyGate ? 'PASS' : 'SKIP (energy)'));
    const rowClasses = [
      state && !state.included ? 'bc-muted' : '',
      isMatch ? 'bc-key-match' : ''
    ].filter(Boolean).join(' ');
    const row = document.createElement('tr');
    row.dataset.index = String(i);
    if (rowClasses) {
      row.className = rowClasses;
    }

    const cells = [
      String(i),
      `${fmtTime(w.startSeconds)}-${fmtTime(w.endSeconds)}`,
      fmt(w.pitchSalience),
      fmt(w.hfc),
      fmt(w.hfcPercentile),
      fmt(w.dissonance),
      filter,
      w.keyStrength === null ? '—' : fmt(w.keyStrength, 3),
      w.camelot || (w.key && w.scale ? `${w.key} ${w.scale}` : '—'),
      w.combinedWeight === null ? '—' : fmt(w.combinedWeight, 3)
    ];

    cells.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  refs.windowTable.replaceChildren(table);
}
