import { dom, injectStylesheet } from '@/utils/dom';

const STYLE_ID = 'bc-bpm-prototype-style';
const PANEL_ID = 'bc-bpm-prototype-panel';
const POS_KEY = '__BC_BPM_PROTOTYPE_PANEL_POS__';
const MODE_KEY = '__BC_BPM_PROTOTYPE_PANEL_MODE__';
const FAMILY_KEY = '__BC_BPM_PROTOTYPE_PANEL_FAMILY__';

export interface BpmPrototypePanelRefs {
  container: HTMLDivElement;
  dragHandle: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  status: HTMLDivElement;
  result: HTMLPreElement;
  modeSelect: HTMLSelectElement;
  familySelect: HTMLSelectElement;
  urlInput: HTMLInputElement;
  labelInput: HTMLInputElement;
  expectedBpmInput: HTMLInputElement;
  notesInput: HTMLInputElement;
  analyzeBtn: HTMLButtonElement;
  analyzeAllBtn: HTMLButtonElement;
  copyReportBtn: HTMLButtonElement;
  useCurrentBtn: HTMLButtonElement;
  addCustomBtn: HTMLButtonElement;
  addCurrentBtn: HTMLButtonElement;
  clearCustomBtn: HTMLButtonElement;
  trackList: HTMLDivElement;
}

function getEl<T extends HTMLElement>(root: ParentNode, role: string): T {
  const found = root.querySelector(`[data-role="${role}"]`);
  if (!found) {
    throw new Error(`Missing BPM prototype role: ${role}`);
  }
  return found as T;
}

function readPos(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
    const left = Number(parsed.left);
    const top = Number(parsed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
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

export function readBpmPrototypePanelMode(): 'corrected' | 'base-only' {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === 'base-only' ? 'base-only' : 'corrected';
  } catch {
    return 'corrected';
  }
}

function writeBpmPrototypePanelMode(mode: 'corrected' | 'base-only'): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

export function readBpmPrototypePanelFamily(): string {
  try {
    return window.localStorage.getItem(FAMILY_KEY) || 'all';
  } catch {
    return 'all';
  }
}

function writeBpmPrototypePanelFamily(family: string): void {
  try {
    window.localStorage.setItem(FAMILY_KEY, String(family || 'all'));
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
    if (!dragging) {
      return;
    }
    const left = baseLeft + (event.clientX - startX);
    const top = baseTop + (event.clientY - startY);
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
  };

  const onUp = (): void => {
    if (!dragging) {
      return;
    }
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
#${PANEL_ID}{position:fixed;top:86px;right:24px;z-index:2147483001;width:min(94vw,820px);max-height:86vh;background:rgba(16,18,22,.78);-webkit-backdrop-filter:blur(16px) saturate(135%);backdrop-filter:blur(16px) saturate(135%);color:#edf1f7;border:1px solid rgba(255,255,255,.22);border-radius:18px;font:12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 22px 58px rgba(0,0,0,.48);display:flex;flex-direction:column;overflow:hidden}
#${PANEL_ID} [data-role="bpmPrototypeDragHandle"]{padding:14px 16px;background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.14);cursor:move;display:flex;justify-content:space-between;align-items:center}
#${PANEL_ID} .bc-bpm-proto-section{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}
#${PANEL_ID} .bc-bpm-proto-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#${PANEL_ID} .bc-bpm-proto-stack{display:flex;flex-direction:column;gap:6px}
#${PANEL_ID} select{font:inherit;background:rgba(7,10,14,.42);color:#f3f7ff;border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:7px 9px}
#${PANEL_ID} input,#${PANEL_ID} button{font:inherit}
#${PANEL_ID} input{background:rgba(7,10,14,.42);color:#f3f7ff;border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:7px 9px}
#${PANEL_ID} button{background:rgba(255,255,255,.12);color:#f3f7ff;border:1px solid rgba(255,255,255,.26);border-radius:10px;padding:7px 11px;line-height:1.2}
#${PANEL_ID} [data-role="bpmPrototypeModeSelect"]{min-width:132px}
#${PANEL_ID} [data-role="bpmPrototypeFamilySelect"]{min-width:212px;max-width:260px}
#${PANEL_ID} [data-role="bpmPrototypeUrlInput"]{flex:1 1 420px}
#${PANEL_ID} [data-role="bpmPrototypeLabelInput"]{flex:1 1 260px}
#${PANEL_ID} [data-role="bpmPrototypeNotesInput"]{flex:1 1 260px}
#${PANEL_ID} [data-role="bpmPrototypeExpectedInput"]{width:92px}
#${PANEL_ID} .bc-bpm-proto-row.actions{justify-content:space-between}
#${PANEL_ID} .bc-bpm-proto-row.actions > div{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#${PANEL_ID} [data-role="bpmPrototypeStatus"]{min-height:18px;color:rgba(255,255,255,.8)}
#${PANEL_ID} [data-role="bpmPrototypeTrackList"]{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:8px}
#${PANEL_ID} .bc-bpm-proto-track{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px 12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.04)}
#${PANEL_ID} .bc-bpm-proto-track.is-custom{border-style:dashed}
#${PANEL_ID} .bc-bpm-proto-title{font-weight:600}
#${PANEL_ID} .bc-bpm-proto-meta{opacity:.78;font-size:11px;word-break:break-all}
#${PANEL_ID} .bc-bpm-proto-actions{display:flex;gap:6px;align-items:flex-start}
#${PANEL_ID} [data-role="bpmPrototypeResult"]{margin:0;padding:12px 16px;max-height:260px;overflow:auto;background:rgba(7,10,14,.32);white-space:pre-wrap;word-break:break-word}
`);
}

export function ensureBpmPrototypePanel(): BpmPrototypePanelRefs {
  ensureStyle();
  let container = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (!container) {
    container = document.createElement('div');
    container.id = PANEL_ID;

    const dragHandle = dom('div', { 'data-role': 'bpmPrototypeDragHandle' }, [
      dom('strong', {}, ['BPM Prototype']),
      dom('button', { 'data-role': 'bpmPrototypeCloseBtn', type: 'button' }, ['Close'])
    ]);

    const urlInput = dom('input', {
      'data-role': 'bpmPrototypeUrlInput',
      type: 'text',
      placeholder: 'Bandcamp track URL or stream URL'
    }) as HTMLInputElement;
    const modeSelect = dom('select', { 'data-role': 'bpmPrototypeModeSelect' }, [
      dom('option', { value: 'corrected' }, ['Corrected']),
      dom('option', { value: 'base-only' }, ['Base Only'])
    ]) as HTMLSelectElement;
    modeSelect.value = readBpmPrototypePanelMode();
    modeSelect.addEventListener('change', () => {
      writeBpmPrototypePanelMode(modeSelect.value === 'base-only' ? 'base-only' : 'corrected');
    });
    const familySelect = dom('select', { 'data-role': 'bpmPrototypeFamilySelect' }, [
      dom('option', { value: 'all' }, ['All Families'])
    ]) as HTMLSelectElement;
    familySelect.value = readBpmPrototypePanelFamily();
    familySelect.addEventListener('change', () => {
      writeBpmPrototypePanelFamily(familySelect.value);
    });
    const analyzeRow = dom('div', { class: 'bc-bpm-proto-row bc-bpm-proto-section' }, [
      dom('div', { class: 'bc-bpm-proto-stack' }, [
        dom('span', {}, ['Tempo Mode']),
        modeSelect
      ]),
      dom('div', { class: 'bc-bpm-proto-stack' }, [
        dom('span', {}, ['Batch Family']),
        familySelect
      ]),
      urlInput,
      dom('button', { 'data-role': 'bpmPrototypeUseCurrentBtn', type: 'button' }, ['Use Current']),
      dom('button', { 'data-role': 'bpmPrototypeAnalyzeBtn', type: 'button' }, ['Analyze'])
    ]);

    const labelInput = dom('input', {
      'data-role': 'bpmPrototypeLabelInput',
      type: 'text',
      placeholder: 'Track label for custom entry'
    }) as HTMLInputElement;
    const expectedBpmInput = dom('input', {
      'data-role': 'bpmPrototypeExpectedInput',
      type: 'number',
      min: '40',
      max: '240',
      step: '1',
      placeholder: 'Target BPM'
    }) as HTMLInputElement;
    const notesInput = dom('input', {
      'data-role': 'bpmPrototypeNotesInput',
      type: 'text',
      placeholder: 'Optional notes'
    }) as HTMLInputElement;
    const customRow = dom('div', { class: 'bc-bpm-proto-row bc-bpm-proto-section' }, [
      labelInput,
      expectedBpmInput,
      notesInput,
      dom('button', { 'data-role': 'bpmPrototypeAddCustomBtn', type: 'button' }, ['Add URL']),
      dom('button', { 'data-role': 'bpmPrototypeAddCurrentBtn', type: 'button' }, ['Add Current']),
      dom('button', { 'data-role': 'bpmPrototypeClearCustomBtn', type: 'button' }, ['Clear Custom'])
    ]);

    const status = dom('div', { 'data-role': 'bpmPrototypeStatus', class: 'bc-bpm-proto-section' }, [
      'Paste a Bandcamp URL or choose a built-in regression track.'
    ]);

    const actionRow = dom('div', { class: 'bc-bpm-proto-row bc-bpm-proto-section actions' }, [
      dom('div', {}, [
        dom('button', { 'data-role': 'bpmPrototypeAnalyzeAllBtn', type: 'button' }, ['Analyze All']),
        dom('button', { 'data-role': 'bpmPrototypeCopyReportBtn', type: 'button' }, ['Copy Report'])
      ]),
      dom('div', {}, [
        dom('span', {}, ['Single run or full batch report'])
      ])
    ]);

    const trackListSection = dom('div', { class: 'bc-bpm-proto-section bc-bpm-proto-stack' }, [
      dom('strong', {}, ['Saved Tracks']),
      dom('div', { 'data-role': 'bpmPrototypeTrackList' })
    ]);

    const result = dom('pre', { 'data-role': 'bpmPrototypeResult' }, ['No analysis yet.']) as HTMLPreElement;

    container.append(
      dragHandle,
      analyzeRow,
      customRow,
      status,
      actionRow,
      trackListSection,
      result
    );

    document.body.appendChild(container);
    const pos = readPos();
    if (pos) {
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
      container.style.right = 'auto';
    }

    const destroyDrag = attachDrag(container, getEl<HTMLDivElement>(container, 'bpmPrototypeDragHandle'));
    (container as unknown as { __destroyDrag?: () => void }).__destroyDrag = destroyDrag;
  }

  return {
    container,
    dragHandle: getEl(container, 'bpmPrototypeDragHandle'),
    closeBtn: getEl(container, 'bpmPrototypeCloseBtn'),
    status: getEl(container, 'bpmPrototypeStatus'),
    result: getEl(container, 'bpmPrototypeResult'),
    modeSelect: getEl(container, 'bpmPrototypeModeSelect'),
    familySelect: getEl(container, 'bpmPrototypeFamilySelect'),
    urlInput: getEl(container, 'bpmPrototypeUrlInput'),
    labelInput: getEl(container, 'bpmPrototypeLabelInput'),
    expectedBpmInput: getEl(container, 'bpmPrototypeExpectedInput'),
    notesInput: getEl(container, 'bpmPrototypeNotesInput'),
    analyzeBtn: getEl(container, 'bpmPrototypeAnalyzeBtn'),
    analyzeAllBtn: getEl(container, 'bpmPrototypeAnalyzeAllBtn'),
    copyReportBtn: getEl(container, 'bpmPrototypeCopyReportBtn'),
    useCurrentBtn: getEl(container, 'bpmPrototypeUseCurrentBtn'),
    addCustomBtn: getEl(container, 'bpmPrototypeAddCustomBtn'),
    addCurrentBtn: getEl(container, 'bpmPrototypeAddCurrentBtn'),
    clearCustomBtn: getEl(container, 'bpmPrototypeClearCustomBtn'),
    trackList: getEl(container, 'bpmPrototypeTrackList')
  };
}

export function removeBpmPrototypePanel(): void {
  const container = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (!container) {
    return;
  }
  const destroyDrag = (container as unknown as { __destroyDrag?: () => void }).__destroyDrag;
  if (destroyDrag) {
    destroyDrag();
  }
  container.remove();
}

export function isBpmPrototypePanelOpen(): boolean {
  return Boolean(document.getElementById(PANEL_ID));
}
