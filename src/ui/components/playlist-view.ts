import type {
  LikeState,
  LikeViewState,
  PlaylistState,
  PlaylistTrack,
  RuntimePlaylistPreparationUiState
} from '@/shared/types';
import { shouldSuppressProvisionalLowBandTempo } from '@/shared/tempo-display';
import { dom, setText } from '@/utils/dom';
import { extensionAssetUrl } from '@/utils/asset-url';
import { isHttpsReleasePageUrl, normalizeReleaseUrl } from '@/content/metadata/common';

export interface PlaylistViewComponent {
  update(
    state: PlaylistState,
    likeState?: LikeViewState,
    keyAnalysisEnabled?: boolean,
    runtimePlaylistPreparation?: RuntimePlaylistPreparationUiState,
    runtimePlaylistSelectionPending?: boolean
  ): void;
  destroy(): void;
}

interface PlaylistHandlers {
  onSelectPlaylistTrack(index: number): void;
  onTogglePlaylistSort(key: PlaylistState['sortKey']): void;
  onToggleTrackLike(index: number): void;
  onOpenBackgroundTab(url: string): void;
}

interface UserSelectionState {
  playlistSignature: string;
  trackKey: string;
}

type LikeUiMode = 'default' | 'loading' | 'error' | 'idle';
type PrepIndicatorMode = 'hidden' | 'preparing' | 'error';

const PLAYLIST_BATCH_SIZE = 4;
const PLAYLIST_EXPAND_ICON_URL = extensionAssetUrl('public/expand.svg');
const PLAYLIST_COLLAPS_ICON_URL = extensionAssetUrl('public/collaps.svg');
const PLAYLIST_OPEN_ICON_URL = extensionAssetUrl('public/new-tab.svg');
const RUNTIME_TITLE_WAVE_DURATION_MS = 3000;

function formatDuration(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function resolveTrackKey(track: PlaylistTrack): string {
  return track.cacheKey || track.trackId || String(track.index);
}

function resolveTrackOpenHref(track: PlaylistTrack): string {
  const normalized = normalizeReleaseUrl(String(track.pageUrl || '').trim());
  if (!normalized || !normalized.includes('/track/')) {
    return '';
  }
  return isHttpsReleasePageUrl(normalized) ? normalized : '';
}

function buildPlaylistSignature(state: PlaylistState): string {
  return state.tracks.map((track) => resolveTrackKey(track)).join('|');
}

function resolveLikeUiMode(state: PlaylistState, likeState: LikeViewState): LikeUiMode {
  const syncError = String(likeState.notice || '').trim() === 'sync-error';
  if (syncError) {
    return 'error';
  }
  if (likeState.loading) {
    return 'loading';
  }
  if (!state.tracks.length) {
    return 'idle';
  }
  return 'default';
}

function buildTrackRow(
  track: PlaylistTrack,
  sortedIndex: number,
  handlers: PlaylistHandlers,
  onUserSelect: (track: PlaylistTrack) => void,
  likeUiMode: LikeUiMode,
  likeDisabled: boolean,
  albumState: LikeState,
  runtimeSelectionPending: boolean
): HTMLElement {
  const buildKeyCell = (
    value: string | undefined,
    loading: boolean | undefined
  ): HTMLElement => {
    const cell = dom('div', { class: 'bc-pl-key' });
    if (loading) {
      cell.classList.add('is-loading');
      cell.appendChild(dom('span', { class: 'bc-pl-bpm-loading-icon', 'aria-hidden': 'true' }));
      return cell;
    }

    const label = dom('span', { class: 'bc-pl-key-text' }, [String(value || '—')]);
    cell.appendChild(label);
    return cell;
  };

  const idx   = dom('div', { class: 'bc-pl-idx' }, [String(track.index + 1)]);
  const title = dom('div', { class: 'bc-pl-title' });
  const k1    = buildKeyCell(track.key1, track.key1Loading);
  const k2    = buildKeyCell(track.key2, track.key2Loading);
  const bpm   = dom('div', { class: 'bc-pl-bpm' });
  const roundedBpm = Number(track.bpm);
  const suppressProvisionalBpm = shouldSuppressProvisionalLowBandTempo(
    Number.isFinite(roundedBpm) ? roundedBpm : undefined,
    { isAnalyzing: Boolean(track.isAnalyzing) }
  );
  const showBpmLoading =
    Boolean(track.isAnalyzing) && (!Number.isFinite(roundedBpm) || suppressProvisionalBpm);
  const showBpmFailure = !showBpmLoading && Boolean(track.analysisFailed) && !Number.isFinite(roundedBpm);
  if (showBpmLoading) {
    bpm.classList.add('is-loading');
    bpm.appendChild(dom('span', { class: 'bc-pl-bpm-loading-icon', 'aria-hidden': 'true' }));
  } else if (showBpmFailure) {
    bpm.classList.add('is-failed');
    setText(bpm, '!');
  } else {
    setText(bpm, Number.isFinite(roundedBpm) ? String(Math.round(roundedBpm)) : '—');
  }
  const dur   = dom('div', { class: 'bc-pl-dur' }, [formatDuration(track.durationSec)]);
  const openHref = resolveTrackOpenHref(track);
  const open = dom('div', { class: 'bc-pl-open' });
  if (openHref) {
    const openLink = dom(
      'a',
      {
        class: 'bc-pl-open-link',
        href: openHref,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Open track in a new tab',
        'aria-label': 'Open track in a new tab'
      },
      [dom('img', { class: 'bc-pl-open-icon', src: PLAYLIST_OPEN_ICON_URL, alt: '', 'aria-hidden': 'true' })]
    );
    const stopOpenPointerEvent = (event: Event): void => {
      event.stopPropagation();
    };
    const activateOpenLink = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      handlers.onOpenBackgroundTab(openHref);
    };
    openLink.addEventListener('pointerdown', stopOpenPointerEvent);
    openLink.addEventListener('mousedown', stopOpenPointerEvent);
    openLink.addEventListener('click', activateOpenLink);
    open.appendChild(openLink);
  } else {
    open.classList.add('bc-pl-open-empty');
  }
  const like  = dom('div', { class: 'bc-pl-like' });
  const likeSymbol = dom('span', { class: 'bc-heart-symbol', 'aria-hidden': 'true' }, ['♥']);

  const titleLabel = track.title || `Track ${track.index + 1}`;
  setText(title, titleLabel);

  if (likeUiMode === 'loading' && track.likeState === 'unknown') {
    like.classList.add('loading');
    likeSymbol.classList.add('bc-heart-loading');
    like.appendChild(likeSymbol);
  } else if (likeUiMode === 'error') {
    like.classList.add('error');
    setText(likeSymbol, '!');
    like.appendChild(likeSymbol);
  } else if (track.likeState === 'bought') {
    like.classList.add('bought');
    like.appendChild(likeSymbol);
  } else if (track.likeState === 'liked') {
    like.classList.add('liked');
    like.appendChild(likeSymbol);
  } else if (track.likeState === 'unknown') {
    if (likeUiMode === 'idle') {
      like.classList.add('idle');
    } else {
      like.classList.add('unknown');
    }
    like.appendChild(likeSymbol);
  } else {
    like.classList.add('empty');
    like.appendChild(likeSymbol);
  }

  const boughtLocked = track.likeState === 'bought' || albumState === 'bought';
  const softLikeDisabled = likeDisabled && !boughtLocked;
  const effectiveLikeDisabled = softLikeDisabled || boughtLocked;
  if (effectiveLikeDisabled) {
    like.classList.add('disabled');
    like.setAttribute('aria-disabled', 'true');
  } else {
    like.setAttribute('aria-disabled', 'false');
  }
  const likeTitle = track.likeState === 'bought'
    ? 'You own this'
    : track.likeState === 'liked'
      ? 'Remove track from your wishlist'
      : 'Add track to your wishlist';
  like.title = likeTitle;
  like.setAttribute('aria-label', likeTitle);
  let likePointerHandled = false;
  like.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (boughtLocked) {
      return;
    }
    likePointerHandled = true;
    handlers.onToggleTrackLike(sortedIndex);
  });
  like.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (boughtLocked) {
      return;
    }
    if (likePointerHandled) {
      likePointerHandled = false;
      return;
    }
    handlers.onToggleTrackLike(sortedIndex);
  });

  const isPlayable = track.playable !== false;
  const classNames = ['bc-pl-track'];
  if (track.isCurrent) {
    classNames.push('active');
  }
  if (runtimeSelectionPending) {
    title.classList.add('bc-pl-title-runtime-pending');
    const titleText = dom('span', { class: 'bc-pl-title-runtime-text' }, [
      dom('span', { class: 'bc-pl-title-runtime-base' }, [titleLabel]),
      dom('span', { class: 'bc-pl-title-runtime-highlight', 'aria-hidden': 'true' }, [titleLabel])
    ]);
    const wavePhaseMs = Math.round(performance.now() % RUNTIME_TITLE_WAVE_DURATION_MS);
    titleText.style.setProperty('--bc-pl-title-runtime-wave-delay', `-${wavePhaseMs}ms`);
    title.replaceChildren(titleText);
    classNames.push('bc-pl-track-runtime-pending');
  }
  if (!isPlayable) {
    classNames.push('bc-pl-track-disabled');
  }

  const row = dom('div', { class: classNames.join(' ') });
  const selectTarget = dom('div', { class: 'bc-pl-select-target' }, [
    idx,
    title,
    k1,
    k2,
  ]);
  row.appendChild(selectTarget);
  row.appendChild(bpm);
  row.appendChild(dur);
  row.appendChild(like);
  row.appendChild(open);

  if (runtimeSelectionPending) {
    row.setAttribute('aria-busy', 'true');
    selectTarget.setAttribute('aria-label', `${titleLabel} loading for playback`);
  }

  if (!isPlayable) {
    row.setAttribute('aria-disabled', 'true');
    return row;
  }

  selectTarget.setAttribute('role', 'button');
  selectTarget.setAttribute('tabindex', '0');
  let pointerHandled = false;
  selectTarget.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    pointerHandled = true;
    event.preventDefault();
    onUserSelect(track);
    handlers.onSelectPlaylistTrack(sortedIndex);
  });

  selectTarget.addEventListener('click', (event) => {
    event.preventDefault();
    if (pointerHandled) {
      pointerHandled = false;
      return;
    }
    onUserSelect(track);
    handlers.onSelectPlaylistTrack(sortedIndex);
  });

  selectTarget.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    onUserSelect(track);
    handlers.onSelectPlaylistTrack(sortedIndex);
  });

  return row;
}

export function createPlaylistView(container: HTMLElement, handlers: PlaylistHandlers): PlaylistViewComponent {
  const headerIndex = dom('div', { class: 'bc-pl-col bc-pl-col-idx bc-pl-sort-col', role: 'button', tabindex: '0' });
  const headerTitle = dom('div', { class: 'bc-pl-col bc-pl-col-title' }, ['Title']);
  const headerK1 = dom('div', { class: 'bc-pl-col bc-pl-col-key bc-pl-sort-col', role: 'button', tabindex: '0' });
  const headerK2 = dom('div', { class: 'bc-pl-col bc-pl-col-key bc-pl-sort-col', role: 'button', tabindex: '0' });
  const headerBpm = dom('div', { class: 'bc-pl-col bc-pl-col-bpm bc-pl-sort-col', role: 'button', tabindex: '0' });
  const prepIndicator = dom('span', {
    class: 'bc-pl-prep-indicator',
    'aria-hidden': 'true'
  });
  const headerPrep = dom('div', { class: 'bc-pl-col bc-pl-col-prep' }, [prepIndicator]);
  const header = dom('div', { class: 'bc-pl-header' }, [
    headerIndex,
    headerTitle,
    headerK1,
    headerK2,
    headerBpm,
    dom('div', { class: 'bc-pl-col bc-pl-col-dur' }, ['T']),
    dom('div', { class: 'bc-pl-col bc-pl-col-like' }),
    headerPrep,
  ]);

  const list   = dom('div', { class: 'bc-pl-list' });
  const statusRow = dom('div', { class: 'bc-pl-empty' }, ['']);

  const root = dom('div', { class: 'bc-playlist' });
  root.appendChild(header);
  root.appendChild(list);
  root.appendChild(statusRow);
  container.appendChild(root);

  let isExpanded = false;
  let currentState: PlaylistState | null = null;
  let hasTracklistAttempt = false;
  let lastAutoScrollKey = '';
  let lastRenderKey = '';
  let lastPlaylistSignature = '';
  let pendingUserSelection: UserSelectionState | null = null;
  let previousLoading = false;
  let previousTrackCount = 0;
  let currentLikeState: LikeViewState = {
    albumState: 'unknown',
    loading: false,
    disabled: false,
    trackStates: {}
  };
  let keyAnalysisEnabled = false;
  let currentRuntimePrep: RuntimePlaylistPreparationUiState | undefined;
  let currentRuntimeSelectionPending = false;

  const syncHeaderScrollbarGutter = (): void => {
    const scrollbarGutterWidth = Math.max(0, list.offsetWidth - list.clientWidth);
    root.style.setProperty('--pl-scrollbar-gutter-width', `${scrollbarGutterWidth}px`);
  };

  const buildRenderKey = (
    state: PlaylistState,
    likeState: LikeViewState,
    runtimePrep: RuntimePlaylistPreparationUiState | undefined,
    runtimeSelectionPending: boolean
  ): string => {
    const trackKey = state.tracks
      .map((track) => [
        track.cacheKey || track.trackId || String(track.index),
        track.isCurrent ? '1' : '0',
        String(track.key1 || '-'),
        String(track.key2 || '-'),
        String(track.key1Level || '-'),
        String(track.key2Level || '-'),
        track.key1Loading ? '1' : '0',
        track.key2Loading ? '1' : '0',
        Number.isFinite(track.bpm) ? String(Math.round(Number(track.bpm))) : '-',
        track.isAnalyzing ? '1' : '0',
        track.analysisFailed ? '1' : '0',
        track.likeState || '-',
        track.pageUrl || '-',
        track.playable === false ? '0' : '1'
      ].join(':'))
      .join('|');
    return [
      state.loading ? '1' : '0',
      likeState.loading ? '1' : '0',
      likeState.disabled ? '1' : '0',
      String(likeState.notice || '-'),
      state.currentIndex,
      state.sortKey,
      state.sortAsc ? '1' : '0',
      keyAnalysisEnabled ? '1' : '0',
      runtimePrep?.status || '-',
      runtimePrep?.prepared ?? '-',
      runtimePrep?.total ?? '-',
      runtimePrep?.active ?? '-',
      runtimePrep?.capacity ?? '-',
      runtimePrep?.detail || '-',
      runtimeSelectionPending ? '1' : '0',
      isExpanded ? '1' : '0',
      state.tracks.length,
      trackKey
    ].join('#');
  };

  const renderPrepIndicator = (runtimePrep: RuntimePlaylistPreparationUiState | undefined): void => {
    const mode: PrepIndicatorMode =
      runtimePrep?.status === 'preparing'
        ? 'preparing'
        : (runtimePrep?.status === 'error' ? 'error' : 'hidden');
    prepIndicator.classList.toggle('bc-pl-prep-indicator-visible', mode !== 'hidden');
    prepIndicator.classList.toggle('bc-pl-prep-indicator-error', mode === 'error');
    prepIndicator.setAttribute('aria-hidden', mode === 'hidden' ? 'true' : 'false');

    if (mode === 'preparing') {
      prepIndicator.title = 'Playlist preparation in progress';
      prepIndicator.setAttribute('aria-label', 'Playlist preparation in progress');
      prepIndicator.replaceChildren(dom('span', { class: 'bc-pl-bpm-loading-icon', 'aria-hidden': 'true' }));
      return;
    }

    if (mode === 'error') {
      prepIndicator.title = String(runtimePrep?.detail || 'Playlist preparation error');
      prepIndicator.setAttribute('aria-label', 'Playlist preparation error');
      prepIndicator.replaceChildren('!');
      return;
    }

    prepIndicator.removeAttribute('title');
    prepIndicator.removeAttribute('aria-label');
    prepIndicator.replaceChildren();
  };

  const renderSortLabel = (
    element: HTMLElement,
    label: string,
    symbol: string,
    active: boolean
  ): void => {
    element.replaceChildren(
      dom('span', { class: 'bc-pl-sort-label' }, [label]),
      dom('span', { class: `bc-pl-sort-symbol${active ? ' bc-pl-sort-symbol-active' : ''}` }, [symbol])
    );
  };

  const render = (state: PlaylistState, likeState: LikeViewState): void => {
    const likeUiMode = resolveLikeUiMode(state, likeState);
    root.classList.toggle('bc-key-disabled', !keyAnalysisEnabled);

    renderSortLabel(headerIndex, '#', '↑', state.sortKey === 'index');
    renderSortLabel(headerK1, 'K1', state.sortKey === 'key' ? (state.sortAsc ? '↑' : '↓') : '↕', state.sortKey === 'key');
    renderSortLabel(headerK2, 'K2', state.sortKey === 'key2' ? (state.sortAsc ? '↑' : '↓') : '↕', state.sortKey === 'key2');
    renderSortLabel(headerBpm, 'BPM', state.sortKey === 'bpm' ? (state.sortAsc ? '↑' : '↓') : '↕', state.sortKey === 'bpm');
    headerIndex.classList.toggle('bc-pl-sort-active', state.sortKey === 'index');
    headerK1.classList.toggle('bc-pl-sort-active', state.sortKey === 'key');
    headerK2.classList.toggle('bc-pl-sort-active', state.sortKey === 'key2');
    headerBpm.classList.toggle('bc-pl-sort-active', state.sortKey === 'bpm');
    renderPrepIndicator(currentRuntimePrep);

    list.replaceChildren();
    root.classList.toggle('bc-playlist-expanded', isExpanded);

    if (state.loading || state.tracks.length > 0) {
      hasTracklistAttempt = true;
    }

    const canExpand = state.tracks.length > PLAYLIST_BATCH_SIZE;
    root.classList.toggle('bc-playlist-scrollable', canExpand);
    let statusText = '';
    let statusMode: 'idle' | 'loading' | 'empty' | 'expand' | 'collapse' = 'idle';
    if (state.loading) {
      statusText = 'playlist loading...';
      statusMode = 'loading';
    } else if (!state.tracks.length && hasTracklistAttempt) {
      statusText = 'No tracks found on this page';
      statusMode = 'empty';
    } else if (canExpand) {
      statusText = '';
      statusMode = isExpanded ? 'collapse' : 'expand';
    }
    if (statusMode === 'expand' || statusMode === 'collapse') {
      const iconUrl = statusMode === 'collapse' ? PLAYLIST_COLLAPS_ICON_URL : PLAYLIST_EXPAND_ICON_URL;
      statusRow.replaceChildren(
        dom('img', {
          class: 'bc-pl-toggle-icon',
          src: iconUrl,
          alt: statusMode === 'collapse' ? 'Collapse playlist' : 'Expand playlist',
          'aria-hidden': 'true'
        })
      );
    } else {
      setText(statusRow, statusText);
    }
    statusRow.dataset.mode = statusMode;
    statusRow.style.display = 'flex';
    statusRow.style.cursor = statusMode === 'expand' || statusMode === 'collapse' ? 'pointer' : 'default';

    if (!state.tracks.length) {
      root.classList.remove('bc-playlist-expanded');
      return;
    }

    state.tracks.forEach((track, sortedIndex) => {
      list.appendChild(
        buildTrackRow(track, sortedIndex, handlers, (selectedTrack) => {
          pendingUserSelection = {
            playlistSignature: lastPlaylistSignature,
            trackKey: resolveTrackKey(selectedTrack),
          };
        }, likeUiMode, likeState.disabled, likeState.albumState, currentRuntimeSelectionPending && track.isCurrent)
      );
    });

    window.requestAnimationFrame(() => {
      syncHeaderScrollbarGutter();
    });
  };

  const maybeAutoScrollToCurrent = (state: PlaylistState): void => {
    if (state.tracks.length <= PLAYLIST_BATCH_SIZE) {
      return;
    }
    if (state.currentIndex < 0 || state.currentIndex >= state.tracks.length) {
      return;
    }
    const currentTrack = state.tracks[state.currentIndex];
    const currentTrackKey = resolveTrackKey(currentTrack);
    const scrollKey = `${state.currentIndex}:${currentTrackKey}:${state.tracks.length}`;
    if (
      pendingUserSelection &&
      pendingUserSelection.playlistSignature === lastPlaylistSignature &&
      pendingUserSelection.trackKey === currentTrackKey
    ) {
      pendingUserSelection = null;
      // Mark this key as handled so follow-up updates for the same track do not jump.
      lastAutoScrollKey = scrollKey;
      return;
    }
    if (scrollKey === lastAutoScrollKey) {
      return;
    }
    lastAutoScrollKey = scrollKey;

    window.requestAnimationFrame(() => {
      const activeRow = list.querySelector<HTMLElement>('.bc-pl-track.active');
      if (!activeRow) {
        return;
      }
      activeRow.scrollIntoView({ block: 'nearest' });
    });
  };

  const triggerReadyReveal = (): void => {
    root.classList.remove('bc-playlist-ready-reveal');
    // Force reflow so repeated ready transitions can retrigger the animation.
    void list.offsetHeight;
    root.classList.add('bc-playlist-ready-reveal');
  };

  statusRow.addEventListener('click', () => {
    if (!currentState || currentState.loading || currentState.tracks.length <= PLAYLIST_BATCH_SIZE) {
      return;
    }
    isExpanded = !isExpanded;
    render(currentState, currentLikeState);
  });

  const bindSort = (el: HTMLElement, key: PlaylistState['sortKey']): void => {
    el.addEventListener('click', () => {
      handlers.onTogglePlaylistSort(key);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      handlers.onTogglePlaylistSort(key);
    });
  };
  bindSort(headerIndex, 'index');
  bindSort(headerK1, 'key');
  bindSort(headerK2, 'key2');
  bindSort(headerBpm, 'bpm');

  return {
    update(state, likeState, keyAnalysisEnabledInput, runtimePlaylistPreparation, runtimePlaylistSelectionPending) {
      keyAnalysisEnabled = Boolean(keyAnalysisEnabledInput);
      currentRuntimePrep = runtimePlaylistPreparation;
      currentRuntimeSelectionPending = Boolean(runtimePlaylistSelectionPending);
      const shouldReveal =
        state.tracks.length > 0
        && !state.loading
        && (previousLoading || previousTrackCount === 0);

      currentState = state;
      currentLikeState = likeState || currentLikeState;
      const playlistSignature = buildPlaylistSignature(state);
      if (playlistSignature !== lastPlaylistSignature) {
        lastPlaylistSignature = playlistSignature;
        pendingUserSelection = null;
        lastAutoScrollKey = '';
      }
      if (state.tracks.length <= PLAYLIST_BATCH_SIZE) {
        isExpanded = false;
      }
      const renderKey = buildRenderKey(state, currentLikeState, currentRuntimePrep, currentRuntimeSelectionPending);
      if (renderKey !== lastRenderKey) {
        lastRenderKey = renderKey;
        render(state, currentLikeState);
      } else {
        syncHeaderScrollbarGutter();
      }
      maybeAutoScrollToCurrent(state);
      if (shouldReveal) {
        triggerReadyReveal();
      }
      previousLoading = state.loading;
      previousTrackCount = state.tracks.length;
    },
    destroy() {
      root.remove();
    },
  };
}
