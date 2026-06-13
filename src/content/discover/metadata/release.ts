import type { DiscoverReleaseProbe } from '@/content/discover/metadata/types';
import { normalizeReleaseUrl, normalizeTextKey } from '@/content/discover/metadata/normalize';

const MIN_DISCOVER_RELEASE_SCORE = 90;

function scoreDiscoverReleaseCandidate(
  anchor: HTMLAnchorElement,
  baseScore: number,
  titleKey: string,
  artistKey: string
): number {
  let score = baseScore;
  const anchorText = normalizeTextKey(anchor.textContent);
  const context = anchor.closest('article,li,section,div') ?? anchor.parentElement ?? anchor;
  const contextText = normalizeTextKey(context?.textContent);
  const classBlob = `${String(anchor.className || '')} ${String((context as Element | null)?.className || '')}`.toLowerCase();

  if (titleKey) {
    if (contextText.includes(titleKey)) {
      score += 80;
    } else if (anchorText.includes(titleKey)) {
      score += 36;
    }
  }
  if (artistKey) {
    if (contextText.includes(artistKey)) {
      score += 56;
    } else if (anchorText.includes(artistKey)) {
      score += 24;
    }
  }
  if (titleKey && artistKey && contextText.includes(titleKey) && contextText.includes(artistKey)) {
    score += 48;
  }
  if (/(playing|active|current|selected|highlight)/i.test(classBlob)) {
    score += 26;
  }
  return score;
}

export function readDiscoverReleaseFromDom(trackTitle: string, artistName: string, trackId: string): DiscoverReleaseProbe {
  const titleKey = normalizeTextKey(trackTitle);
  const artistKey = normalizeTextKey(artistName);

  const selectorGroups: Array<{ selector: string; baseScore: number; source: string }> = [];
  if (trackId) {
    selectorGroups.push(
      {
        selector: `[data-trackid="${trackId}"] a[href*="/album/"], [data-trackid="${trackId}"] a[href*="/track/"]`,
        baseScore: 260,
        source: 'discoverDom(trackid)'
      },
      {
        selector: `[data-track-id="${trackId}"] a[href*="/album/"], [data-track-id="${trackId}"] a[href*="/track/"]`,
        baseScore: 260,
        source: 'discoverDom(track-id)'
      }
    );
  }

  selectorGroups.push(
    {
      selector:
        '[aria-current="true"] a[href*="/album/"], [aria-current="true"] a[href*="/track/"], [aria-selected="true"] a[href*="/album/"], [aria-selected="true"] a[href*="/track/"]',
      baseScore: 200,
      source: 'discoverDom(aria-current)'
    },
    {
      selector:
        '.playing a[href*="/album/"], .playing a[href*="/track/"], .is-playing a[href*="/album/"], .is-playing a[href*="/track/"], .current a[href*="/album/"], .current a[href*="/track/"], .active a[href*="/album/"], .active a[href*="/track/"]',
      baseScore: 180,
      source: 'discoverDom(playing)'
    },
    {
      selector:
        '.discover-player a[href*="/album/"], .discover-player a[href*="/track/"], #discover-player a[href*="/album/"], #discover-player a[href*="/track/"], .player-top a[href*="/album/"], .player-top a[href*="/track/"], .player-info a[href*="/album/"], .player-info a[href*="/track/"]',
      baseScore: 140,
      source: 'discoverDom(player)'
    },
    {
      selector: 'a[href*="/album/"], a[href*="/track/"]',
      baseScore: 24,
      source: 'discoverDom(scan)'
    }
  );

  const bestByUrl = new Map<string, { score: number; source: string }>();

  for (const group of selectorGroups) {
    const anchors = document.querySelectorAll<HTMLAnchorElement>(group.selector);
    anchors.forEach((anchor) => {
      const releaseUrl = normalizeReleaseUrl(anchor.getAttribute('href') || anchor.href || '');
      if (!releaseUrl) {
        return;
      }
      const score = scoreDiscoverReleaseCandidate(anchor, group.baseScore, titleKey, artistKey);
      const prev = bestByUrl.get(releaseUrl);
      if (!prev || score > prev.score) {
        bestByUrl.set(releaseUrl, { score, source: group.source });
      }
    });
  }

  let bestUrl = '';
  let bestScore = -1;
  let bestSource = 'none';
  bestByUrl.forEach((entry, url) => {
    if (entry.score > bestScore) {
      bestUrl = url;
      bestScore = entry.score;
      bestSource = entry.source;
    }
  });

  if (bestScore < MIN_DISCOVER_RELEASE_SCORE) {
    return { url: '', source: 'none' };
  }
  return { url: bestUrl, source: bestSource };
}
