// @ts-nocheck
import { normalizeReleaseUrl } from '@/content/metadata/common';
import { getNowPlayingDomDebugDetails, getNowPlayingDomIdentityCandidate, getNowPlayingLinkedReleaseUrl, getNowPlayingStrictDomIdentityCandidate } from '@/content/metadata/release/dom';
import { looksLikeLabelAliasFromHost, resolveBandIdFromHintsForTralbum } from '@/content/metadata/release/hints';
import type { ReleaseIdentity } from '@/content/metadata/release/types';
export type { ReleaseIdentity } from '@/content/metadata/release/types';
export { getNowPlayingDomDebugDetails, getNowPlayingLinkedReleaseUrl, looksLikeLabelAliasFromHost, resolveBandIdFromHintsForTralbum };
export function getNowPlayingDomReleaseIdentity(linkedReleaseUrl = ''): ReleaseIdentity | null {
    const candidate = getNowPlayingDomIdentityCandidate(linkedReleaseUrl);
    if (!candidate) {
        return null;
    }
    let bandId = candidate.bandId;
    if (!bandId && candidate.tralbumId) {
        bandId = resolveBandIdFromHintsForTralbum(candidate.tralbumId, candidate.anchorRelease || linkedReleaseUrl);
    }
    if (!bandId || !candidate.tralbumId) {
        return null;
    }
    return {
        bandId,
        tralbumId: candidate.tralbumId,
        tralbumType: candidate.tralbumType
    } as ReleaseIdentity;
}
export function getNowPlayingStrictDomReleaseIdentity(currentSrc = '', linkedReleaseUrl = ''): ReleaseIdentity | null {
    const candidate = getNowPlayingStrictDomIdentityCandidate(currentSrc, linkedReleaseUrl);
    if (!candidate) {
        return null;
    }
    let bandId = candidate.bandId;
    if (!bandId && candidate.tralbumId) {
        bandId = resolveBandIdFromHintsForTralbum(candidate.tralbumId, candidate.anchorRelease || linkedReleaseUrl);
    }
    if (!bandId || !candidate.tralbumId) {
        return null;
    }
    return {
        bandId,
        tralbumId: candidate.tralbumId,
        tralbumType: candidate.tralbumType
    } as ReleaseIdentity;
}
export function getReleaseUrlFromRecord(record) {
    const candidates = [
        record['item_url'],
        record['itemUrl'],
        record['release_url'],
        record['releaseUrl'],
        record['tralbum_url'],
        record['tralbumUrl'],
        record['album_url'],
        record['albumUrl'],
        record['track_url'],
        record['trackUrl'],
        record['item_href'],
        record['itemHref'],
        record['item_link'],
        record['itemLink'],
        record['url'],
        record['link'],
        record['web_url'],
        record['webUrl']
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const normalized = normalizeReleaseUrl(candidate);
        if (normalized) {
            return normalized;
        }
    }
    return '';
}
