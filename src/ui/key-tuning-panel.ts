import type { KeyAnalysisDebugResult, KeyAnalysisParams } from '@/shared/types';
import { evaluateDecision } from '@/ui/key-tuning/decision';
import { ensureKeyTuningPanel, isKeyTuningPanelOpen, removeKeyTuningPanel, type KeyTuningRefs } from '@/ui/key-tuning/dom';
import { parseReferenceCamelot } from '@/ui/key-tuning/reference';
import { reaggregate } from '@/ui/key-tuning/reaggregate';
import { renderAgreement, renderParams, renderResult, renderSliderValues, renderStatus, renderWindowTable } from '@/ui/key-tuning/render';
import type { KeyTuningPanelHandlers, KeyTuningPanelInput } from '@/ui/key-tuning/types';

const DEFAULT_KEY_PARAMS: Readonly<KeyAnalysisParams> = {
  windowBeats: 64,
  hopBeats: 32,
  pitchSalienceThreshold: 0.24,
  hfcPercentileThreshold: 0.7,
  prefilterFrameCount: 3,
  relativeEnergyGate: 0.35,
  reliabilityFloor: 0.25,
  dualCenterGapThreshold: 0.12,
  minCandidateWeight: 5,
  smoothingWindowSize: 3,
  minSegmentWindows: 2,
  profileType: 'edma',
  pcpSize: 36,
  profileMix: false,
  rankMode: 'baseline'
};
const PARAMS_STORAGE_KEY = '__BC_KEY_TUNING_PARAMS__';

let refs: KeyTuningRefs | null = null;
let bound = false;
let heldDebugData: KeyAnalysisDebugResult | null = null;
let heldParams: KeyAnalysisParams = resolveInitialParams();
let heldHandlers: KeyTuningPanelHandlers = {};
let heldMetadata: KeyTuningPanelInput['metadata'] | null = null;
let windowSortColumn: 'index' | 'keyStr' | 'key' | 'weight' = 'index';
let windowSortDirection: 'asc' | 'desc' = 'asc';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sanitizeParams(raw?: Partial<KeyAnalysisParams> | null): KeyAnalysisParams {
  const source = raw || {};
  const smoothing = Math.max(1, Math.floor(Number(source.smoothingWindowSize ?? DEFAULT_KEY_PARAMS.smoothingWindowSize)));
  return {
    windowBeats: Math.max(1, Math.floor(Number(source.windowBeats ?? DEFAULT_KEY_PARAMS.windowBeats))),
    hopBeats: Math.max(1, Math.floor(Number(source.hopBeats ?? DEFAULT_KEY_PARAMS.hopBeats))),
    pitchSalienceThreshold: clamp(Number(source.pitchSalienceThreshold ?? DEFAULT_KEY_PARAMS.pitchSalienceThreshold), 0, 1),
    hfcPercentileThreshold: clamp(Number(source.hfcPercentileThreshold ?? DEFAULT_KEY_PARAMS.hfcPercentileThreshold), 0, 1),
    prefilterFrameCount: Math.max(1, Math.floor(Number(source.prefilterFrameCount ?? DEFAULT_KEY_PARAMS.prefilterFrameCount))),
    relativeEnergyGate: clamp(Number(source.relativeEnergyGate ?? DEFAULT_KEY_PARAMS.relativeEnergyGate), 0, 1),
    reliabilityFloor: clamp(Number(source.reliabilityFloor ?? DEFAULT_KEY_PARAMS.reliabilityFloor), 0, 1),
    dualCenterGapThreshold: clamp(Number(source.dualCenterGapThreshold ?? DEFAULT_KEY_PARAMS.dualCenterGapThreshold), 0, 1),
    minCandidateWeight: Math.max(0, Math.floor(Number(source.minCandidateWeight ?? DEFAULT_KEY_PARAMS.minCandidateWeight))),
    smoothingWindowSize: smoothing % 2 === 0 ? smoothing + 1 : smoothing,
    minSegmentWindows: Math.max(1, Math.floor(Number(source.minSegmentWindows ?? DEFAULT_KEY_PARAMS.minSegmentWindows))),
    profileType: String(source.profileType ?? DEFAULT_KEY_PARAMS.profileType ?? 'edma'),
    pcpSize: Number(source.pcpSize) === 12 ? 12 : 36,
    profileMix: Boolean(source.profileMix),
    rankMode: source.rankMode === 'consensus' ? 'consensus' : 'baseline'
  };
}

function readPersistedParams(): KeyAnalysisParams | null {
  try {
    const raw = window.localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KeyAnalysisParams>;
    return sanitizeParams(parsed);
  } catch (error) {
    console.warn('[key-tuning-panel] failed to read persisted params', error);
    return null;
  }
}

function writePersistedParams(params: KeyAnalysisParams): void {
  try {
    window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(sanitizeParams(params)));
  } catch (error) {
    console.warn('[key-tuning-panel] failed to persist params', error);
  }
}

function resolveInitialParams(): KeyAnalysisParams {
  const persisted = readPersistedParams();
  return persisted || { ...DEFAULT_KEY_PARAMS };
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function getWindowCamelot(windowRow: KeyAnalysisDebugResult['windows'][number]): string | null {
  if (windowRow.camelot) return windowRow.camelot;
  if (windowRow.key && windowRow.scale) {
    return parseReferenceCamelot(`${windowRow.key} ${windowRow.scale}`);
  }
  return null;
}

function metadataText(metadata: KeyTuningPanelInput['metadata'] | null | undefined): string {
  if (!metadata) return 'Track: -';
  const artist = String(metadata.artistName || '').trim() || '-';
  const title = String(metadata.trackTitle || '').trim() || '-';
  const album = String(metadata.albumTitle || '').trim() || '-';
  const confidence = String(metadata.confidence || '').trim() || 'low';
  return `Track: ${artist} - ${title} | Album: ${album} | Metadata: ${confidence}`;
}

function buildCompactSummary(): string | null {
  if (!refs || !heldDebugData) {
    return null;
  }
  const debugData = heldDebugData;
  const outcome = reaggregate(debugData, heldParams);
  const reference = parseReferenceCamelot(refs.referenceInput.value) || '-';
  const top = outcome.result.topKeys.length
    ? outcome.result.topKeys.map((k, idx) => `${idx + 1}) ${k.camelot} (${fmt(k.weight, 2)}%)`).join(' | ')
    : 'no candidates';
  const top1 = outcome.result.topKeys[0] || null;
  const top2 = outcome.result.topKeys[1] || null;
  const absoluteGap = top1 && top2 ? Math.max(0, top1.weight - top2.weight) : Infinity;
  const relativeGap = top1 && top2 && top1.weight > 0 ? absoluteGap / top1.weight : Infinity;
  const decision = evaluateDecision(outcome.result, reference);

  const bins = new Map<string, { count: number; sumWeight: number }>();
  outcome.windowStates.forEach((state, index) => {
    if (!state.included) return;
    const row = debugData.windows[index];
    const camelot = getWindowCamelot(row);
    if (!camelot) return;
    const weight = Number(row.combinedWeight ?? 0);
    const entry = bins.get(camelot) || { count: 0, sumWeight: 0 };
    entry.count += 1;
    entry.sumWeight += Number.isFinite(weight) ? weight : 0;
    bins.set(camelot, entry);
  });

  const distribution = Array.from(bins.entries())
    .sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      return b[1].sumWeight - a[1].sumWeight;
    })
    .slice(0, 5)
    .map(([camelot, data]) => `${camelot} x${data.count} avgW=${fmt(data.sumWeight / Math.max(1, data.count), 2)}`)
    .join(', ');
  const allWindows = debugData.windows
    .map((w, index) => `${index}:${getWindowCamelot(w) || '-'}:${w.combinedWeight === null ? '-' : fmt(w.combinedWeight, 2)}`)
    .join(' | ');

  return [
    `Track: ${metadataText(heldMetadata).replace(/^Track:\s*/, '')}`,
    `URL: ${String(refs.urlInput.value || '').trim() || '-'}`,
    `Ref: ${reference}`,
    `Result: ${top}`,
    `Ambiguous: ${decision.ambiguous ? 'yes' : 'no'}${top1 && top2 ? ` | topGap=${fmt(absoluteGap, 2)}% relGap=${fmt(relativeGap, 3)}` : ''}`,
    `Decision: ${decision.decision}`,
    `Reliability: ${fmt(outcome.result.reliability)} | windows ${outcome.result.windowsAnalyzed}/${outcome.result.windowsTotal} | dual-center ${outcome.result.dualCenter ? 'yes' : 'no'}`,
    `WindowDist: ${distribution || '-'}`,
    `AllWindows: ${allWindows || '-'}`,
    `Params: profile=${heldParams.profileType} mix=${heldParams.profileMix ? 'on' : 'off'} rank=${heldParams.rankMode} pcp=${heldParams.pcpSize} pitch=${fmt(heldParams.pitchSalienceThreshold, 2)} hfc=${fmt(heldParams.hfcPercentileThreshold, 2)} energy=${fmt(heldParams.relativeEnergyGate, 2)} floor=${fmt(heldParams.reliabilityFloor, 2)} minW=${heldParams.minCandidateWeight}`
  ].join('\n');
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (error) {
    console.warn('[key-tuning-panel] navigator.clipboard.writeText failed', error);
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) {
    throw new Error('execCommand(copy) failed');
  }
}

function readParamsFromUi(current: KeyAnalysisParams): KeyAnalysisParams {
  if (!refs) return current;
  const oddSmooth = Math.max(1, Math.floor(Number(refs.sliderSmoothing.value) / 2) * 2 + 1);
  refs.sliderSmoothing.value = String(oddSmooth);

  return {
    ...current,
    pitchSalienceThreshold: Number(refs.sliderPitchSalience.value),
    hfcPercentileThreshold: Number(refs.sliderHfc.value),
    prefilterFrameCount: Math.max(1, Math.floor(Number(refs.sliderPrefilterFrames.value))),
    relativeEnergyGate: Number(refs.sliderEnergyGate.value),
    reliabilityFloor: Number(refs.sliderReliabilityFloor.value),
    dualCenterGapThreshold: Number(refs.sliderDualCenter.value),
    minCandidateWeight: Math.max(0, Math.floor(Number(refs.sliderMinCandidateWeight.value))),
    smoothingWindowSize: oddSmooth,
    minSegmentWindows: Math.max(1, Math.floor(Number(refs.sliderMinSegment.value))),
    profileType: String(refs.selectProfile.value || 'edma'),
    pcpSize: Number(refs.selectPcpSize.value) === 12 ? 12 : 36,
    profileMix: refs.selectProfileMix.value === 'on',
    rankMode: refs.selectRankMode.value === 'consensus' ? 'consensus' : 'baseline'
  };
}

function rerender(): void {
  if (!refs) return;

  const statusText = refs.status.textContent || '';
  renderStatus(refs, statusText);
  renderParams(refs, heldParams);
  refs.metadata.textContent = metadataText(heldMetadata);

  if (!heldDebugData) {
    refs.controls.hidden = true;
    refs.result.textContent = 'Run analyze to populate windows.';
    refs.windowTable.replaceChildren();
    renderSliderValues(refs, heldParams, null);
    renderAgreement(refs, {
      topKeys: [], dualCenter: false, segments: [], method: 'essentia-hpcp-key', windowsAnalyzed: 0, windowsTotal: 0, reliability: 0
    }, null);
    return;
  }

  refs.controls.hidden = false;
  const outcome = reaggregate(heldDebugData, heldParams);
  const referenceCamelot = parseReferenceCamelot(refs.referenceInput.value);
  const windowCandidates = heldDebugData.windows.flatMap((w) => {
    const list: string[] = [];
    if (w.camelot) list.push(w.camelot);
    if (w.key && w.scale) list.push(`${w.key} ${w.scale}`);
    return list;
  });
  const aggregateCamelots = outcome.preFloorCandidates.map((c) => c.camelot);
  renderSliderValues(refs, heldParams, outcome);
  renderResult(refs, outcome.result, heldParams, referenceCamelot);
  renderWindowTable(refs, heldDebugData, outcome, windowSortColumn, windowSortDirection, referenceCamelot);
  renderAgreement(
    refs,
    outcome.result,
    referenceCamelot,
    [...new Set([...aggregateCamelots, ...windowCandidates])]
  );
}

function bindEvents(): void {
  if (!refs || bound) return;
  bound = true;

  refs.closeBtn.addEventListener('click', () => heldHandlers.onClose?.());
  refs.analyzeBtn.addEventListener('click', () => {
    const url = String(refs?.urlInput.value || '').trim();
    if (!url) {
      renderStatus(refs!, 'Enter a track URL first.');
      return;
    }
    const bpmRaw = Number(refs?.bpmInput.value);
    heldHandlers.onAnalyzeUrl?.(url, Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : undefined);
  });
  refs.useCurrentBtn.addEventListener('click', () => {
    const current = heldHandlers.onUseCurrentTrack?.();
    if (!current?.url) {
      renderStatus(refs!, 'No current track URL available.');
      return;
    }
    refs!.urlInput.value = String(current.url || '').trim();
    if (typeof current.bpm === 'number' && Number.isFinite(current.bpm) && current.bpm > 0) {
      refs!.bpmInput.value = String(Math.round(current.bpm));
    }
    renderStatus(refs!, 'Loaded current track into inputs.');
  });
  refs.copySummaryBtn.addEventListener('click', () => {
    const text = buildCompactSummary();
    if (!text) {
      renderStatus(refs!, 'No analyzed data to copy yet.');
      return;
    }
    void copyTextToClipboard(text)
      .then(() => {
        renderStatus(refs!, 'Copied compact summary to clipboard.');
      })
      .catch((error) => {
        console.error('[key-tuning-panel] copy summary failed', error);
        renderStatus(refs!, `Copy failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  const onParamChange = (): void => {
    heldParams = sanitizeParams(readParamsFromUi(heldParams));
    writePersistedParams(heldParams);
    heldHandlers.onParamsChange?.(heldParams);
    rerender();
  };

  [
    refs.sliderPitchSalience,
    refs.sliderHfc,
    refs.sliderPrefilterFrames,
    refs.sliderEnergyGate,
    refs.sliderReliabilityFloor,
    refs.sliderDualCenter,
    refs.sliderMinCandidateWeight,
    refs.sliderSmoothing,
    refs.sliderMinSegment,
    refs.selectProfile,
    refs.selectProfileMix,
    refs.selectPcpSize,
    refs.selectRankMode
  ].forEach((el) => el.addEventListener('input', onParamChange));

  refs.referenceInput.addEventListener('input', () => rerender());
  refs.windowTable.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    const sort = target.getAttribute('data-sort') as 'index' | 'keyStr' | 'key' | 'weight' | null;
    if (!sort) {
      return;
    }
    if (windowSortColumn === sort) {
      windowSortDirection = windowSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      windowSortColumn = sort;
      windowSortDirection = sort === 'index' ? 'asc' : 'desc';
    }
    rerender();
  });
  refs.resetBtn.addEventListener('click', () => {
    heldParams = { ...DEFAULT_KEY_PARAMS };
    writePersistedParams(heldParams);
    heldHandlers.onParamsChange?.(heldParams);
    renderStatus(refs!, 'Reset to default values.');
    rerender();
  });
}

export function showKeyTuningPanel(input: KeyTuningPanelInput, handlers: KeyTuningPanelHandlers): void {
  refs = ensureKeyTuningPanel();
  heldHandlers = handlers;

  if (input.params) heldParams = sanitizeParams({ ...heldParams, ...input.params });
  if (input.debugData) heldDebugData = input.debugData;
  if (typeof input.url === 'string' && !refs.urlInput.value.trim()) {
    refs.urlInput.value = input.url.trim();
  }
  if (typeof input.bpm === 'number' && Number.isFinite(input.bpm) && input.bpm > 0 && !refs.bpmInput.value.trim()) {
    refs.bpmInput.value = String(Math.round(input.bpm));
  }
  if (input.metadata) {
    heldMetadata = { ...input.metadata };
  }

  renderStatus(refs, input.statusText || (input.status === 'analyzing' ? 'Analyzing...' : 'Ready'));
  bindEvents();
  rerender();
}

export function hideKeyTuningPanel(): void {
  removeKeyTuningPanel();
  refs = null;
  bound = false;
}

export function isKeyTuningVisible(): boolean {
  return isKeyTuningPanelOpen();
}

export function getDefaultKeyParams(): KeyAnalysisParams {
  return resolveInitialParams();
}
