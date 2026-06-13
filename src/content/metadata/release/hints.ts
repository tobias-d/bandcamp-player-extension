// @ts-nocheck
import { isReleaseContext, normalizeArtistKey, normalizeReleaseUrl, stripLabelSuffix, toIdString } from '@/content/metadata/common';
import { getLatestObservedDiscoverSelection, getRecentApiIdentityHints } from '@/content/discover/origin-bridge';
function getBandcampHostSlug(urlRaw) {
    if (!urlRaw) {
        return '';
    }
    try {
        const parsed = new URL(urlRaw, window.location.href);
        const host = parsed.hostname.toLowerCase();
        if (!host.endsWith('.bandcamp.com') || host === 'bandcamp.com') {
            return '';
        }
        return host.slice(0, -'.bandcamp.com'.length).trim();
    }
    catch {
        return '';
    }
}
function resolveLinkedReleaseUrlHint(linkedReleaseUrlHint = '') {
    const direct = normalizeReleaseUrl(linkedReleaseUrlHint);
    if (direct) {
        return direct;
    }
    const discoverSelection = getLatestObservedDiscoverSelection(60000);
    return normalizeReleaseUrl(discoverSelection?.url ?? '');
}
export function looksLikeLabelAliasFromHost(artistValue, tralbumIdHint = '', linkedReleaseUrlHint = '') {
    if (!artistValue || isReleaseContext()) {
        return false;
    }
    const candidates = new Set();
    const compactCandidates = new Set();
    const addCandidate = (value) => {
        const clean = normalizeArtistKey(value);
        if (!clean || clean === 'various artists' || clean === 'va') {
            return;
        }
        candidates.add(clean);
        const compact = clean.replace(/\s+/g, '');
        if (compact) {
            compactCandidates.add(compact);
        }
        const noSep = normalizeArtistKey(String(value).replace(/[-_]+/g, ' '));
        if (noSep) {
            candidates.add(noSep);
            const noSepCompact = noSep.replace(/\s+/g, '');
            if (noSepCompact) {
                compactCandidates.add(noSepCompact);
            }
        }
        const strippedWords = stripLabelSuffix(clean);
        if (strippedWords && strippedWords !== clean) {
            candidates.add(strippedWords);
            const strippedWordsCompact = strippedWords.replace(/\s+/g, '');
            if (strippedWordsCompact) {
                compactCandidates.add(strippedWordsCompact);
            }
        }
        const strippedCompact = stripLabelSuffix(compact);
        if (strippedCompact && strippedCompact !== compact) {
            compactCandidates.add(strippedCompact);
            candidates.add(strippedCompact);
        }
    };
    const linkedReleaseUrl = resolveLinkedReleaseUrlHint(linkedReleaseUrlHint);
    const directSlug = getBandcampHostSlug(linkedReleaseUrl);
    if (directSlug) {
        addCandidate(directSlug);
    }
    const cleanTralbumId = toIdString(tralbumIdHint);
    const hints = getRecentApiIdentityHints(10 * 60 * 1000)
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 80);
    hints.forEach((hint) => {
        if (cleanTralbumId && toIdString(hint.tralbumId) !== cleanTralbumId) {
            return;
        }
        const slug = getBandcampHostSlug(String(hint.url ?? ''));
        if (slug) {
            addCandidate(slug);
        }
    });
    if (!candidates.size) {
        return false;
    }
    const artistKey = normalizeArtistKey(artistValue);
    if (!artistKey) {
        return false;
    }
    if (candidates.has(artistKey)) {
        return true;
    }
    return compactCandidates.has(artistKey.replace(/\s+/g, ''));
}
export function resolveBandIdFromHintsForTralbum(tralbumId, linkedReleaseUrl = '') {
    const cleanTralbumId = toIdString(tralbumId);
    if (!cleanTralbumId) {
        return '';
    }
    const normalizedLinkedRelease = normalizeReleaseUrl(linkedReleaseUrl);
    const hints = getRecentApiIdentityHints(10 * 60 * 1000)
        .slice()
        .sort((a, b) => b.ts - a.ts);
    const byRelease = hints.find((hint) => {
        if (toIdString(hint.tralbumId) !== cleanTralbumId) {
            return false;
        }
        if (!normalizedLinkedRelease) {
            return false;
        }
        return normalizeReleaseUrl(hint.url) === normalizedLinkedRelease;
    });
    if (byRelease) {
        return toIdString(byRelease.bandId);
    }
    const fallback = hints.find((hint) => toIdString(hint.tralbumId) === cleanTralbumId);
    return fallback ? toIdString(fallback.bandId) : '';
}
