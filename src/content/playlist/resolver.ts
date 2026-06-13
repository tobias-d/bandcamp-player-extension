import type {
  MetadataResolution,
  NonReleaseResolverSnapshot,
  PlaylistState,
  PlaylistTrack
} from '@/shared/types';
import { resolveTrackMetadata, resolveTracklistSource } from '@/content/metadata/extractor';
import { pickReleaseDateFromTralbum } from '@/content/metadata/release/date';
import {
  asTralbumRecord,
  buildTrackRows,
  getTrackLists,
  resolveTralbumReleasePageUrl
} from '@/content/playlist/resolver-tracklist';
import { normalizeUrl, readTrackIdFromUrl, resolveStreamContentId } from '@/content/playlist/resolver-url';

export { normalizeUrl, readTrackIdFromUrl, resolveStreamContentId };

export interface PlayerPlaylistResolveResult {
  playlist: PlaylistState;
  source: string;
}

export interface DiscoverPlaylistResolveResult {
  playlist: PlaylistState;
  source: string;
  tralbum: unknown | null;
}

export interface ResolveNonReleaseResolverSnapshotInput {
  context: 'player' | 'discover';
  previous: PlaylistState;
  currentSrc: string;
  allowApiFetch: boolean;
  preferApi?: boolean;
  includePageUrl?: boolean;
}

function normalizeIdentitySourceLabel(source: string): 'TralbumAPI' | 'TralbumData' | 'none' {
  const value = String(source || '').trim();
  if (value === 'TralbumAPI' || value === 'TralbumData') {
    return value;
  }
  return 'none';
}

function withCurrent(playlist: PlaylistState, currentIndex: number): PlaylistState {
  return {
    ...playlist,
    currentIndex,
    tracks: playlist.tracks.map((track, index) => ({
      ...track,
      isCurrent: index === currentIndex
    }))
  };
}

function buildEmptyPlaylist(previous: PlaylistState, loading: boolean): PlaylistState {
  return {
    ...previous,
    tracks: [],
    currentIndex: 0,
    releasePageUrl: '',
    loading
  };
}

function resolveTralbumMetadataHints(tralbumRecord: {
  artist?: string;
  album_title?: string;
  albumTitle?: string;
  release_title?: string;
  releaseTitle?: string;
  item_title?: string;
  itemTitle?: string;
  title?: string;
  tralbum_artist?: string;
  tralbumArtist?: string;
  band_name?: string;
  bandName?: string;
  band?: { name?: string };
  current?: { title?: string };
}): { artistName: string; albumTitle: string } {
  const artistName = String(
    tralbumRecord.artist ||
    tralbumRecord.tralbum_artist ||
    tralbumRecord.tralbumArtist ||
    tralbumRecord.band_name ||
    tralbumRecord.bandName ||
    tralbumRecord.band?.name ||
    ''
  ).trim();
  const albumTitle = String(
    tralbumRecord.album_title ||
    tralbumRecord.albumTitle ||
    tralbumRecord.release_title ||
    tralbumRecord.releaseTitle ||
    tralbumRecord.item_title ||
    tralbumRecord.itemTitle ||
    tralbumRecord.current?.title ||
    tralbumRecord.title ||
    ''
  ).trim();
  return { artistName, albumTitle };
}

function sourceMatchesTrack(track: PlaylistTrack, currentSrc: string): boolean {
  if (!currentSrc) {
    return false;
  }

  const sourceTrackId = readTrackIdFromUrl(currentSrc);
  if (sourceTrackId && String(track.trackId || '').trim() === sourceTrackId) {
    return true;
  }

  const normalizedSrc = normalizeUrl(currentSrc);
  if (normalizedSrc && normalizeUrl(track.streamUrl || '') === normalizedSrc) {
    return true;
  }

  const sourceContentId = resolveStreamContentId(currentSrc);
  if (!sourceContentId) {
    return false;
  }

  return resolveStreamContentId(track.streamUrl || '') === sourceContentId;
}

function annotateTrackPlayability(
  tracks: PlaylistTrack[],
  currentSrc: string
): { tracks: PlaylistTrack[]; gated: boolean } {
  if (!tracks.length) {
    return { tracks, gated: false };
  }

  let hasUnplayable = false;

  const nextTracks = tracks.map((track) => {
    const playable = String(track.streamUrl || '').trim().length > 0 || sourceMatchesTrack(track, currentSrc);
    if (!playable) {
      hasUnplayable = true;
    }
    return {
      ...track,
      playable
    };
  });

  return {
    tracks: nextTracks,
    gated: hasUnplayable
  };
}

function isMetadataResolutionAlignedWithSource(
  resolution: MetadataResolution,
  currentSrc: string
): boolean {
  const src = String(currentSrc || '').trim();
  if (!src) {
    return true;
  }

  const sourceTrackId = readTrackIdFromUrl(src);
  const matchedTrackId = String(resolution.matchedTrackId || '').trim();
  if (sourceTrackId && matchedTrackId && sourceTrackId !== matchedTrackId) {
    return false;
  }

  const sourceContentId = resolveStreamContentId(src);
  const matchedStreamUrl = String(resolution.matchedStreamUrl || '').trim();
  const matchedContentId = resolveStreamContentId(matchedStreamUrl);
  if (sourceContentId && matchedContentId && sourceContentId !== matchedContentId) {
    return false;
  }

  return true;
}

function resolvePlayerCurrentIndex(params: {
  currentSrc: string;
  tracks: PlaylistState['tracks'];
  trackinfo: Array<Record<string, unknown>>;
  tralbumCurrentTitle: string;
  metadataResolution: MetadataResolution | null;
}): { currentIndex: number; reason: string } {
  const { currentSrc, tracks, trackinfo, tralbumCurrentTitle, metadataResolution } = params;
  const trackId = readTrackIdFromUrl(currentSrc);
  const normalizedSrc = normalizeUrl(currentSrc);
  const streamContentId = resolveStreamContentId(currentSrc);

  if (trackId) {
    const byTrackId = tracks.findIndex((track) => track.trackId === trackId);
    if (byTrackId >= 0) {
      return { currentIndex: byTrackId, reason: 'audio.trackId' };
    }
  }

  if (normalizedSrc) {
    const byStream = tracks.findIndex((track) => normalizeUrl(track.streamUrl || '') === normalizedSrc);
    if (byStream >= 0) {
      return { currentIndex: byStream, reason: 'audio.streamUrl' };
    }
  }

  if (streamContentId) {
    const byStreamContentId = tracks.findIndex(
      (track) => resolveStreamContentId(track.streamUrl || '') === streamContentId
    );
    if (byStreamContentId >= 0) {
      return { currentIndex: byStreamContentId, reason: 'audio.streamContentId' };
    }
  }

  if (metadataResolution?.matchedTrackId) {
    const byMatchedId = tracks.findIndex((track) => track.trackId === metadataResolution.matchedTrackId);
    if (byMatchedId >= 0) {
      return { currentIndex: byMatchedId, reason: 'metadata.matchedTrackId' };
    }
  }

  if (
    metadataResolution &&
    metadataResolution.selectedTrackIndex >= 0 &&
    metadataResolution.selectedTrackIndex < tracks.length
  ) {
    return {
      currentIndex: metadataResolution.selectedTrackIndex,
      reason: `metadata.selectedTrackIndex(${metadataResolution.selectedTrackReason})`
    };
  }

  const byPlayingFlag = trackinfo.findIndex((trackRaw) => Boolean(trackRaw.is_playing));
  if (byPlayingFlag >= 0 && byPlayingFlag < tracks.length) {
    return { currentIndex: byPlayingFlag, reason: 'TralbumData.trackinfo(is_playing)' };
  }

  if (tralbumCurrentTitle) {
    const byCurrentTitle = tracks.findIndex((track) => track.title.trim().toLowerCase() === tralbumCurrentTitle);
    if (byCurrentTitle >= 0) {
      return { currentIndex: byCurrentTitle, reason: 'TralbumData.current.title' };
    }
  }

  return { currentIndex: 0, reason: 'default(0)' };
}

function resolveDiscoverCurrentIndex(params: {
  currentSrc: string;
  tracks: PlaylistState['tracks'];
  trackinfo: Array<Record<string, unknown>>;
  tralbumCurrentTitle: string;
}): number {
  const { currentSrc, tracks, trackinfo, tralbumCurrentTitle } = params;
  const trackId = readTrackIdFromUrl(currentSrc);
  const normalizedSrc = normalizeUrl(currentSrc);

  if (trackId) {
    const byTrackId = tracks.findIndex((track) => track.trackId === trackId);
    if (byTrackId >= 0) {
      return byTrackId;
    }
  }

  if (normalizedSrc) {
    const byStream = tracks.findIndex((track) => normalizeUrl(track.streamUrl || '') === normalizedSrc);
    if (byStream >= 0) {
      return byStream;
    }
  }

  const byPlayingFlag = trackinfo.findIndex((trackRaw) => Boolean(trackRaw.is_playing));
  if (byPlayingFlag >= 0 && byPlayingFlag < tracks.length) {
    return byPlayingFlag;
  }

  if (tralbumCurrentTitle) {
    const byCurrentTitle = tracks.findIndex((track) => track.title.trim().toLowerCase() === tralbumCurrentTitle);
    if (byCurrentTitle >= 0) {
      return byCurrentTitle;
    }
  }

  return 0;
}

function buildNonReleaseSourceLabel(
  context: 'player' | 'discover',
  tralbumSource: 'TralbumData' | 'TralbumAPI' | 'none',
  currentIndexReason: string,
  playabilityGated: boolean,
  emptyReason: 'none' | 'empty' | 'stale-track' | 'none(no-stream)' | ''
): string {
  if (emptyReason === 'none(no-stream)') {
    return context === 'discover' ? 'none(no-stream)' : 'none';
  }
  if (emptyReason === 'none') {
    return 'none';
  }
  if (emptyReason === 'empty') {
    if (context === 'discover') {
      return tralbumSource === 'none' ? 'none' : tralbumSource;
    }
    return `${tralbumSource}(empty)`;
  }
  if (emptyReason === 'stale-track') {
    return `${tralbumSource}(stale-track)`;
  }
  if (context === 'discover') {
    return `${tralbumSource}${playabilityGated ? '|playability-gated' : ''}`;
  }
  return `${tralbumSource}(${currentIndexReason}${playabilityGated ? '|playability-gated' : ''})`;
}

export function resolveNonReleaseResolverSnapshot(
  input: ResolveNonReleaseResolverSnapshotInput
): NonReleaseResolverSnapshot {
  const context = input.context;
  const previous = input.previous;
  const src = String(input.currentSrc || '').trim();
  const allowApiFetch = input.allowApiFetch !== false;
  const preferApi = input.preferApi === true || context === 'discover';
  const includePageUrl = input.includePageUrl === true || context === 'player';
  const metadataResolution = resolveTrackMetadata({
    currentSrc: src,
    allowApiFetch
  });
  const metadataAlignedWithSource = isMetadataResolutionAlignedWithSource(metadataResolution, src);
  const metadataStrictTrackMatch = Boolean(
    metadataResolution.selectedTrackReason === 'trackId' ||
    metadataResolution.selectedTrackReason === 'streamUrl' ||
    metadataResolution.selectedTrackReason === 'cacheTrackId'
  );

  const buildSnapshot = (
    playlist: PlaylistState,
    tralbum: unknown | null,
    tralbumSource: 'TralbumData' | 'TralbumAPI' | 'none',
    currentIndexReason: string,
    playabilityGated: boolean,
    staleTrack: boolean,
    matchedSource: boolean,
    matchedViaMetadata: boolean,
    emptyReason: 'none' | 'empty' | 'stale-track' | 'none(no-stream)' | ''
  ): NonReleaseResolverSnapshot => {
    const activeTrack = playlist.tracks[playlist.currentIndex] || null;
    return {
      context,
      currentSrc: src,
      metadata: metadataResolution.metadata,
      metadataResolution,
      playlist,
      playlistSource: buildNonReleaseSourceLabel(
        context,
        tralbumSource,
        currentIndexReason,
        playabilityGated,
        emptyReason
      ),
      playlistCurrentIndexReason: currentIndexReason,
      source: {
        tralbumSource,
        identitySource: normalizeIdentitySourceLabel(tralbumSource),
        allowApiFetch,
        preferApi,
        staleTrack
      },
      activeTrack: {
        sourceTrackId: readTrackIdFromUrl(src),
        sourceStreamUrl: normalizeUrl(src),
        sourceStreamContentId: resolveStreamContentId(src),
        matchedTrackId: String(activeTrack?.trackId || metadataResolution.matchedTrackId || '').trim(),
        matchedStreamUrl: String(activeTrack?.streamUrl || metadataResolution.matchedStreamUrl || '').trim(),
        matchedReason: currentIndexReason
      },
      flags: {
        metadataAlignedWithSource,
        metadataStrictTrackMatch,
        playlistMatchedSource: matchedSource,
        playlistMatchedViaMetadata: matchedViaMetadata,
        playabilityGated,
        strictPlaylistBinding: matchedSource || matchedViaMetadata
      },
      tralbum
    };
  };

  if (!src) {
    return buildSnapshot(
      buildEmptyPlaylist(previous, context === 'player' ? allowApiFetch : false),
      null,
      'none',
      'none',
      false,
      false,
      false,
      false,
      'none(no-stream)'
    );
  }

  const { tralbum, source } = resolveTracklistSource(src, { allowApiFetch, preferApi });
  const tralbumSource = normalizeIdentitySourceLabel(source) as 'TralbumData' | 'TralbumAPI' | 'none';
  const tralbumRecord = asTralbumRecord(tralbum);
  if (!tralbumRecord) {
    return buildSnapshot(
      buildEmptyPlaylist(previous, context === 'player' ? allowApiFetch : false),
      null,
      tralbumSource,
      'none',
      false,
      false,
      false,
      false,
      tralbumSource === 'none' ? 'none' : 'empty'
    );
  }

  const { primary: trackinfo, secondary: secondaryTrackinfo } = getTrackLists(tralbumRecord);
  const releasePageUrl = includePageUrl
    ? resolveTralbumReleasePageUrl(tralbumRecord, trackinfo, secondaryTrackinfo)
    : '';
  const metadataHints = resolveTralbumMetadataHints(tralbumRecord);
  const identitySource = normalizeIdentitySourceLabel(source);
  const releaseDate = pickReleaseDateFromTralbum(tralbumRecord, identitySource);
  const rows = buildTrackRows(trackinfo, includePageUrl, secondaryTrackinfo, metadataHints, releasePageUrl, releaseDate);
  const rowsWithIdentity = rows.map((track) => ({
    ...track,
    identitySource
  }));
  const { tracks, gated: playabilityGated } = annotateTrackPlayability(rowsWithIdentity, src);
  if (!tracks.length) {
    return buildSnapshot(
      buildEmptyPlaylist(previous, context === 'player' ? allowApiFetch : false),
      tralbumRecord,
      tralbumSource,
      'none',
      false,
      false,
      false,
      false,
      'empty'
    );
  }

  const matchesCurrentSource = tracks.some((track) => sourceMatchesTrack(track, src));
  const matchesMetadataTrackId = metadataResolution.matchedTrackId
    ? tracks.some((track) => track.trackId === metadataResolution.matchedTrackId)
    : false;
  if (!matchesCurrentSource && !matchesMetadataTrackId) {
    return buildSnapshot(
      buildEmptyPlaylist(previous, context === 'player' ? allowApiFetch : false),
      tralbumRecord,
      tralbumSource,
      'none',
      playabilityGated,
      true,
      false,
      false,
      'stale-track'
    );
  }

  const tralbumCurrentTitle = String(tralbumRecord.current?.title ?? '').trim().toLowerCase();
  const { currentIndex, reason } = resolvePlayerCurrentIndex({
    currentSrc: src,
    tracks,
    trackinfo,
    tralbumCurrentTitle,
    metadataResolution
  });

  const playlist = withCurrent(
    {
      tracks,
      releasePageUrl,
      currentIndex,
      expanded: previous.expanded,
      loading: false,
      sortKey: previous.sortKey,
      sortAsc: previous.sortAsc
    },
    currentIndex
  );

  return buildSnapshot(
    playlist,
    tralbumRecord,
    tralbumSource,
    reason,
    playabilityGated,
    false,
    matchesCurrentSource,
    !matchesCurrentSource && matchesMetadataTrackId,
    ''
  );
}

export function resolvePlayerPlaylistFromGlobals(
  currentSrc: string,
  previous: PlaylistState,
  metadataResolution: MetadataResolution | null,
  allowApiFetch = true
): PlayerPlaylistResolveResult {
  const src = currentSrc.trim();
  const { tralbum, source: tralbumSource } = resolveTracklistSource(src, { allowApiFetch });
  const tralbumRecord = asTralbumRecord(tralbum);
  if (!tralbumRecord) {
    return {
      playlist: buildEmptyPlaylist(previous, allowApiFetch),
      source: 'none'
    };
  }

  const { primary: trackinfo, secondary: secondaryTrackinfo } = getTrackLists(tralbumRecord);
  const releasePageUrl = resolveTralbumReleasePageUrl(tralbumRecord, trackinfo, secondaryTrackinfo);
  const metadataHints = resolveTralbumMetadataHints(tralbumRecord);
  const identitySource = normalizeIdentitySourceLabel(tralbumSource);
  const releaseDate = pickReleaseDateFromTralbum(tralbumRecord, identitySource);
  const rows = buildTrackRows(trackinfo, true, secondaryTrackinfo, metadataHints, releasePageUrl, releaseDate);
  const rowsWithIdentity = rows.map((track) => ({
    ...track,
    identitySource
  }));
  const { tracks, gated: playabilityGated } = annotateTrackPlayability(rowsWithIdentity, src);
  if (!tracks.length) {
    return {
      playlist: buildEmptyPlaylist(previous, allowApiFetch),
      source: `${tralbumSource}(empty)`
    };
  }

  const matchesCurrentSource = src
    ? tracks.some((track) => sourceMatchesTrack(track, src))
    : false;
  const matchesMetadataTrackId = metadataResolution?.matchedTrackId
    ? tracks.some((track) => track.trackId === metadataResolution.matchedTrackId)
    : false;
  if (src && !matchesCurrentSource && !matchesMetadataTrackId) {
    return {
      playlist: buildEmptyPlaylist(previous, allowApiFetch),
      source: `${tralbumSource}(stale-track)`
    };
  }

  const tralbumCurrentTitle = String(tralbumRecord.current?.title ?? '').trim().toLowerCase();
  const { currentIndex, reason } = resolvePlayerCurrentIndex({
    currentSrc: src,
    tracks,
    trackinfo,
    tralbumCurrentTitle,
    metadataResolution
  });

  return {
    playlist: withCurrent(
      {
        tracks,
        releasePageUrl,
        currentIndex,
        expanded: previous.expanded,
        loading: false,
        sortKey: previous.sortKey,
        sortAsc: previous.sortAsc
      },
      currentIndex
    ),
    source: `${tralbumSource}(${reason}${playabilityGated ? '|playability-gated' : ''})`
  };
}

export function resolveDiscoverPlaylistFromGlobals(
  previous: PlaylistState,
  currentSrc: string,
  allowApiFetch: boolean
): DiscoverPlaylistResolveResult {
  const src = currentSrc.trim();
  if (!src) {
    return {
      playlist: buildEmptyPlaylist(previous, false),
      source: 'none(no-stream)',
      tralbum: null
    };
  }

  const { tralbum, source } = resolveTracklistSource(src, { allowApiFetch, preferApi: true });
  const tralbumRecord = asTralbumRecord(tralbum);
  if (!tralbumRecord) {
    return {
      playlist: buildEmptyPlaylist(previous, false),
      source: source === 'none' ? 'none' : source,
      tralbum: null
    };
  }

  const { primary: trackinfo, secondary: secondaryTrackinfo } = getTrackLists(tralbumRecord);
  const releasePageUrl = resolveTralbumReleasePageUrl(tralbumRecord, trackinfo, secondaryTrackinfo);
  const metadataHints = resolveTralbumMetadataHints(tralbumRecord);
  const identitySource = normalizeIdentitySourceLabel(source);
  const releaseDate = pickReleaseDateFromTralbum(tralbumRecord, identitySource);
  const rows = buildTrackRows(trackinfo, false, secondaryTrackinfo, metadataHints, '', releaseDate);
  const rowsWithIdentity = rows.map((track) => ({
    ...track,
    identitySource
  }));
  const { tracks, gated: playabilityGated } = annotateTrackPlayability(rowsWithIdentity, src);
  if (!tracks.length) {
    return {
      playlist: buildEmptyPlaylist(previous, false),
      source: source === 'none' ? 'none' : source,
      tralbum: tralbumRecord
    };
  }

  const matchesCurrentSource = tracks.some((track) => sourceMatchesTrack(track, src));
  if (!matchesCurrentSource) {
    return {
      playlist: buildEmptyPlaylist(previous, false),
      source: `${source}(stale-track)`,
      tralbum: tralbumRecord
    };
  }

  const tralbumCurrentTitle = String(tralbumRecord.current?.title ?? '').trim().toLowerCase();
  const currentIndex = resolveDiscoverCurrentIndex({
    currentSrc: src,
    tracks,
    trackinfo,
    tralbumCurrentTitle
  });

  return {
    playlist: withCurrent(
      {
        ...previous,
        tracks,
        releasePageUrl,
        currentIndex
      },
      currentIndex
    ),
    source: `${source}${playabilityGated ? '|playability-gated' : ''}`,
    tralbum: tralbumRecord
  };
}
