import { dom, injectStylesheet } from '@/utils/dom';

const STYLE_ID = 'bc-key-tuning-style';
const PANEL_ID = 'bc-key-tuning-panel';
const POS_KEY = '__BC_KEY_TUNING_PANEL_POS__';

export interface KeyTuningRefs {
  container: HTMLDivElement;
  dragHandle: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  urlInput: HTMLInputElement;
  bpmInput: HTMLInputElement;
  analyzeBtn: HTMLButtonElement;
  useCurrentBtn: HTMLButtonElement;
  copySummaryBtn: HTMLButtonElement;
  metadata: HTMLDivElement;
  status: HTMLDivElement;
  controls: HTMLDivElement;
  sliderPitchSalience: HTMLInputElement;
  sliderHfc: HTMLInputElement;
  sliderPrefilterFrames: HTMLInputElement;
  sliderEnergyGate: HTMLInputElement;
  sliderReliabilityFloor: HTMLInputElement;
  sliderDualCenter: HTMLInputElement;
  sliderMinCandidateWeight: HTMLInputElement;
  sliderSmoothing: HTMLInputElement;
  sliderMinSegment: HTMLInputElement;
  selectProfile: HTMLSelectElement;
  selectProfileMix: HTMLSelectElement;
  selectPcpSize: HTMLSelectElement;
  selectRankMode: HTMLSelectElement;
  sliderValues: HTMLDivElement;
  resetBtn: HTMLButtonElement;
  result: HTMLDivElement;
  referenceInput: HTMLInputElement;
  agreement: HTMLDivElement;
  windowTable: HTMLDivElement;
}

function getEl<T extends HTMLElement>(root: ParentNode, role: string): T {
  const found = root.querySelector(`[data-role="${role}"]`);
  if (!found) throw new Error(`Missing key tuning role: ${role}`);
  return found as T;
}

function readPos(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
    const left = Number(parsed.left);
    const top = Number(parsed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}

function writePos(left: number, top: number): void {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // Ignore storage failures.
  }
}

function attachDrag(container: HTMLDivElement, handle: HTMLDivElement): () => void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;

  const onDown = (event: MouseEvent): void => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = container.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    container.style.right = 'auto';
    event.preventDefault();
  };

  const onMove = (event: MouseEvent): void => {
    if (!dragging) return;
    const left = baseLeft + (event.clientX - startX);
    const top = baseTop + (event.clientY - startY);
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    const rect = container.getBoundingClientRect();
    writePos(rect.left, rect.top);
  };

  handle.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  return () => {
    handle.removeEventListener('mousedown', onDown);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}

function ensureStyle(): void {
  injectStylesheet(STYLE_ID, `
#${PANEL_ID}{position:fixed;top:78px;right:20px;z-index:2147483000;width:min(94vw,720px);max-height:84vh;background:rgba(16,18,22,.62);-webkit-backdrop-filter:blur(14px) saturate(135%);backdrop-filter:blur(14px) saturate(135%);color:#edf1f7;border:1px solid rgba(255,255,255,.22);border-radius:18px;font:12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 22px 58px rgba(0,0,0,.48);display:flex;flex-direction:column;overflow:hidden}
#${PANEL_ID} [data-role="keyTuningDragHandle"]{padding:14px 16px;background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.14);cursor:move;display:flex;justify-content:space-between;align-items:center}
#${PANEL_ID} [data-role="keyTuningMetadata"],#${PANEL_ID} [data-role="keyTuningStatus"],#${PANEL_ID} [data-role="keyTuningResult"],#${PANEL_ID} [data-role="keyTuningSliderValues"],#${PANEL_ID} [data-role="keyTuningAgreement"]{padding:12px 16px}
#${PANEL_ID} [data-role="keyTuningMetadata"]{padding-top:8px;padding-bottom:0;opacity:.9}
#${PANEL_ID} .bc-key-row{display:flex;gap:12px;padding:12px 16px;align-items:center}
#${PANEL_ID} input,#${PANEL_ID} select,#${PANEL_ID} button{font:inherit}
#${PANEL_ID} input:not([type="range"]),#${PANEL_ID} select{background:rgba(7,10,14,.42);color:#f3f7ff;border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:7px 9px}
#${PANEL_ID} input[type="range"]{width:130px;padding:0;margin-top:4px}
#${PANEL_ID} [data-role="keyTuningControls"] label{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
#${PANEL_ID} button{background:rgba(255,255,255,.12);color:#f3f7ff;border:1px solid rgba(255,255,255,.26);border-radius:10px;padding:7px 11px;line-height:1.2}
#${PANEL_ID} [data-role="keyTuningControls"]{overflow:auto;border-top:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14)}
#${PANEL_ID} [data-role="keyTuningWindowTable"]{max-height:260px;overflow:auto;border-top:1px solid rgba(255,255,255,.14);padding:2px 12px 12px}
#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:11px}
#${PANEL_ID} th,#${PANEL_ID} td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left;white-space:nowrap}
#${PANEL_ID} tr.bc-muted{opacity:.45}
#${PANEL_ID} tr.bc-key-match td{color:#43d17a;font-weight:600}
`);
}

export function ensureKeyTuningPanel(): KeyTuningRefs {
  ensureStyle();
  let container = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (!container) {
    container = document.createElement('div');
    container.id = PANEL_ID;
    const option = (value: string): HTMLOptionElement => {
      const entry = document.createElement('option');
      entry.value = value;
      entry.textContent = value;
      return entry;
    };
    const sliderLabel = (
      label: string,
      role: string,
      min: string,
      max: string,
      step: string
    ): HTMLLabelElement => dom('label', {}, [
      label,
      dom('input', { 'data-role': role, type: 'range', min, max, step })
    ]);
    const selectLabel = (
      label: string,
      role: string,
      values: string[]
    ): HTMLLabelElement => {
      const select = dom('select', { 'data-role': role });
      select.append(...values.map(option));
      return dom('label', {}, [label, select]);
    };

    const dragHandle = dom('div', { 'data-role': 'keyTuningDragHandle' }, [
      dom('strong', {}, ['Key Tuning']),
      dom('button', { 'data-role': 'keyTuningCloseBtn', type: 'button' }, ['Close'])
    ]);
    const urlInput = dom('input', {
      'data-role': 'keyTuningUrlInput',
      type: 'text',
      placeholder: 'Bandcamp track URL'
    }) as HTMLInputElement;
    urlInput.style.flex = '1';
    const bpmInput = dom('input', {
      'data-role': 'keyTuningBpmInput',
      type: 'number',
      min: '40',
      max: '240',
      step: '1',
      placeholder: 'BPM'
    }) as HTMLInputElement;
    bpmInput.style.width = '80px';
    const topRow = dom('div', { class: 'bc-key-row' }, [
      urlInput,
      bpmInput,
      dom('button', { 'data-role': 'keyTuningUseCurrentBtn', type: 'button' }, ['Use Current']),
      dom('button', { 'data-role': 'keyTuningAnalyzeBtn', type: 'button' }, ['Analyze'])
    ]);
    const metadata = dom('div', { 'data-role': 'keyTuningMetadata' }, ['Track: -']);
    const status = dom('div', { 'data-role': 'keyTuningStatus' });
    const controls = dom('div', { 'data-role': 'keyTuningControls', hidden: 'true' });
    controls.append(
      dom('div', { class: 'bc-key-row' }, [
        sliderLabel('Pitch', 'keyTuningSliderPitchSalience', '0', '1', '0.01'),
        sliderLabel('HFC', 'keyTuningSliderHfc', '0.5', '1', '0.01'),
        sliderLabel('Frames', 'keyTuningSliderPrefilterFrames', '1', '5', '1')
      ]),
      dom('div', { class: 'bc-key-row' }, [
        sliderLabel('Energy', 'keyTuningSliderEnergyGate', '0', '0.5', '0.01'),
        sliderLabel('Reliability', 'keyTuningSliderReliabilityFloor', '0', '0.8', '0.01'),
        sliderLabel('Dual', 'keyTuningSliderDualCenter', '0', '0.3', '0.01')
      ]),
      dom('div', { class: 'bc-key-row' }, [
        sliderLabel('Min W', 'keyTuningSliderMinCandidateWeight', '0', '30', '1'),
        sliderLabel('Smooth', 'keyTuningSliderSmoothing', '1', '7', '1'),
        sliderLabel('Min Seg', 'keyTuningSliderMinSegment', '1', '5', '1')
      ]),
      dom('div', { class: 'bc-key-row' }, [
        selectLabel('Profile', 'keyTuningSelectProfile', ['edma', 'edmm', 'bgate', 'krumhansl', 'temperley']),
        selectLabel('Mix', 'keyTuningSelectProfileMix', ['off', 'on']),
        selectLabel('pcpSize', 'keyTuningSelectPcpSize', ['36', '12']),
        selectLabel('Rank', 'keyTuningSelectRankMode', ['baseline', 'consensus']),
        dom('button', { 'data-role': 'keyTuningResetBtn', type: 'button' }, ['Reset Defaults'])
      ])
    );
    const sliderValues = dom('div', { 'data-role': 'keyTuningSliderValues' });
    const result = dom('div', { 'data-role': 'keyTuningResult' });
    const referenceInput = dom('input', {
      'data-role': 'keyTuningReferenceInput',
      type: 'text',
      placeholder: 'Reference (8A, Am, C major)'
    }) as HTMLInputElement;
    referenceInput.style.flex = '1';
    const referenceRow = dom('div', { class: 'bc-key-row' }, [
      referenceInput,
      dom('button', { 'data-role': 'keyTuningCopySummaryBtn', type: 'button' }, ['Copy Summary'])
    ]);
    const agreement = dom('div', { 'data-role': 'keyTuningAgreement', hidden: 'true' });
    const windowTable = dom('div', { 'data-role': 'keyTuningWindowTable' });

    container.append(
      dragHandle,
      topRow,
      metadata,
      status,
      controls,
      sliderValues,
      result,
      referenceRow,
      agreement,
      windowTable
    );

    document.body.appendChild(container);
    const pos = readPos();
    if (pos) {
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
      container.style.right = 'auto';
    }

    const destroyDrag = attachDrag(container, getEl<HTMLDivElement>(container, 'keyTuningDragHandle'));
    container.dataset.dragCleanupAttached = '1';
    (container as unknown as { __destroyDrag?: () => void }).__destroyDrag = destroyDrag;
  }

  return {
    container,
    dragHandle: getEl(container, 'keyTuningDragHandle'),
    closeBtn: getEl(container, 'keyTuningCloseBtn'),
    urlInput: getEl(container, 'keyTuningUrlInput'),
    bpmInput: getEl(container, 'keyTuningBpmInput'),
    analyzeBtn: getEl(container, 'keyTuningAnalyzeBtn'),
    useCurrentBtn: getEl(container, 'keyTuningUseCurrentBtn'),
    copySummaryBtn: getEl(container, 'keyTuningCopySummaryBtn'),
    metadata: getEl(container, 'keyTuningMetadata'),
    status: getEl(container, 'keyTuningStatus'),
    controls: getEl(container, 'keyTuningControls'),
    sliderPitchSalience: getEl(container, 'keyTuningSliderPitchSalience'),
    sliderHfc: getEl(container, 'keyTuningSliderHfc'),
    sliderPrefilterFrames: getEl(container, 'keyTuningSliderPrefilterFrames'),
    sliderEnergyGate: getEl(container, 'keyTuningSliderEnergyGate'),
    sliderReliabilityFloor: getEl(container, 'keyTuningSliderReliabilityFloor'),
    sliderDualCenter: getEl(container, 'keyTuningSliderDualCenter'),
    sliderMinCandidateWeight: getEl(container, 'keyTuningSliderMinCandidateWeight'),
    sliderSmoothing: getEl(container, 'keyTuningSliderSmoothing'),
    sliderMinSegment: getEl(container, 'keyTuningSliderMinSegment'),
    selectProfile: getEl(container, 'keyTuningSelectProfile'),
    selectProfileMix: getEl(container, 'keyTuningSelectProfileMix'),
    selectPcpSize: getEl(container, 'keyTuningSelectPcpSize'),
    selectRankMode: getEl(container, 'keyTuningSelectRankMode'),
    sliderValues: getEl(container, 'keyTuningSliderValues'),
    resetBtn: getEl(container, 'keyTuningResetBtn'),
    result: getEl(container, 'keyTuningResult'),
    referenceInput: getEl(container, 'keyTuningReferenceInput'),
    agreement: getEl(container, 'keyTuningAgreement'),
    windowTable: getEl(container, 'keyTuningWindowTable')
  };
}

export function removeKeyTuningPanel(): void {
  const container = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (!container) return;
  const destroyDrag = (container as unknown as { __destroyDrag?: () => void }).__destroyDrag;
  if (destroyDrag) destroyDrag();
  container.remove();
}

export function isKeyTuningPanelOpen(): boolean {
  return Boolean(document.getElementById(PANEL_ID));
}
