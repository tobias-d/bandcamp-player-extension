import { dom } from '@/utils/dom';

export interface DebugPanelElements {
  root: HTMLElement;
  drag: HTMLElement;
  statusBadge: HTMLElement;
  pauseButton: HTMLButtonElement;
  clearCachesButton: HTMLButtonElement;
  clearEventsButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  statusList: HTMLElement;
  searchInput: HTMLInputElement;
  copyButtonList: HTMLElement;
  areaList: HTMLElement;
  stats: HTMLElement;
  copyNotice: HTMLElement;
}

export function createDebugPanelElements(): DebugPanelElements {
  const root = dom('section', { class: 'bc-debug-panel-root' });
  root.style.display = 'none';
  root.style.top = '24px';
  root.style.left = '240px';
  root.style.bottom = 'auto';
  root.style.right = 'auto';

  const top = dom('div', { class: 'bc-debug-top' });
  const titleGroup = dom('div', { class: 'bc-debug-title-group' });
  const drag = dom('div', { class: 'bc-debug-drag' }, ['Debugger']);
  const statusBadge = dom('span', { class: 'bc-debug-status' }, ['LIVE']);
  titleGroup.appendChild(drag);
  titleGroup.appendChild(statusBadge);

  const actionGroup = dom('div', { class: 'bc-debug-actions' });
  const pauseButton = dom('button', {
    class: 'bc-debug-btn',
    type: 'button',
    title: 'Pause live trace updates'
  }, ['Pause']);
  const clearCachesButton = dom('button', {
    class: 'bc-debug-btn',
    type: 'button',
    title: 'Clear runtime caches and force fresh resolver data'
  }, ['Caches']);
  const clearEventsButton = dom('button', {
    class: 'bc-debug-btn',
    type: 'button',
    title: 'Clear recent debug messages'
  }, ['Clear Logs']);
  const closeButton = dom('button', {
    class: 'bc-debug-btn bc-debug-btn-close',
    type: 'button',
    title: 'Hide debug panel'
  }, ['✕']);

  actionGroup.appendChild(pauseButton);
  actionGroup.appendChild(clearCachesButton);
  actionGroup.appendChild(clearEventsButton);
  actionGroup.appendChild(closeButton);

  top.appendChild(titleGroup);
  top.appendChild(actionGroup);

  const content = dom('div', { class: 'bc-debug-content' });
  const statusRow = dom('section', { class: 'bc-debug-status-row' });
  const statusTitle = dom('div', { class: 'bc-debug-status-title' }, ['Status']);
  const statusList = dom('div', { class: 'bc-debug-status-list' });
  statusRow.appendChild(statusTitle);
  statusRow.appendChild(statusList);

  const controlsCard = dom('section', { class: 'bc-debug-card bc-debug-toolbar-card' });
  const controlsGrid = dom('div', { class: 'bc-debug-controls-grid' });

  const searchWrap = dom('label', { class: 'bc-debug-field bc-debug-field-wide' });
  const searchLabel = dom('span', { class: 'bc-debug-field-label' }, ['Search trace']);
  const searchInput = dom('input', {
    class: 'bc-debug-input',
    type: 'search',
    placeholder: 'Filter debugger areas'
  }) as HTMLInputElement;
  searchWrap.appendChild(searchLabel);
  searchWrap.appendChild(searchInput);
  const copyButtonList = dom('div', { class: 'bc-debug-copy-list', role: 'group', 'aria-label': 'Copy debugger areas' });
  controlsGrid.appendChild(searchWrap);
  controlsGrid.appendChild(copyButtonList);
  controlsCard.appendChild(controlsGrid);

  const areaList = dom('div', { class: 'bc-debug-area-list' });

  const footer = dom('div', { class: 'bc-debug-footer' });
  const stats = dom('span', { class: 'bc-debug-stats' }, ['0 areas']);
  footer.appendChild(stats);
  const copyNotice = dom('div', { class: 'bc-debug-copy-notice', role: 'status', 'aria-live': 'polite' }, [
    'Copied to clipboard'
  ]);

  content.appendChild(statusRow);
  content.appendChild(controlsCard);
  content.appendChild(areaList);
  content.appendChild(footer);

  root.appendChild(top);
  root.appendChild(content);
  root.appendChild(copyNotice);

  return {
    root,
    drag: top,
    statusBadge,
    pauseButton,
    clearCachesButton,
    clearEventsButton,
    closeButton,
    statusList,
    searchInput,
    copyButtonList,
    areaList,
    stats,
    copyNotice
  };
}
