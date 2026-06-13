// @ts-nocheck
import { firstNonEmpty, normalizeReleaseUrl, readTrackIdFromUrl, toIdString, toTralbumType } from '@/content/metadata/common';
import { getLatestObservedDiscoverSelection } from '@/content/discover/origin-bridge';
import { DOM_DEBUG_INTERESTING_ATTRS, DOM_DEBUG_QUERY_ATTR_SELECTORS, DOM_IDENTITY_QUERY_ATTR_SELECTORS, NOW_PLAYING_DEBUG_SELECTORS, NOW_PLAYING_IDENTITY_SELECTORS, NOW_PLAYING_LINK_SELECTORS } from '@/content/metadata/release/selectors';
function readIdFromElement(element, names) {
    if (!element) {
        return '';
    }
    for (const name of names) {
        const value = element.getAttribute(name);
        const id = toIdString(value ?? '');
        if (id) {
            return id;
        }
    }
    return '';
}
function readTypeFromElement(element, names) {
    if (!element) {
        return '';
    }
    for (const name of names) {
        const value = element.getAttribute(name);
        const type = toTralbumType(value ?? '');
        if (type) {
            return type;
        }
    }
    return '';
}
function readReleaseIdByPriority(node, releaseType) {
    const albumPriority = [
        ['data-tralbum-id', 'data-tralbumid', 'data-tralbum_id'],
        ['data-album-id', 'data-albumid', 'data-album_id'],
        ['data-item-id', 'data-itemid', 'data-item_id'],
        ['data-track-id', 'data-trackid', 'data-track_id']
    ];
    const trackPriority = [
        ['data-track-id', 'data-trackid', 'data-track_id'],
        ['data-item-id', 'data-itemid', 'data-item_id'],
        ['data-tralbum-id', 'data-tralbumid', 'data-tralbum_id'],
        ['data-album-id', 'data-albumid', 'data-album_id']
    ];
    const genericPriority = [
        ['data-tralbum-id', 'data-tralbumid', 'data-tralbum_id'],
        ['data-album-id', 'data-albumid', 'data-album_id'],
        ['data-track-id', 'data-trackid', 'data-track_id'],
        ['data-item-id', 'data-itemid', 'data-item_id']
    ];
    const priority = releaseType === 'a' ? albumPriority : releaseType === 't' ? trackPriority : genericPriority;
    for (const attrs of priority) {
        const value = readIdFromElement(node, attrs);
        if (value) {
            return value;
        }
    }
    return '';
}
function getLikelyNowPlayingTrackId() {
    const audios = Array.from(document.querySelectorAll('audio'));
    const playing = audios.find((audio) => !audio.paused && !audio.ended && Boolean(audio.currentSrc || audio.src));
    if (playing) {
        return readTrackIdFromUrl(playing.currentSrc || playing.src || '');
    }
    const withSrc = audios.find((audio) => Boolean(audio.currentSrc || audio.src));
    return readTrackIdFromUrl(withSrc?.currentSrc || withSrc?.src || '');
}
function collectTrackBoundNodes(trackId) {
    if (!trackId) {
        return [];
    }
    const escapedTrackId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(trackId) : trackId;
    const selectors = [`[data-trackid="${escapedTrackId}"]`, `[data-track-id="${escapedTrackId}"]`];
    const nodes = [];
    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => nodes.push(node));
    });
    return Array.from(new Set(nodes));
}
function findTrackBoundAnchor(trackId) {
    const nodes = collectTrackBoundNodes(trackId);
    for (const node of nodes) {
        const directAnchor = node.closest('a[href*="/album/"], a[href*="/track/"]');
        if (directAnchor instanceof HTMLAnchorElement) {
            return directAnchor;
        }
        const container = node.closest('.story-innards.collection-item-container, .collection-item-container, .story-innards, .story, .track_play_hilite, .recommended-item, .recommended-grid-item, .recommended-album-item, article, li');
        const inContainer = (container ?? node).querySelector('a[href*="/album/"], a[href*="/track/"]');
        if (inContainer instanceof HTMLAnchorElement) {
            return inContainer;
        }
    }
    return null;
}
function collectIdentityNodes(anchor) {
    const nodes = [];
    let cursor = anchor;
    for (let i = 0; i < 8 && cursor; i += 1) {
        nodes.push(cursor);
        cursor = cursor.parentElement;
    }
    const trackId = getLikelyNowPlayingTrackId();
    if (trackId) {
        nodes.push(...collectTrackBoundNodes(trackId));
    }
    const extraNodes = [];
    for (const node of nodes) {
        for (const attrSelector of DOM_IDENTITY_QUERY_ATTR_SELECTORS) {
            const found = node.querySelector(attrSelector);
            if (found) {
                extraNodes.push(found);
            }
        }
    }
    return Array.from(new Set([...nodes, ...extraNodes]));
}
function resolveIdentityFromAnchor(anchor, normalizedLinkedRelease) {
    const anchorRelease = normalizeReleaseUrl(anchor.getAttribute('href') || anchor.href || '');
    if (normalizedLinkedRelease && anchorRelease && anchorRelease !== normalizedLinkedRelease) {
        return null;
    }
    const uniqueNodes = collectIdentityNodes(anchor);
    const pathType = anchorRelease.includes('/track/') ? 't' : anchorRelease.includes('/album/') ? 'a' : '';
    let tralbumId = '';
    let bandId = '';
    let tralbumType = pathType;
    for (const node of uniqueNodes) {
        const explicitType = readTypeFromElement(node, [
            'data-item-type',
            'data-itemtype',
            'data-item_type',
            'data-tralbum-type',
            'data-tralbum_type'
        ]);
        if (explicitType) {
            tralbumType = explicitType;
        }
        if (!tralbumId) {
            tralbumId = readReleaseIdByPriority(node, tralbumType || pathType);
        }
        if (!bandId) {
            bandId = firstNonEmpty(readIdFromElement(node, ['data-band-id', 'data-bandid', 'data-band_id']), readIdFromElement(node, ['data-selling-band-id', 'data-selling_band_id']));
        }
        if (bandId && tralbumId && tralbumType) {
            break;
        }
    }
    if (!tralbumId) {
        return null;
    }
    return {
        bandId,
        tralbumId,
        tralbumType: tralbumType || 'a',
        anchorRelease: anchorRelease || normalizedLinkedRelease
    };
}
export function getNowPlayingLinkedReleaseUrl() {
    for (const selector of NOW_PLAYING_LINK_SELECTORS) {
        const anchor = document.querySelector(selector);
        if (!anchor) {
            continue;
        }
        const href = anchor.getAttribute('href') || anchor.href || '';
        const normalized = normalizeReleaseUrl(href);
        if (normalized) {
            return normalized;
        }
    }
    const trackBoundAnchor = findTrackBoundAnchor(getLikelyNowPlayingTrackId());
    if (trackBoundAnchor) {
        const normalized = normalizeReleaseUrl(trackBoundAnchor.getAttribute('href') || trackBoundAnchor.href || '');
        if (normalized) {
            return normalized;
        }
    }
    const discoverSelection = getLatestObservedDiscoverSelection(60000);
    const selectionUrl = normalizeReleaseUrl(discoverSelection?.url ?? '');
    if (selectionUrl) {
        return selectionUrl;
    }
    return '';
}
export function getNowPlayingDomIdentityCandidate(linkedReleaseUrl = '') {
    const normalizedLinkedRelease = normalizeReleaseUrl(linkedReleaseUrl);
    for (const selector of NOW_PLAYING_IDENTITY_SELECTORS) {
        const anchor = document.querySelector(selector);
        if (!anchor) {
            continue;
        }
        const candidate = resolveIdentityFromAnchor(anchor, normalizedLinkedRelease);
        if (candidate) {
            return candidate;
        }
    }
    const trackBoundAnchor = findTrackBoundAnchor(getLikelyNowPlayingTrackId());
    if (trackBoundAnchor) {
        const candidate = resolveIdentityFromAnchor(trackBoundAnchor, normalizedLinkedRelease);
        if (candidate) {
            return candidate;
        }
    }
    return null;
}
export function getNowPlayingStrictDomIdentityCandidate(currentSrc = '', linkedReleaseUrl = '') {
    const trackId = readTrackIdFromUrl(currentSrc) || getLikelyNowPlayingTrackId();
    if (!trackId) {
        return null;
    }
    const normalizedLinkedRelease = normalizeReleaseUrl(linkedReleaseUrl);
    const trackBoundAnchor = findTrackBoundAnchor(trackId);
    if (!trackBoundAnchor) {
        return null;
    }
    return resolveIdentityFromAnchor(trackBoundAnchor, normalizedLinkedRelease);
}
export function getNowPlayingDomDebugDetails(linkedReleaseUrl = '') {
    const normalizedLinkedRelease = normalizeReleaseUrl(linkedReleaseUrl);
    const out = [];
    for (const selector of NOW_PLAYING_DEBUG_SELECTORS) {
        const anchor = document.querySelector(selector);
        if (!anchor) {
            continue;
        }
        const anchorRelease = normalizeReleaseUrl(anchor.getAttribute('href') || anchor.href || '');
        if (normalizedLinkedRelease && anchorRelease && anchorRelease !== normalizedLinkedRelease) {
            continue;
        }
        out.push(`anchor=${anchorRelease || '-'}`);
        const nodes = [];
        let cursor = anchor;
        for (let i = 0; i < 8 && cursor; i += 1) {
            nodes.push(cursor);
            cursor = cursor.parentElement;
        }
        const extra = [];
        for (const node of nodes) {
            for (const attrSelector of DOM_DEBUG_QUERY_ATTR_SELECTORS) {
                const found = node.querySelector(attrSelector);
                if (found) {
                    extra.push(found);
                }
            }
        }
        const uniqueNodes = Array.from(new Set([...nodes, ...extra]));
        uniqueNodes.slice(0, 14).forEach((node) => {
            DOM_DEBUG_INTERESTING_ATTRS.forEach((attr) => {
                const value = node.getAttribute(attr);
                if (!value) {
                    return;
                }
                const nodeTag = node.tagName.toLowerCase();
                const nodeClass = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
                out.push(`${nodeTag}${nodeClass ? `.${nodeClass}` : ''}:${attr}=${value}`);
            });
        });
        return out.join(' | ');
    }
    return '-';
}
