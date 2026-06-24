import {
  DEFAULT_LIKE_VIEW_STATE,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import type { PanelHandlers, PanelInput, WaveformLoadingPerformanceDebug } from '@/shared/types';
import { dom } from '@/utils/dom';
import { extensionAssetUrl } from '@/utils/asset-url';
import { injectPanelStyles } from '@/ui/styles';
import { createBpmDisplay } from '@/ui/components/bpm-display';
import { createLikeButton } from '@/ui/components/like-button';
import { createKeyboardShortcutsPanel } from '@/ui/components/keyboard-shortcuts-panel';
import { createMetadataDisplay } from '@/ui/components/metadata-display';
import { createPlaylistView } from '@/ui/components/playlist-view';
import { createSettings } from '@/ui/components/settings';
import { createTapTempo } from '@/ui/components/tap-tempo';
import { createTransport } from '@/ui/components/transport';
import { createWarningBanner } from '@/ui/components/warning-banner';
import { isExtensionContextValid, onExtensionContextInvalidated } from '@/utils/extension-context';
import { createWaveformCanvas } from '@/ui/components/waveform-canvas';
import { createWelcomeGate } from '@/ui/components/welcome-gate';
import { createWhyTwoKeysPanel } from '@/ui/components/why-two-keys-panel';
import { createPanelGlass } from '@/ui/glass/glass-effect';
import { createAppearancePanel } from '@/ui/glass/appearance-panel';
import { shouldSuppressProvisionalLowBandTempo } from '@/shared/tempo-display';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  findShortcutActionByKey,
  normalizeShortcutMap,
  shortcutKeyFromKeyboardEvent
} from '@/shared/keyboard-shortcuts';
import { isHttpsReleasePageUrl, normalizeReleaseUrl } from '@/content/metadata/common';

export interface ResultsPanelController {
  update(input: PanelInput): void;
  destroy(): void;
}

interface ResultsPanelDebugOptions {
  onWaveformDebugTrace?(stage: string, detail: string): void;
  onWaveformPerformance?(snapshot: WaveformLoadingPerformanceDebug): void;
  onOpenDebugger?(): void;
}

const PANEL_SCALE_STORAGE_KEY = 'bc:panel-scale:v1';
const PANEL_POSITION_STORAGE_KEY = 'bc:panel-position:v1';
const KEYBOARD_SEEK_STEP_SECONDS = 5;
const KEYBOARD_TEMPO_STEP_BPM = 1;
const SHORTCUTS_PANEL_GAP_PX = 8;
const SHORTCUTS_PANEL_TOP_OFFSET_PX = 27;
const SHORTCUTS_PANEL_VIEWPORT_PADDING_PX = 8;
const PAGE_MEDIA_SESSION_MESSAGE_SOURCE = 'bc-player-origin-bridge';
const OPEN_LINK_ICON_URL = extensionAssetUrl('public/new-tab.svg');
// Shown (CSS uppercases it) when this content script is orphaned by an extension reload.
const EXTENSION_RELOADED_NOTICE = 'Bandcamp Deck updated\nReload this tab to continue';

interface PanelPosition {
  left: number;
  top: number;
}

function parseStoredPanelScale(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value || ''));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function readCurrentExtensionVersion(): string {
  try {
    const version = chrome?.runtime?.getManifest?.().version;
    return String(version || '').trim();
  } catch {
    return '';
  }
}

function applyThemeClass(root: HTMLElement): void {
  const isDarkTheme =
    document.documentElement.dataset.theme === 'dark' ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  root.classList.toggle('bc-theme-dark', Boolean(isDarkTheme));
}

function getPanelScale(root: HTMLElement): number {
  const raw = Number.parseFloat(getComputedStyle(root).getPropertyValue('--panel-scale'));
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return raw;
}

function setPanelScale(root: HTMLElement, scale: number): void {
  root.style.setProperty('--panel-scale', `${scale}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isEditableElement(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (node.isContentEditable) {
    return true;
  }
  const tagName = node.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  const role = node.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

function isEditableShortcutEvent(event: KeyboardEvent): boolean {
  // Suppress shortcuts whenever the user is typing. Bandcamp's search can leave
  // keydown.target on a wrapper, so check the whole event path (which also
  // pierces shadow DOM) and the currently focused element, not target alone.
  // Otherwise letters like B/N/T trigger prev/next/tap while typing.
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (isEditableElement(node)) {
      return true;
    }
  }
  return isEditableElement(event.target) || isEditableElement(document.activeElement);
}

function getMediaSession(): MediaSession | null {
  try {
    return navigator.mediaSession || null;
  } catch {
    return null;
  }
}

function assignMediaSessionActionHandler(
  mediaSession: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null
): boolean {
  try {
    mediaSession.setActionHandler(action, handler);
    return true;
  } catch {
    return false;
  }
}

function dispatchMediaSessionAction(
  action: string,
  handlers: PanelHandlers,
  getInput: () => PanelInput
): void {
  if (action === 'play') {
    if (!getInput().isPlaying) {
      handlers.onTogglePlayPause();
    }
    return;
  }
  if (action === 'pause') {
    if (getInput().isPlaying) {
      handlers.onTogglePlayPause();
    }
    return;
  }
  if (action === 'previoustrack') {
    handlers.onPrevTrack();
    return;
  }
  if (action === 'nexttrack') {
    handlers.onNextTrack();
  }
}

function createPanelMediaSessionController(
  handlers: PanelHandlers,
  getInput: () => PanelInput
): { sync(input: PanelInput): void; destroy(): void } {
  const mediaSession = getMediaSession();
  const registeredActions: MediaSessionAction[] = [];
  const onPageMediaSessionMessage = (event: MessageEvent): void => {
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      payload?: { action?: unknown };
    } | null;
    if (
      !data ||
      data.source !== PAGE_MEDIA_SESSION_MESSAGE_SOURCE ||
      data.type !== 'MEDIA_SESSION_ACTION'
    ) {
      return;
    }
    dispatchMediaSessionAction(String(data.payload?.action || ''), handlers, getInput);
  };
  window.addEventListener('message', onPageMediaSessionMessage);

  if (mediaSession) {
    const register = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
      if (assignMediaSessionActionHandler(mediaSession, action, handler)) {
        registeredActions.push(action);
      }
    };

    register('play', () => dispatchMediaSessionAction('play', handlers, getInput));
    register('pause', () => dispatchMediaSessionAction('pause', handlers, getInput));
    register('previoustrack', () => dispatchMediaSessionAction('previoustrack', handlers, getInput));
    register('nexttrack', () => dispatchMediaSessionAction('nexttrack', handlers, getInput));
  }

  return {
    sync(input) {
      if (!mediaSession) {
        return;
      }
      try {
        mediaSession.playbackState = input.isPlaying ? 'playing' : 'paused';
      } catch {
        // Some browsers expose MediaSession without playbackState support.
      }
      try {
        if (typeof window.MediaMetadata === 'function') {
          mediaSession.metadata = new window.MediaMetadata({
            title: String(input.metadata?.trackTitle || input.metadata?.combined || 'Bandcamp Deck'),
            artist: String(input.metadata?.artistName || ''),
            album: String(input.metadata?.albumTitle || '')
          });
        }
      } catch {
        // Metadata is decorative; action handlers above are the control path.
      }
    },
    destroy() {
      window.removeEventListener('message', onPageMediaSessionMessage);
      if (!mediaSession) {
        return;
      }
      registeredActions.forEach((action) => {
        assignMediaSessionActionHandler(mediaSession, action, null);
      });
      try {
        mediaSession.playbackState = 'none';
      } catch {
        // Ignore cleanup gaps in partial MediaSession implementations.
      }
    }
  };
}

function styleLeftFromVisualLeft(visualLeft: number, panelWidth: number, panelScale: number): number {
  return visualLeft + (panelScale - 1) * panelWidth;
}

function clampVisualPanelPosition(
  visualLeft: number,
  visualTop: number,
  panelWidth: number,
  panelHeight: number,
  panelScale: number
): PanelPosition {
  const visualWidth = panelWidth * panelScale;
  const visualHeight = panelHeight * panelScale;
  return {
    left: clamp(visualLeft, 0, Math.max(0, window.innerWidth - visualWidth)),
    top: clamp(visualTop, 0, Math.max(0, window.innerHeight - visualHeight))
  };
}

function parseStoredPanelPosition(value: unknown): PanelPosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const left = Number(record.left);
  const top = Number(record.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }
  return { left, top };
}

function maxPanelScaleWithinViewport(
  corner: ResizeCorner,
  anchorX: number,
  anchorY: number,
  panelWidth: number,
  panelHeight: number
): number {
  const availableWidth = corner === 'top-left' || corner === 'bottom-left'
    ? anchorX
    : window.innerWidth - anchorX;
  const availableHeight = corner === 'top-left' || corner === 'top-right'
    ? anchorY
    : window.innerHeight - anchorY;
  return Math.max(0.1, Math.min(availableWidth / panelWidth, availableHeight / panelHeight));
}

function getPanelScaleStorage(): chrome.storage.StorageArea | null {
  try {
    return chrome?.storage?.local || null;
  } catch {
    return null;
  }
}

function readPageStoredPanelScale(): number | null {
  try {
    return parseStoredPanelScale(window.localStorage.getItem(PANEL_SCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function readPageStoredPanelPosition(): PanelPosition | null {
  try {
    return parseStoredPanelPosition(JSON.parse(window.localStorage.getItem(PANEL_POSITION_STORAGE_KEY) || 'null'));
  } catch {
    return null;
  }
}

async function readStoredPanelScale(): Promise<number | null> {
  const storage = getPanelScaleStorage();
  if (!storage) {
    return readPageStoredPanelScale();
  }

  const storedScale = await new Promise<number | null>((resolve) => {
    storage.get([PANEL_SCALE_STORAGE_KEY], (items) => {
      resolve(parseStoredPanelScale(items?.[PANEL_SCALE_STORAGE_KEY]));
    });
  });
  return storedScale ?? readPageStoredPanelScale();
}

function writeStoredPanelScale(scale: number): void {
  const storage = getPanelScaleStorage();
  if (storage) {
    storage.set({ [PANEL_SCALE_STORAGE_KEY]: `${scale}` });
  }

  // Keep the previous page-local value updated so existing Firefox/page-origin
  // installs retain the setting while extension storage becomes authoritative.
  try {
    window.localStorage.setItem(PANEL_SCALE_STORAGE_KEY, `${scale}`);
  } catch {
    // Ignore page storage errors; extension storage is the shared source.
  }
}

async function readStoredPanelPosition(): Promise<PanelPosition | null> {
  const storage = getPanelScaleStorage();
  if (!storage) {
    return readPageStoredPanelPosition();
  }

  const storedPosition = await new Promise<PanelPosition | null>((resolve) => {
    storage.get([PANEL_POSITION_STORAGE_KEY], (items) => {
      resolve(parseStoredPanelPosition(items?.[PANEL_POSITION_STORAGE_KEY]));
    });
  });
  return storedPosition ?? readPageStoredPanelPosition();
}

function writeStoredPanelPosition(position: PanelPosition): void {
  const payload = {
    left: Math.round(position.left),
    top: Math.round(position.top)
  };
  const storage = getPanelScaleStorage();
  if (storage) {
    storage.set({ [PANEL_POSITION_STORAGE_KEY]: payload });
  }

  try {
    window.localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore page storage errors; extension storage is the shared source.
  }
}

type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface ResizeHandle {
  corner: ResizeCorner;
  element: HTMLElement;
}

function applyPanelPosition(root: HTMLElement, position: PanelPosition): PanelPosition {
  const panelScale = getPanelScale(root);
  const clampedPosition = clampVisualPanelPosition(
    position.left,
    position.top,
    root.offsetWidth,
    root.offsetHeight,
    panelScale
  );
  root.style.left = `${styleLeftFromVisualLeft(clampedPosition.left, root.offsetWidth, panelScale)}px`;
  root.style.top = `${clampedPosition.top}px`;
  root.style.right = 'auto';
  return clampedPosition;
}

function resolveCurrentPlaylistTrackTitle(input: PanelInput): string {
  const tracks = Array.isArray(input.playlist?.tracks) ? input.playlist.tracks : [];
  const activeTrack = tracks.find((track) => Boolean(track?.isCurrent))
    || tracks[input.playlist?.currentIndex]
    || null;
  return String(activeTrack?.title || '').trim();
}

function isPlaceholderPanelValue(value: string | undefined): boolean {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '---';
}

function isPanelIdle(input: PanelInput): boolean {
  return (
    isPlaceholderPanelValue(input.metadata?.artistName) &&
    isPlaceholderPanelValue(input.metadata?.albumTitle) &&
    isPlaceholderPanelValue(resolveCurrentPlaylistTrackTitle(input))
  );
}

function resolveAlbumOpenHref(input: PanelInput): string {
  const normalized = normalizeReleaseUrl(String(input.releasePageUrl || '').trim());
  if (!normalized || !normalized.includes('/album/')) {
    return '';
  }
  return isHttpsReleasePageUrl(normalized) ? normalized : '';
}

function makeDraggable(
  root: HTMLElement,
  dragHandles: HTMLElement[],
  onPositionCommit: (position: PanelPosition) => void
): () => void {
  let dragging = false;
  let startPointerX = 0;
  let startPointerY = 0;
  let startVisualLeft = 0;
  let startVisualTop = 0;
  let panelScale = 1;
  let panelWidth = 0;
  let panelHeight = 0;
  let latestPointerX = 0;
  let latestPointerY = 0;
  let moveFrame = 0;

  // Movement during the drag is a pure compositor transform (the
  // --panel-drag-x/y translate in the .bc-panel-root transform), applied at
  // most once per frame. left/top stay untouched until release, so per-frame
  // work is style-recalc + composite only — no layout of the panel subtree and
  // no per-mousemove churn. The glass backdrop-filter stays fully live.
  const applyMove = (): void => {
    moveFrame = 0;
    if (!dragging) {
      return;
    }
    const dx = latestPointerX - startPointerX;
    const dy = latestPointerY - startPointerY;
    const clampedPosition = clampVisualPanelPosition(
      startVisualLeft + dx,
      startVisualTop + dy,
      panelWidth,
      panelHeight,
      panelScale
    );
    root.style.setProperty('--panel-drag-x', `${clampedPosition.left - startVisualLeft}px`);
    root.style.setProperty('--panel-drag-y', `${clampedPosition.top - startVisualTop}px`);
  };

  const onMouseDown = (event: MouseEvent): void => {
    dragging = true;
    const rect = root.getBoundingClientRect();
    panelScale = getPanelScale(root);
    panelWidth = root.offsetWidth;
    panelHeight = root.offsetHeight;
    startPointerX = event.clientX;
    startPointerY = event.clientY;
    latestPointerX = event.clientX;
    latestPointerY = event.clientY;
    startVisualLeft = rect.left;
    startVisualTop = rect.top;
    event.preventDefault();
  };

  for (const handle of dragHandles) {
    handle.addEventListener('mousedown', onMouseDown);
  }

  const onMouseMove = (event: MouseEvent): void => {
    if (!dragging) {
      return;
    }
    latestPointerX = event.clientX;
    latestPointerY = event.clientY;
    if (!moveFrame) {
      moveFrame = window.requestAnimationFrame(applyMove);
    }
  };

  const onMouseUp = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (moveFrame) {
      window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    // Bake the drag translate into left/top once, then clear the translate.
    // getBoundingClientRect includes the transform, so this single layout
    // lands the panel exactly where it visually is.
    const rect = root.getBoundingClientRect();
    const styleLeft = styleLeftFromVisualLeft(rect.left, panelWidth, panelScale);
    root.style.left = `${styleLeft}px`;
    root.style.top = `${rect.top}px`;
    root.style.right = 'auto';
    root.style.setProperty('--panel-drag-x', '0px');
    root.style.setProperty('--panel-drag-y', '0px');
    onPositionCommit({ left: rect.left, top: rect.top });
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return () => {
    if (moveFrame) {
      window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    for (const handle of dragHandles) {
      handle.removeEventListener('mousedown', onMouseDown);
    }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

function makeResizable(
  root: HTMLElement,
  handles: ResizeHandle[],
  standardScale: number,
  onGeometryCommit: (scale: number, position: PanelPosition) => void
): () => void {
  const minScale = standardScale * 0.7;
  const maxScale = standardScale * 1.1;

  let resizingCorner: ResizeCorner | null = null;
  let anchorX = 0;
  let anchorY = 0;
  let panelWidth = 0;
  let panelHeight = 0;
  const handleMouseDownHandlers = new Map<HTMLElement, (event: MouseEvent) => void>();

  const onHandleMouseDown =
    (corner: ResizeCorner) =>
    (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }

      const rect = root.getBoundingClientRect();
      const currentScale = getPanelScale(root);
      panelWidth = root.offsetWidth;
      panelHeight = root.offsetHeight;

      const styleLeft = styleLeftFromVisualLeft(rect.left, panelWidth, currentScale);
      root.style.left = `${styleLeft}px`;
      root.style.top = `${rect.top}px`;
      root.style.right = 'auto';

      switch (corner) {
        case 'top-left':
          anchorX = rect.right;
          anchorY = rect.bottom;
          break;
        case 'top-right':
          anchorX = rect.left;
          anchorY = rect.bottom;
          break;
        case 'bottom-left':
          anchorX = rect.right;
          anchorY = rect.top;
          break;
        case 'bottom-right':
          anchorX = rect.left;
          anchorY = rect.top;
          break;
      }

      resizingCorner = corner;
      event.preventDefault();
      event.stopPropagation();
    };

  const onMouseMove = (event: MouseEvent): void => {
    if (!resizingCorner || panelWidth <= 0 || panelHeight <= 0) {
      return;
    }

    let scaleFromX = standardScale;
    let scaleFromY = standardScale;

    switch (resizingCorner) {
      case 'top-left':
        scaleFromX = (anchorX - event.clientX) / panelWidth;
        scaleFromY = (anchorY - event.clientY) / panelHeight;
        break;
      case 'top-right':
        scaleFromX = (event.clientX - anchorX) / panelWidth;
        scaleFromY = (anchorY - event.clientY) / panelHeight;
        break;
      case 'bottom-left':
        scaleFromX = (anchorX - event.clientX) / panelWidth;
        scaleFromY = (event.clientY - anchorY) / panelHeight;
        break;
      case 'bottom-right':
        scaleFromX = (event.clientX - anchorX) / panelWidth;
        scaleFromY = (event.clientY - anchorY) / panelHeight;
        break;
    }

    const boundedMaxScale = Math.min(
      maxScale,
      maxPanelScaleWithinViewport(resizingCorner, anchorX, anchorY, panelWidth, panelHeight)
    );
    const nextScale = clamp(
      (scaleFromX + scaleFromY) / 2,
      Math.min(minScale, boundedMaxScale),
      boundedMaxScale
    );
    setPanelScale(root, nextScale);

    let nextLeft = anchorX - panelWidth;
    let nextTop = anchorY;

    switch (resizingCorner) {
      case 'top-left':
        nextLeft = anchorX - panelWidth;
        nextTop = anchorY - nextScale * panelHeight;
        break;
      case 'top-right':
        nextLeft = anchorX + (nextScale - 1) * panelWidth;
        nextTop = anchorY - nextScale * panelHeight;
        break;
      case 'bottom-left':
        nextLeft = anchorX - panelWidth;
        nextTop = anchorY;
        break;
      case 'bottom-right':
        nextLeft = anchorX + (nextScale - 1) * panelWidth;
        nextTop = anchorY;
        break;
    }

    const visualLeft = nextLeft - (nextScale - 1) * panelWidth;
    const clampedPosition = clampVisualPanelPosition(
      visualLeft,
      nextTop,
      panelWidth,
      panelHeight,
      nextScale
    );

    root.style.left = `${styleLeftFromVisualLeft(clampedPosition.left, panelWidth, nextScale)}px`;
    root.style.top = `${clampedPosition.top}px`;
    root.style.right = 'auto';
  };

  const onMouseUp = (): void => {
    if (resizingCorner) {
      const rect = root.getBoundingClientRect();
      onGeometryCommit(getPanelScale(root), { left: rect.left, top: rect.top });
    }
    resizingCorner = null;
  };

  for (const handle of handles) {
    const mouseDownHandler = onHandleMouseDown(handle.corner);
    handleMouseDownHandlers.set(handle.element, mouseDownHandler);
    handle.element.addEventListener('mousedown', mouseDownHandler);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return () => {
    for (const handle of handles) {
      const mouseDownHandler = handleMouseDownHandlers.get(handle.element);
      if (mouseDownHandler) {
        handle.element.removeEventListener('mousedown', mouseDownHandler);
      }
    }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

export function showResultsPanel(
  input: PanelInput,
  handlers: PanelHandlers,
  debugOptions: ResultsPanelDebugOptions = {}
): ResultsPanelController {
  injectPanelStyles();

  const root = dom('div', { class: 'bc-panel-root' });
  applyThemeClass(root);

  // ── Container A: transparent header ──────────────────────────────────
  // left: artist + album(+heart) + track stacked (drag handle)
  // right top: ℹ ⚙ ✕
  const header      = dom('div', { class: 'bc-panel-header' });
  const metaCell    = dom('div', { class: 'bc-header-meta' });
  const iconsCell   = dom('div', { class: 'bc-header-icons' });

  const infoButton = dom(
    'span',
    {
      class: 'bc-header-icon bc-header-icon-info',
      title: 'Info',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Information',
      'aria-expanded': 'false'
    },
    [dom('span', { class: 'bc-header-icon-glyph bc-header-icon-glyph-info', 'aria-hidden': 'true' }, ['i'])]
  );
  const infoPanel = dom('div', { class: 'bc-info-panel bc-context-popover', role: 'dialog', 'aria-label': 'Information' });
  const currentVersion = readCurrentExtensionVersion();
  const infoByline = dom('div', { class: 'bc-info-byline' }, [
    dom('span', { class: 'bc-info-byline-author' }, ['By L//Y']),
    dom('span', { class: 'bc-info-byline-version' }, [currentVersion ? `v${currentVersion}` : ''])
  ]);
  const whyTwoKeysButton = dom(
    'a',
    {
      class: 'bc-info-link bc-info-link-why-two-keys',
      href: '#',
      role: 'button',
      'aria-label': 'About'
    },
    ['About']
  ) as HTMLAnchorElement;
  const openDebuggerButton = dom(
    'a',
    {
      class: 'bc-info-link',
      href: '#',
      role: 'button',
      'aria-label': 'Open debugger'
    },
    ['Open debugger']
  ) as HTMLAnchorElement;
  const feedbackLink = dom(
    'a',
    {
      class: 'bc-info-link',
      href: 'https://forms.gle/CMyrodpNPThdr5Aw8',
      target: '_blank',
      rel: 'noopener noreferrer'
    },
    ['Send feedback']
  );
  const coffeeLink = dom(
    'a',
    {
      class: 'bc-info-link',
      href: 'https://ko-fi.com/lany_',
      target: '_blank',
      rel: 'noopener noreferrer'
    },
    ['Support development']
  );
  infoPanel.appendChild(infoByline);
  infoPanel.appendChild(whyTwoKeysButton);
  infoPanel.appendChild(openDebuggerButton);
  infoPanel.appendChild(feedbackLink);
  infoPanel.appendChild(coffeeLink);

  const shortcutsHost = dom('div', { class: 'bc-shortcuts-host' });

  let infoOpen = false;
  let settingsOpen = false;
  let shortcutSettingsOpen = false;
  let shortcutsGeometryRafId = 0;
  const syncShortcutsHostGeometry = (): void => {
    if (!shortcutSettingsOpen) {
      return;
    }
    const panelRect = root.getBoundingClientRect();
    const panelScale = getPanelScale(root);
    const shortcutsPanel = shortcutsHost.querySelector('.bc-shortcuts-panel') as HTMLElement | null;
    const shortcutsWidth = Math.max(1, shortcutsPanel?.offsetWidth || 220);
    const left = Math.max(
      SHORTCUTS_PANEL_VIEWPORT_PADDING_PX,
      panelRect.left - SHORTCUTS_PANEL_GAP_PX - shortcutsWidth * panelScale
    );
    const top = Math.max(
      SHORTCUTS_PANEL_VIEWPORT_PADDING_PX,
      panelRect.top + SHORTCUTS_PANEL_TOP_OFFSET_PX * panelScale
    );
    shortcutsHost.style.left = `${Math.round(left)}px`;
    shortcutsHost.style.top = `${Math.round(top)}px`;
    shortcutsHost.style.setProperty('--shortcuts-host-scale', `${panelScale}`);
    shortcutsHost.classList.toggle('bc-theme-dark', root.classList.contains('bc-theme-dark'));
  };
  const stopShortcutsGeometryLoop = (): void => {
    if (!shortcutsGeometryRafId) {
      return;
    }
    window.cancelAnimationFrame(shortcutsGeometryRafId);
    shortcutsGeometryRafId = 0;
  };
  const startShortcutsGeometryLoop = (): void => {
    stopShortcutsGeometryLoop();
    const tick = (): void => {
      syncShortcutsHostGeometry();
      if (shortcutSettingsOpen) {
        shortcutsGeometryRafId = window.requestAnimationFrame(tick);
      }
    };
    tick();
  };
  const setShortcutSettingsOpen = (nextOpen: boolean): void => {
    shortcutSettingsOpen = nextOpen;
    shortcutsHost.classList.toggle('bc-shortcuts-host-open', shortcutSettingsOpen);
    keyboardShortcutsPanel.update({
      hidden: !shortcutSettingsOpen,
      shortcuts: lastInput.keyboardShortcuts
    });
    if (shortcutSettingsOpen) {
      startShortcutsGeometryLoop();
    } else {
      stopShortcutsGeometryLoop();
    }
  };
  const setInfoOpen = (nextOpen: boolean): void => {
    infoOpen = nextOpen;
    root.classList.toggle('bc-panel-info-open', infoOpen);
    infoButton.setAttribute('aria-expanded', infoOpen ? 'true' : 'false');
    infoButton.classList.toggle('bc-header-icon-active', infoOpen);
    infoPanel.classList.toggle('bc-info-panel-open', infoOpen);
  };
  const setSettingsOpen = (nextOpen: boolean): void => {
    settingsOpen = nextOpen;
    if (!settingsOpen) {
      shortcutSettingsOpen = false;
      shortcutsHost.classList.remove('bc-shortcuts-host-open');
      stopShortcutsGeometryLoop();
    }
    settingsIcon.classList.toggle('bc-header-icon-active', settingsOpen);
    settings.update({
      hidden: !settingsOpen,
      preloadTracks: Boolean(lastInput.preloadTracks),
      keyAnalysisEnabled: Boolean(lastInput.keyAnalysisEnabled),
      autoPlayEnabled: Boolean(lastInput.autoPlayEnabled),
      performanceModeEnabled: Boolean(lastInput.performanceModeEnabled)
    });
    keyboardShortcutsPanel.update({
      hidden: !settingsOpen || !shortcutSettingsOpen,
      shortcuts: lastInput.keyboardShortcuts
    });
  };
  const toggleInfoOpen = (): void => {
    if (!infoOpen) {
      setSettingsOpen(false);
    }
    setInfoOpen(!infoOpen);
  };

  infoButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleInfoOpen();
  });
  infoButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggleInfoOpen();
  });

  const settingsIcon = dom(
    'span',
    { class: 'bc-header-icon', title: 'Settings' },
    [dom('img', { class: 'bc-header-icon-svg', src: extensionAssetUrl('public/settings-new.svg'), alt: '', 'aria-hidden': 'true' })]
  );

  const closeIcon = dom(
    'span',
    { class: 'bc-header-icon bc-header-icon-close', title: 'Close' },
    [dom('span', { class: 'bc-header-icon-glyph bc-header-icon-glyph-close', 'aria-hidden': 'true' }, ['✕'])]
  );
  closeIcon.addEventListener('click', (event) => {
    event.stopPropagation();
    handlers.onClosePanel();
    stopShortcutsGeometryLoop();
    shortcutsHost.remove();
    root.remove();
  });

  iconsCell.appendChild(infoButton);
  iconsCell.appendChild(settingsIcon);
  iconsCell.appendChild(closeIcon);

  const metadata   = createMetadataDisplay(metaCell);
  const albumActionsSlot = metadata.getAlbumTrailingSlot();
  const albumOpenLink = dom(
    'a',
    {
      class: 'bc-header-album-open',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open album in a new tab',
      'aria-label': 'Open album in a new tab'
    },
    [
      dom(
        'span',
        { class: 'bc-header-album-open-glyph', 'aria-hidden': 'true' },
        [dom('img', { class: 'bc-header-album-open-icon', src: OPEN_LINK_ICON_URL, alt: '' })]
      )
    ]
  ) as HTMLAnchorElement;
  const stopAlbumOpenPointerEvent = (event: Event): void => {
    event.stopPropagation();
  };
  albumOpenLink.addEventListener('pointerdown', stopAlbumOpenPointerEvent);
  albumOpenLink.addEventListener('mousedown', stopAlbumOpenPointerEvent);
  albumOpenLink.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const albumOpenHref = resolveAlbumOpenHref(lastInput);
    if (albumOpenHref) {
      handlers.onOpenBackgroundTab(albumOpenHref);
    }
  });
  const likeButton = createLikeButton(albumActionsSlot, {
    onToggleAlbumLike: handlers.onToggleAlbumLike
  });
  albumActionsSlot.appendChild(albumOpenLink);

  header.appendChild(metaCell);
  header.appendChild(iconsCell);
  header.appendChild(infoPanel);

  // ── Frosted glass body ────────────────────────────────────────────────
  const main = dom('div', { class: 'bc-panel-main' });

  const waveformSlot  = dom('div');
  const transportSlot = dom('div');
  const playlistSlot  = dom('div');
  const settingsSlot  = dom('div', { class: 'bc-settings-slot' });

  main.appendChild(waveformSlot);

  // Analysis, transport, and expanded tools share one vertical rhythm.
  const controlsRow  = dom('div', { class: 'bc-controls-row' });
  controlsRow.appendChild(transportSlot);
  main.appendChild(controlsRow);
  main.appendChild(playlistSlot);

  const resizeHandles: ResizeHandle[] = [
    {
      corner: 'top-left',
      element: dom('span', { class: 'bc-resize-handle bc-resize-handle-top-left', 'aria-hidden': 'true' }),
    },
    {
      corner: 'top-right',
      element: dom('span', { class: 'bc-resize-handle bc-resize-handle-top-right', 'aria-hidden': 'true' }),
    },
    {
      corner: 'bottom-left',
      element: dom('span', { class: 'bc-resize-handle bc-resize-handle-bottom-left', 'aria-hidden': 'true' }),
    },
    {
      corner: 'bottom-right',
      element: dom('span', { class: 'bc-resize-handle bc-resize-handle-bottom-right', 'aria-hidden': 'true' }),
    },
  ];

  root.appendChild(header);
  root.appendChild(main);
  root.appendChild(settingsSlot);
  for (const handle of resizeHandles) {
    root.appendChild(handle.element);
  }
  document.body.appendChild(root);
  document.body.appendChild(shortcutsHost);
  // Liquid-glass surface + Alt+G tuner. Created after the root is attached so
  // the glass ResizeObserver's initial fire sees real panel dimensions.
  const panelGlass = createPanelGlass(root);
  const appearancePanel = createAppearancePanel(panelGlass, root);
  const whyTwoKeysPanel = createWhyTwoKeysPanel(root);

  whyTwoKeysButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setInfoOpen(false);
    whyTwoKeysPanel.toggle();
  });
  whyTwoKeysButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setInfoOpen(false);
    whyTwoKeysPanel.toggle();
  });
  openDebuggerButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setInfoOpen(false);
    debugOptions.onOpenDebugger?.();
  });
  openDebuggerButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setInfoOpen(false);
    debugOptions.onOpenDebugger?.();
  });

  const standardScale = getPanelScale(root);
  const minScale = standardScale * 0.7;
  const maxScale = standardScale * 1.1;
  let panelScaleCommitted = false;
  let panelPositionCommitted = false;

  const restoreStoredPanelGeometry = (storedScale: number | null, storedPosition: PanelPosition | null): void => {
    if (!panelScaleCommitted && storedScale !== null) {
      const restoredScale = clamp(storedScale, minScale, maxScale);
      setPanelScale(root, restoredScale);
      if (restoredScale !== storedScale) {
        writeStoredPanelScale(restoredScale);
      }
    }

    if (!panelPositionCommitted && storedPosition !== null) {
      const restoredPosition = applyPanelPosition(root, storedPosition);
      if (restoredPosition.left !== storedPosition.left || restoredPosition.top !== storedPosition.top) {
        writeStoredPanelPosition(restoredPosition);
      }
    }
  };

  void Promise.all([readStoredPanelScale(), readStoredPanelPosition()]).then(([storedScale, storedPosition]) => {
    restoreStoredPanelGeometry(storedScale, storedPosition);
  });

  // Both left cells are drag handles
  const destroyDrag = makeDraggable(root, metadata.getDragHandles(), (position) => {
    panelPositionCommitted = true;
    writeStoredPanelPosition(position);
  });
  const destroyResize = makeResizable(root, resizeHandles, standardScale, (scale, position) => {
    panelScaleCommitted = true;
    panelPositionCommitted = true;
    writeStoredPanelScale(scale);
    writeStoredPanelPosition(position);
  });

  // ── Component instances ───────────────────────────────────────────────
  const waveform  = createWaveformCanvas(waveformSlot, {
    onSeekToFraction: handlers.onSeekToFraction,
    onDebugTrace: debugOptions.onWaveformDebugTrace,
    onPerformance: debugOptions.onWaveformPerformance
  });
  const transport = createTransport(transportSlot, {
    onPrevTrack:       handlers.onPrevTrack,
    onTogglePlayPause: handlers.onTogglePlayPause,
    onSetVolume:       handlers.onSetVolume,
    onNextTrack:       handlers.onNextTrack,
    onSetTempoAdjustOffsetBpm: handlers.onSetTempoAdjustOffsetBpm,
    onSetTempoAdjustMasterTempoEnabled: handlers.onSetTempoAdjustMasterTempoEnabled,
    onToggleTap() {
      tapOpen = !tapOpen;
      tapTempo.update(!tapOpen, lastInput);
      transport.setTapOpen(tapOpen);
    },
  });
  const bpmDisplay = createBpmDisplay(transport.getBottomSlot());
  const warningBanner = createWarningBanner(transport.getBottomSlot());
  // Orphaned content script (extension reloaded/updated): native audio keeps
  // playing but BPM/waveform/metadata are dead. Surface a sticky reload notice the
  // moment it is detected, instead of failing silently. One-way latch (see
  // extension-context.ts), so once shown it must win over transient like notices.
  const unsubscribeContextNotice = onExtensionContextInvalidated(() => {
    warningBanner.update(EXTENSION_RELOADED_NOTICE, true);
  });
  const tapTempo   = createTapTempo(transport.getTapSlot());
  const playlist   = createPlaylistView(playlistSlot, {
    onSelectPlaylistTrack: handlers.onSelectPlaylistTrack,
    onTogglePlaylistSort: handlers.onTogglePlaylistSort,
    onToggleTrackLike: handlers.onToggleTrackLike,
    onOpenBackgroundTab: handlers.onOpenBackgroundTab
  });
  const settings = createSettings(settingsSlot, {
    onTogglePreloadTracks: handlers.onTogglePreloadTracks,
    onToggleKeyAnalysis: handlers.onToggleKeyAnalysis,
    onToggleAutoPlay: handlers.onToggleAutoPlay,
    onTogglePerformanceMode: handlers.onTogglePerformanceMode,
    onOpenKeyboardShortcuts() {
      setShortcutSettingsOpen(!shortcutSettingsOpen);
    },
    onEditAppearance() {
      setSettingsOpen(false);
      appearancePanel.open();
    }
  });
  const keyboardShortcutsPanel = createKeyboardShortcutsPanel(shortcutsHost, {
    onChange(shortcuts) {
      handlers.onKeyboardShortcutsChanged(shortcuts);
    }
  });
  const welcomeGate = createWelcomeGate();
  welcomeGate.mount(root);

  // [TAP] toggles the tapper row above the playlist
  let tapOpen = false;
  let lastInput: PanelInput = {
    ...input,
    metadata: input.metadata ?? DEFAULT_TRACK_METADATA,
    playlist: input.playlist ?? DEFAULT_PLAYLIST_STATE,
    likeState: input.likeState ?? DEFAULT_LIKE_VIEW_STATE,
    keyAnalysisEnabled: Boolean(input.keyAnalysisEnabled),
    autoPlayEnabled: Boolean(input.autoPlayEnabled),
    keyboardShortcuts: normalizeShortcutMap(input.keyboardShortcuts || DEFAULT_KEYBOARD_SHORTCUTS)
  };
  const mediaSessionController = createPanelMediaSessionController(handlers, () => lastInput);
  tapTempo.update(true, lastInput); // hidden initially
  root.classList.remove('bc-tap-open');

  settingsIcon.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!settingsOpen) {
      setInfoOpen(false);
    }
    setSettingsOpen(!settingsOpen);
  });
  root.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }

    if (settingsOpen) {
      if (!(settingsSlot.contains(target) || shortcutsHost.contains(target) || settingsIcon.contains(target))) {
        setSettingsOpen(false);
      }
    }

    if (infoOpen && !(infoPanel.contains(target) || infoButton.contains(target))) {
      setInfoOpen(false);
    }
  });

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setInfoOpen(false);
      setSettingsOpen(false);
      whyTwoKeysPanel.close();
      return;
    }

    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const target = event.target as Node | null;
    if (settingsOpen && target && (settingsSlot.contains(target) || shortcutsHost.contains(target))) {
      return;
    }
    if (isEditableShortcutEvent(event)) {
      return;
    }

    const action = findShortcutActionByKey(
      normalizeShortcutMap(lastInput.keyboardShortcuts || DEFAULT_KEYBOARD_SHORTCUTS),
      shortcutKeyFromKeyboardEvent(event)
    );
    if (!action) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (action === 'toggle-play-pause') {
      handlers.onTogglePlayPause();
      return;
    }
    if (action === 'previous-track') {
      handlers.onPrevTrack();
      return;
    }
    if (action === 'next-track') {
      handlers.onNextTrack();
      return;
    }
    if (action === 'seek-backward' || action === 'seek-forward') {
      const duration = Number(lastInput.durationSec || 0);
      if (duration <= 0) {
        return;
      }
      const direction = action === 'seek-forward' ? 1 : -1;
      const currentTime = Number.isFinite(lastInput.currentTimeSec) ? Number(lastInput.currentTimeSec) : 0;
      handlers.onSeekToFraction(Math.max(0, Math.min(1, (currentTime + direction * KEYBOARD_SEEK_STEP_SECONDS) / duration)));
      return;
    }
    if (action === 'tap-tempo') {
      if (!tapOpen) {
        tapOpen = true;
        transport.setTapOpen(true);
        tapTempo.update(false, lastInput);
      }
      tapTempo.tapFromShortcut();
      return;
    }
    if (action === 'tempo-up' || action === 'tempo-down') {
      const currentOffset = Number(lastInput.tempoAdjust?.offsetBpm || 0);
      const direction = action === 'tempo-up' ? 1 : -1;
      handlers.onSetTempoAdjustOffsetBpm(currentOffset + direction * KEYBOARD_TEMPO_STEP_BPM);
    }
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (settingsOpen) {
      if (!(target && (settingsSlot.contains(target) || shortcutsHost.contains(target) || settingsIcon.contains(target)))) {
        setSettingsOpen(false);
      }
    }

    if (!infoOpen) {
      return;
    }

    if (!target) {
      setInfoOpen(false);
      return;
    }

    if (infoPanel.contains(target) || infoButton.contains(target)) {
      return;
    }

    setInfoOpen(false);
  };
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);

  const apply = (next: PanelInput): void => {
    lastInput = {
      ...next,
      keyboardShortcuts: normalizeShortcutMap(next.keyboardShortcuts || DEFAULT_KEYBOARD_SHORTCUTS)
    };
    const panelIdle = isPanelIdle(next);
    root.classList.toggle('bc-panel-idle', panelIdle);
    // One global rule for the "Open album in a new tab" affordance: surface it
    // only when the panel is active and we have a real album URL to open. An
    // idle panel never shows it, on every page type. The album URL itself is
    // supplied by the state builders; the panel owns the visibility decision.
    const albumOpenHref = panelIdle ? '' : resolveAlbumOpenHref(next);
    if (albumOpenHref) {
      albumOpenLink.href = albumOpenHref;
      albumOpenLink.removeAttribute('aria-disabled');
    } else {
      albumOpenLink.removeAttribute('href');
      albumOpenLink.setAttribute('aria-disabled', 'true');
    }
    albumOpenLink.classList.toggle('bc-header-album-open-disabled', !albumOpenHref);
    metadata.update(
      next.metadata,
      resolveCurrentPlaylistTrackTitle(next),
      Boolean(next.metadataLoading ?? next.playlist.loading)
    );
    transport.update(next);
    const hasFinalAnalysisStatus = /^(BPM:|Analysis failed|BPM failed)/i.test(String(next.analysis?.analysisStatus || ''));
    const isAnalysisStillRunning =
      Boolean(next.analysis?.analysisStatus)
      && !hasFinalAnalysisStatus;
    const suppressProvisionalBpm = shouldSuppressProvisionalLowBandTempo(next.analysis?.bpm, {
      isAnalyzing: isAnalysisStillRunning,
      analysisStatus: next.analysis?.analysisStatus
    });
    const hidePendingActiveTrackBpm = isAnalysisStillRunning || suppressProvisionalBpm;
    const playlistCurrentTrack = next.playlist.tracks[next.playlist.currentIndex];
    const playlistCurrentTrackBpm = Number.isFinite(playlistCurrentTrack?.bpm)
      ? Number(playlistCurrentTrack?.bpm)
      : undefined;
    const resolvedMainBpm = hidePendingActiveTrackBpm
      ? undefined
      : (Number.isFinite(next.analysis?.bpm) ? Number(next.analysis?.bpm) : playlistCurrentTrackBpm);
    bpmDisplay.update({
      isIdle: panelIdle,
      isPlaying: next.isPlaying,
      currentTimeSec: next.currentTimeSec,
      durationSec: next.durationSec,
      bpm: resolvedMainBpm,
      confidence: Number.isFinite(next.analysis?.confidence)
        ? next.analysis?.confidence
        : next.analysis?.tempoDecisionConfidence,
      keyAnalysisEnabled: Boolean(next.keyAnalysisEnabled),
      keyAnalysis: next.keyAnalysisEnabled ? next.analysis?.keyAnalysis : undefined,
      keyStatus: next.keyAnalysisEnabled ? next.analysis?.keyStatus : 'disabled',
      keyUnavailable:
        next.keyAnalysisEnabled
        && (next.analysis?.keyStatus === 'empty' || next.analysis?.keyStatus === 'error'),
      keyAnalysisCompleted:
        next.keyAnalysisEnabled
        && (
          next.analysis?.keyStatus === 'ready'
          || next.analysis?.keyStatus === 'empty'
          || next.analysis?.keyStatus === 'error'
        ),
      isAnalyzing: hidePendingActiveTrackBpm
    });
    waveform.update(next);
    tapTempo.update(!tapOpen, next);
    playlist.update(
      next.playlist,
      next.likeState,
      next.keyAnalysisEnabled,
      next.runtimePlaylistPreparation,
      next.runtimePlaylistSelectionPending
    );
    if (isExtensionContextValid()) {
      warningBanner.update(String(next.likeNotice || '').trim());
    } else {
      warningBanner.update(EXTENSION_RELOADED_NOTICE, true);
    }
    mediaSessionController.sync(lastInput);
    settings.update({
      hidden: !settingsOpen,
      preloadTracks: Boolean(next.preloadTracks),
      keyAnalysisEnabled: Boolean(next.keyAnalysisEnabled),
      autoPlayEnabled: Boolean(next.autoPlayEnabled),
      performanceModeEnabled: Boolean(next.performanceModeEnabled)
    });
    keyboardShortcutsPanel.update({
      hidden: !settingsOpen || !shortcutSettingsOpen,
      shortcuts: next.keyboardShortcuts
    });
    syncShortcutsHostGeometry();
    likeButton.update(next);
    applyThemeClass(root);
  };

  apply({
    ...input,
    metadata:  input.metadata  ?? DEFAULT_TRACK_METADATA,
    playlist:  input.playlist  ?? DEFAULT_PLAYLIST_STATE,
    likeState: input.likeState ?? DEFAULT_LIKE_VIEW_STATE,
    keyAnalysisEnabled: Boolean(input.keyAnalysisEnabled),
    autoPlayEnabled: Boolean(input.autoPlayEnabled)
  });

  return {
    update(next) {
      apply({
        ...next,
        metadata:  next.metadata  ?? DEFAULT_TRACK_METADATA,
        playlist:  next.playlist  ?? DEFAULT_PLAYLIST_STATE,
        likeState: next.likeState ?? DEFAULT_LIKE_VIEW_STATE,
        keyAnalysisEnabled: Boolean(next.keyAnalysisEnabled),
        autoPlayEnabled: Boolean(next.autoPlayEnabled)
      });
    },
    destroy() {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      stopShortcutsGeometryLoop();
      mediaSessionController.destroy();
      waveform.destroy();
      transport.destroy();
      bpmDisplay.destroy();
      tapTempo.destroy();
      playlist.destroy();
      unsubscribeContextNotice();
      warningBanner.destroy();
      settings.destroy();
      keyboardShortcutsPanel.destroy();
      welcomeGate.destroy();
      whyTwoKeysPanel.destroy();
      appearancePanel.destroy();
      panelGlass.destroy();
      likeButton.destroy();
      metadata.destroy();
      destroyDrag();
      destroyResize();
      shortcutsHost.remove();
      root.remove();
    },
  };
}
