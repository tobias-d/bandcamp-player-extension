import type { MetadataResolution, PageGlobals, TrackMetadata } from '@/shared/types';
import { DEFAULT_TRACK_METADATA } from '@/shared/constants';
import { getLatestPageGlobals } from '@/content/discover/origin-bridge';
import { isReleaseContext, normalizeReleaseUrl, readTrackIdFromUrl } from '@/content/metadata/common';
import {
  chooseField,
  deriveConfidence,
  isDuplicateAlbumCandidate,
  shouldReplaceWeakAlbumCandidate
} from '@/content/metadata/extractor/fields';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import {
  resolveCachedTrackMetadata,
  getCachedApiTralbum,
  ensureTralbumApiFetch
} from '@/content/metadata/extractor/api/probe';
import { noteMetadataPathDecision } from '@/content/metadata/extractor/debug/counters';
import { getNowPlayingLinkedReleaseUrl } from '@/content/metadata/release';
import { readCandidateFromTralbum } from '@/content/metadata/extractor/tralbum-candidate';
import { getTrackList, tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import {
  EMPTY_FIELD,
  type MetadataContext,
  type TralbumLike,
  type TralbumMetadataCandidate
} from '@/content/metadata/extractor/types';
import { createLogger } from '@/utils/debug';

const logger = createLogger('METADATA');

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function detectMetadataPageType(): string {
  const path = String(window.location.pathname || '').toLowerCase();
  if (path.includes('/discover')) {
    return 'discover';
  }
  if (path.includes('/album/')) {
    return 'album';
  }
  if (path.includes('/track/')) {
    return 'track';
  }
  return 'non-release';
}

function isMissingAlbumValue(value: string): boolean {
  const next = normalizeText(value);
  return !next || next === DEFAULT_TRACK_METADATA.albumTitle;
}

function readTralbumDataCandidate(
  currentSrc: string,
  globals: PageGlobals | null
): TralbumMetadataCandidate | null {
  if (!globals?.tralbum || typeof globals.tralbum !== 'object') {
    return null;
  }
  return readCandidateFromTralbum(globals.tralbum as TralbumLike, 'TralbumData', currentSrc, isReleaseContext());
}

function readTralbumApiCandidate(currentSrc: string, globals: PageGlobals | null): TralbumMetadataCandidate | null {
  const cached = getCachedApiTralbum(globals, currentSrc);
  if (!cached) {
    return null;
  }
  return readCandidateFromTralbum(cached, 'TralbumAPI', currentSrc, isReleaseContext());
}

function isExternalPlaybackToPageTralbum(globals: PageGlobals | null, currentSrc: string): boolean {
  if (!isReleaseContext()) {
    return false;
  }
  if (!globals?.tralbum || typeof globals.tralbum !== 'object') {
    return false;
  }
  const src = String(currentSrc || '').trim();
  if (!src) {
    return false;
  }
  const trackId = readTrackIdFromUrl(src);
  return !tralbumMatchesCurrentTrack(globals.tralbum as TralbumLike, trackId, src);
}

function isExternalReleaseSelection(): boolean {
  if (!isReleaseContext()) {
    return false;
  }
  const linkedRelease = normalizeReleaseUrl(getNowPlayingLinkedReleaseUrl());
  if (!linkedRelease) {
    return false;
  }
  const pageRelease = normalizeReleaseUrl(window.location.href);
  if (!pageRelease) {
    return false;
  }
  return linkedRelease !== pageRelease;
}

function isPlaybackExternalToPageRelease(globals: PageGlobals | null, currentSrc: string): boolean {
  return isExternalPlaybackToPageTralbum(globals, currentSrc) || isExternalReleaseSelection();
}

function isStrictTrackMatchedApiCandidate(candidate: TralbumMetadataCandidate | null, sourceTrackId: string): boolean {
  if (!candidate || !sourceTrackId) {
    return false;
  }

  const reason = String(candidate.selectedTrackReason || '').trim();
  if (reason === 'trackId') {
    return String(candidate.matchedTrackId || '').trim() === sourceTrackId;
  }

  if (reason === 'streamUrl') {
    return Boolean(String(candidate.matchedStreamUrl || '').trim());
  }

  return false;
}

export function resolveTracklistSource(
  currentSrc = '',
  options: { allowApiFetch?: boolean; preferApi?: boolean } = {}
): { tralbum: unknown | null; source: 'TralbumData' | 'TralbumAPI' | 'none' } {
  const nonReleaseContext = !isReleaseContext();
  const globals = getLatestPageGlobals();
  const fromGlobals = globals?.tralbum;
  const hasGlobalsTracklist = fromGlobals && typeof fromGlobals === 'object' && getTrackList(fromGlobals as TralbumLike).length > 0;
  const externalToPagePlayback = isPlaybackExternalToPageRelease(globals, currentSrc);
  const preferApi = options.preferApi === true || externalToPagePlayback;

  if (nonReleaseContext) {
    if (options.allowApiFetch !== false) {
      ensureTralbumApiFetch(globals, currentSrc, { intent: 'playlist' });
    }
    const fromApi = getCachedApiTralbum(globals, currentSrc);
    if (fromApi && getTrackList(fromApi).length > 0) {
      return {
        tralbum: fromApi,
        source: 'TralbumAPI'
      };
    }
    return {
      tralbum: null,
      source: 'none'
    };
  }

  if (!preferApi && hasGlobalsTracklist) {
    return {
      tralbum: fromGlobals,
      source: 'TralbumData'
    };
  }

  if (options.allowApiFetch !== false) {
    ensureTralbumApiFetch(globals, currentSrc, { intent: 'playlist' });
  }
  const fromApi = getCachedApiTralbum(globals, currentSrc);
  if (fromApi && getTrackList(fromApi).length > 0) {
    return {
      tralbum: fromApi,
      source: 'TralbumAPI'
    };
  }

  if (externalToPagePlayback) {
    return {
      tralbum: null,
      source: 'none'
    };
  }

  if (preferApi && hasGlobalsTracklist) {
    return {
      tralbum: fromGlobals,
      source: 'TralbumData'
    };
  }

  return {
    tralbum: null,
    source: 'none'
  };
}

export { getMetadataDebugSnapshot } from '@/content/metadata/extractor/debug/snapshot';

export function resolveTrackMetadata(context: MetadataContext = {}): MetadataResolution {
  const sourceUrl = context.currentSrc ?? getLikelyCurrentSrc();
  const sourceTrackId = readTrackIdFromUrl(sourceUrl);
  const nonReleaseContext = !isReleaseContext();
  const globals = context.pageGlobals ?? getLatestPageGlobals();
  const allowApiFetch = context.allowApiFetch !== false;
  const isReleasePlaybackExternalToPage = isPlaybackExternalToPageRelease(globals, sourceUrl);

  if (allowApiFetch) {
    ensureTralbumApiFetch(globals, sourceUrl, { intent: 'metadata' });
  }

  const tralbumApiCandidate = readTralbumApiCandidate(sourceUrl, globals);
  const strictTrackMatchedApiCandidate =
    !isReleaseContext() && sourceTrackId && tralbumApiCandidate
      ? isStrictTrackMatchedApiCandidate(tralbumApiCandidate, sourceTrackId)
        ? tralbumApiCandidate
        : null
      : tralbumApiCandidate;
  const cachedTrackMetadata = sourceTrackId ? resolveCachedTrackMetadata(sourceTrackId) : null;
  const hasCachedTrackMetadata = Boolean(
    cachedTrackMetadata?.title?.value ||
    cachedTrackMetadata?.artist?.value ||
    cachedTrackMetadata?.album?.value
  );
  if (nonReleaseContext) {
    const title = chooseField(
      strictTrackMatchedApiCandidate?.title ?? EMPTY_FIELD,
      cachedTrackMetadata?.title ?? EMPTY_FIELD,
      { value: DEFAULT_TRACK_METADATA.trackTitle, source: 'default' }
    );
    const artist = chooseField(
      strictTrackMatchedApiCandidate?.artist ?? EMPTY_FIELD,
      cachedTrackMetadata?.artist ?? EMPTY_FIELD,
      { value: DEFAULT_TRACK_METADATA.artistName, source: 'default' }
    );
    const album = chooseField(
      strictTrackMatchedApiCandidate?.album ?? EMPTY_FIELD,
      cachedTrackMetadata?.album ?? EMPTY_FIELD,
      { value: DEFAULT_TRACK_METADATA.albumTitle, source: 'default' }
    );
    const releaseDate = strictTrackMatchedApiCandidate?.releaseDate ?? cachedTrackMetadata?.releaseDate;
    const selectedTrackReason =
      strictTrackMatchedApiCandidate?.selectedTrackReason ??
      (hasCachedTrackMetadata ? 'cacheTrackId' : 'none');
    const metadata: TrackMetadata = {
      artistName: artist.value,
      trackTitle: title.value,
      albumTitle: album.value,
      ...(releaseDate ? { releaseDate } : {}),
      combined: `${artist.value} — ${title.value}`,
      confidence: 'low',
      sources: {
        title: title.source || 'default',
        artist: artist.source || 'default',
        album: album.source || 'default'
      }
    };
    metadata.confidence = deriveConfidence(metadata);
    noteMetadataPathDecision({
      pageType: detectMetadataPageType(),
      trackId: sourceTrackId,
      strictAccepted: Boolean(sourceTrackId && strictTrackMatchedApiCandidate),
      strictRejected: Boolean(sourceTrackId && tralbumApiCandidate && !strictTrackMatchedApiCandidate),
      fallbackUsed: false,
      titleSource: metadata.sources.title,
      artistSource: metadata.sources.artist,
      albumSource: metadata.sources.album,
      selectedTrackReason
    });
    return {
      metadata,
      sourceUrl,
      matchedTrackId: strictTrackMatchedApiCandidate?.matchedTrackId ?? (hasCachedTrackMetadata ? sourceTrackId : ''),
      matchedStreamUrl: strictTrackMatchedApiCandidate?.matchedStreamUrl ?? '',
      selectedTrackIndex: strictTrackMatchedApiCandidate?.selectedTrackIndex ?? -1,
      selectedTrackReason
    };
  }

  const tralbumDataCandidate = isReleasePlaybackExternalToPage
    ? null
    : readTralbumDataCandidate(sourceUrl, globals);
  const shouldUseApiFallback =
    isReleasePlaybackExternalToPage ||
    !tralbumDataCandidate?.title.value ||
    !tralbumDataCandidate?.artist.value ||
    !tralbumDataCandidate?.album.value;
  const releaseApiCandidate = shouldUseApiFallback ? tralbumApiCandidate : null;

  const titleCandidates = [
    tralbumDataCandidate?.title ?? EMPTY_FIELD,
    releaseApiCandidate?.title ?? EMPTY_FIELD,
    { value: DEFAULT_TRACK_METADATA.trackTitle, source: 'default' }
  ];
  const title = chooseField(...titleCandidates);
  const artistCandidates = [
    tralbumDataCandidate?.artist ?? EMPTY_FIELD,
    releaseApiCandidate?.artist ?? EMPTY_FIELD,
    { value: DEFAULT_TRACK_METADATA.artistName, source: 'default' }
  ];
  const artist = chooseField(...artistCandidates);
  const albumCandidates = [
    tralbumDataCandidate?.album ?? EMPTY_FIELD,
    releaseApiCandidate?.album ?? EMPTY_FIELD,
    { value: DEFAULT_TRACK_METADATA.albumTitle, source: 'default' }
  ];
  let album = chooseField(...albumCandidates);
  const isAlbumPage = window.location.pathname.includes('/album/');
  if (shouldReplaceWeakAlbumCandidate(album.value, title.value, artist.value, album.source, isAlbumPage)) {
    const filtered = albumCandidates.filter((candidate) => {
      return !isDuplicateAlbumCandidate(candidate.value, title.value, artist.value, isAlbumPage);
    });
    album = chooseField(...filtered);
  }

  if (isMissingAlbumValue(album.value)) {
    if (cachedTrackMetadata?.album?.value) {
      album = {
        value: cachedTrackMetadata.album.value,
        source: cachedTrackMetadata.album.source
      };
    }
  }

  const releaseDate =
    tralbumDataCandidate?.releaseDate ??
    releaseApiCandidate?.releaseDate ??
    cachedTrackMetadata?.releaseDate;

  const metadata: TrackMetadata = {
    artistName: artist.value,
    trackTitle: title.value,
    albumTitle: album.value,
    ...(releaseDate ? { releaseDate } : {}),
    combined: `${artist.value} — ${title.value}`,
    confidence: 'low',
    sources: {
      title: title.source || 'default',
      artist: artist.source || 'default',
      album: album.source || 'default'
    }
  };

  metadata.confidence = deriveConfidence(metadata);

  const selected = isReleasePlaybackExternalToPage
    ? releaseApiCandidate
    : tralbumDataCandidate ?? releaseApiCandidate;
  const matchedTrackId = selected?.matchedTrackId ?? '';
  const selectedTrackReason = selected?.selectedTrackReason ?? 'none';
  noteMetadataPathDecision({
    pageType: detectMetadataPageType(),
    trackId: sourceTrackId,
    strictAccepted: false,
    strictRejected: false,
    fallbackUsed: false,
    titleSource: title.source,
    artistSource: artist.source,
    albumSource: album.source,
    selectedTrackReason
  });

  return {
    metadata,
    sourceUrl,
    matchedTrackId,
    matchedStreamUrl: selected?.matchedStreamUrl ?? '',
    selectedTrackIndex: selected?.selectedTrackIndex ?? -1,
    selectedTrackReason
  };
}

export function getTrackMetaRobust(): TrackMetadata | null {
  const resolved = resolveTrackMetadata();
  if (!resolved.metadata.artistName && !resolved.metadata.trackTitle && !resolved.metadata.albumTitle) {
    return null;
  }
  return resolved.metadata;
}

export function getTrackMetaForSource(currentSrc: string): TrackMetadata | null {
  const resolved = resolveTrackMetadata({ currentSrc });
  if (!resolved.metadata.artistName && !resolved.metadata.trackTitle && !resolved.metadata.albumTitle) {
    return null;
  }
  return resolved.metadata;
}

export { getRootPlaylistProbeStatus, notifyTrackSwitch } from '@/content/metadata/extractor/root-probe-status';

export function watchMetadataChanges(callback: () => void): () => void {
  let lastKey = '';
  const seenAudios = new WeakSet<HTMLAudioElement>();
  const audioEvents = ['play', 'ended', 'loadedmetadata', 'emptied', 'durationchange'];
  const listeners: Array<{ el: HTMLAudioElement; type: string; fn: EventListener }> = [];

  const emit = (): void => {
    const dedupeKey = [
      getLikelyCurrentSrc(),
      document.title
    ].join('|');

    if (dedupeKey === lastKey) {
      return;
    }
    lastKey = dedupeKey;
    callback();
  };

  const bindAudioEvents = (audio: HTMLAudioElement): void => {
    if (seenAudios.has(audio)) {
      return;
    }
    seenAudios.add(audio);
    audioEvents.forEach((type) => {
      const fn = () => emit();
      audio.addEventListener(type, fn);
      listeners.push({ el: audio, type, fn });
    });
  };

  const scanAudios = (): void => {
    document.querySelectorAll('audio').forEach((audio) => {
      bindAudioEvents(audio as HTMLAudioElement);
    });
  };

  const observer = new MutationObserver(() => {
    scanAudios();
    emit();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: false
  });

  scanAudios();
  emit();

  const intervalId = window.setInterval(() => {
    scanAudios();
    emit();
  }, 2500);

  return () => {
    window.clearInterval(intervalId);
    observer.disconnect();
    listeners.forEach(({ el, type, fn }) => {
      el.removeEventListener(type, fn);
    });
    logger.debug('Metadata watcher disposed');
  };
}
