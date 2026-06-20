import type { TrackMetadata } from '@/shared/types';
import { dom, setText } from '@/utils/dom';

export interface MetadataDisplayComponent {
  update(metadata: TrackMetadata, currentTrackTitle: string, loading: boolean): void;
  destroy(): void;
  getDragHandles(): HTMLElement[];
  getAlbumLeadingSlot(): HTMLElement;
  getAlbumTrailingSlot(): HTMLElement;
}

function isPlaceholderValue(value: string | undefined): boolean {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '---';
}

function isIdleMetadataState(metadata: TrackMetadata, currentTrackTitle: string): boolean {
  return (
    isPlaceholderValue(metadata.artistName) &&
    isPlaceholderValue(metadata.albumTitle) &&
    isPlaceholderValue(currentTrackTitle)
  );
}

const MARQUEE_RIGHT_FADE_PX = 18;

// Idle placeholder shown when nothing is playing. Fixed constant (never user
// input), built as DOM nodes (not innerHTML) so the "//" separator can be tinted
// on its own without tripping the AMO unsafe-innerHTML lint.
const IDLE_ALBUM_LABEL = 'BANDCAMP // DECK';
function createIdleAlbumNodes(): (Node | string)[] {
  return ['BANDCAMP ', dom('span', { class: 'bc-deck-sep' }, ['//']), ' DECK'];
}

interface OscillatingText {
  container: HTMLElement;
  setValue(value: string): void;
  /** Renders trusted nodes (constant labels only); plainTitle drives the tooltip and change key. */
  setNodes(nodes: (Node | string)[], plainTitle: string): void;
  syncOverflow(): void;
}

function createOscillatingText(tagName: 'div' | 'span', className: string): OscillatingText {
  const container = dom(tagName, { class: `${className} bc-metadata-marquee` });
  const text = dom('span', { class: 'bc-metadata-marquee-text' });
  let lastValue = '';

  container.appendChild(text);

  const syncOverflow = (): void => {
    const visibleWidth = container.clientWidth;
    const fullWidth = text.scrollWidth;
    const overflowDistance = Math.max(0, fullWidth - visibleWidth);
    const isOverflowing = visibleWidth > 0 && overflowDistance > 1;

    container.classList.toggle('bc-metadata-marquee-overflowing', isOverflowing);
    if (isOverflowing) {
      const travelDistance = overflowDistance + MARQUEE_RIGHT_FADE_PX;
      const durationSeconds = Math.min(18, Math.max(7, travelDistance / 10));
      container.style.setProperty('--bc-metadata-marquee-distance', `${Math.ceil(travelDistance)}px`);
      container.style.setProperty('--bc-metadata-marquee-duration', `${durationSeconds}s`);
    } else {
      container.style.removeProperty('--bc-metadata-marquee-distance');
      container.style.removeProperty('--bc-metadata-marquee-duration');
    }
  };

  return {
    container,
    setValue(value) {
      if (value !== lastValue) {
        lastValue = value;
        setText(text, value);
        container.setAttribute('title', value.trim());
      }
      syncOverflow();
    },
    setNodes(nodes, plainTitle) {
      if (plainTitle !== lastValue) {
        lastValue = plainTitle;
        text.replaceChildren(...nodes);
        container.setAttribute('title', plainTitle.trim());
      }
      syncOverflow();
    },
    syncOverflow
  };
}

export function createMetadataDisplay(metaContainer: HTMLElement): MetadataDisplayComponent {
  const artist = createOscillatingText('div', 'bc-metadata-artist');
  const album  = dom('div', { class: 'bc-metadata-album' });
  const albumLeadingSlot = dom('div', { class: 'bc-metadata-album-leading' });
  const albumText = dom('div', { class: 'bc-metadata-album-text' });
  const albumTitle = createOscillatingText('span', 'bc-metadata-album-title');
  const albumTrailingSlot = dom('div', { class: 'bc-metadata-album-trailing' });
  const track = dom('div', { class: 'bc-metadata-track' });
  const trackTitle = createOscillatingText('span', 'bc-metadata-track-title');
  const releaseDate = dom('span', { class: 'bc-metadata-release-date' });

  albumText.appendChild(albumTitle.container);
  album.appendChild(albumText);
  track.appendChild(trackTitle.container);

  metaContainer.appendChild(artist.container);
  metaContainer.appendChild(album);
  metaContainer.appendChild(albumTrailingSlot);
  metaContainer.appendChild(track);
  metaContainer.appendChild(releaseDate);

  const resizeObserver = new ResizeObserver(() => {
    artist.syncOverflow();
    albumTitle.syncOverflow();
    trackTitle.syncOverflow();
  });
  resizeObserver.observe(metaContainer);
  resizeObserver.observe(artist.container);
  resizeObserver.observe(albumTitle.container);
  resizeObserver.observe(trackTitle.container);

  const releaseDateFormatter = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'UTC'
  });

  const readReleaseDate = (metadata: TrackMetadata): string => {
    const releaseDate = metadata.releaseDate;
    if (!releaseDate) {
      return '';
    }

    const epochMs = Number(releaseDate.epochMs);
    if (Number.isFinite(epochMs) && epochMs > 0) {
      return releaseDateFormatter.format(new Date(epochMs));
    }

    const raw = String(releaseDate.raw || '').trim();
    if (!raw) {
      return '';
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return releaseDateFormatter.format(new Date(parsed));
    }
    const match = raw.match(/\b(\d{2})[./-](\d{2})[./-](\d{2,4})\b/);
    if (!match) {
      return '';
    }
    const day = match[1];
    const month = match[2];
    const year = String(match[3] || '').slice(-2);
    return day && month && year ? `${day}.${month}.${year}` : '';
  };

  return {
    update(metadata, currentTrackTitle, loading) {
      const idleState = isIdleMetadataState(metadata, currentTrackTitle);
      const loadingState = loading;
      const artistText = loadingState
        ? 'Loading...'
        : idleState
          ? '\u00A0'
        : (isPlaceholderValue(metadata.artistName) ? '\u00A0' : metadata.artistName);
      const albumBaseText = isPlaceholderValue(metadata.albumTitle) ? '' : metadata.albumTitle;
      const releaseDateText = readReleaseDate(metadata);
      const trackText = loadingState || isPlaceholderValue(currentTrackTitle) ? '\u00A0' : currentTrackTitle;
      artist.setValue(artistText);
      artist.container.classList.toggle('bc-metadata-loading', loadingState);
      artist.container.classList.toggle('bc-metadata-idle', idleState && !loadingState);
      album.classList.toggle('bc-metadata-idle', idleState && !loadingState);
      if (loadingState) {
        albumTitle.setValue('\u00A0');
      } else if (idleState) {
        albumTitle.setNodes(createIdleAlbumNodes(), IDLE_ALBUM_LABEL);
      } else {
        albumTitle.setValue(albumBaseText || '\u00A0');
      }
      trackTitle.setValue(trackText);
      setText(releaseDate, releaseDateText ? `Released: ${releaseDateText}` : '\u00A0');
      releaseDate.classList.toggle('bc-metadata-release-date-empty', !releaseDateText);
    },
    destroy() {
      resizeObserver.disconnect();
      artist.container.remove();
      album.remove();
      albumTrailingSlot.remove();
      track.remove();
      releaseDate.remove();
    },
    getDragHandles() {
      return [metaContainer];
    },
    getAlbumLeadingSlot() {
      return albumLeadingSlot;
    },
    getAlbumTrailingSlot() {
      return albumTrailingSlot;
    },
  };
}
