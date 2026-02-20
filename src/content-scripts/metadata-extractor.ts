/**
 * ============================================================================
 * ROBUST BANDCAMP METADATA EXTRACTION
 * ============================================================================
 * 
 * VERSION: 1.5 (2026-02-15)
 * 
 * EXTRACTION STRATEGY (in priority order):
 * 1. Feed pages: Waypoint elements (.waypoint-item-title, .waypoint-artist-title)
 * 2. Collection pages: Knockout.js data-bind attributes
 * 3. Album pages: Match audio track_id against trackinfo array
 * 4. JSON-LD structured data (<script type="application/ld+json">)
 * 5. Data attributes (data-tralbum, data-band) - Bandcamp's internal data
 * 6. DOM selectors - Multiple fallbacks
 * 7. Meta tags (og:title)
 * 8. Document title parsing
 * 
 * CONFIDENCE LEVELS:
 * - high: JSON-LD, data attributes, waypoint, or data-bind
 * - medium: DOM selectors
 * - low: Meta/title parsing
 * 
 * CHANGELOG v1.5:
 * - Fixed Feed page track extraction (bandcamp.com/username/feed)
 * - Prioritizes .waypoint-item-title and .waypoint-artist-title
 * - These contain the CURRENTLY PLAYING track, not just any feed item
 * - Correctly shows "Mas Kiki Que Couba" by "DJ Fitness" on feed pages
 * 
 * CHANGELOG v1.4:
 * - Fixed album page track extraction by matching audio track_id
 * - Extracts track_id from audio.currentSrc URL
 * - Matches against trackinfo[].track_id to find playing track
 * - Now correctly shows "Guided by Light" on album pages
 * 
 * CHANGELOG v1.3:
 * - Fixed album page track extraction priority
 * - Now checks trackinfo.is_playing BEFORE using current.title
 * - Shows "Guided by Light" instead of album title when playing
 * 
 * CHANGELOG v1.2:
 * - Added collection page support (bandcamp.com/username)
 * - Extracts from Knockout.js data-bind attributes
 * - Fixed track title showing collection title on fan pages
 * 
 * CHANGELOG v1.1:
 * - Fixed artist extraction priority for label pages
 * - Now prioritizes data-tralbum.artist over data-band.name
 * - Correctly handles tracks published on label pages
 * 
 * @module content-scripts/metadata-extractor
 */



/* ============================================================================
 * TYPE DEFINITIONS
 * ============================================================================ */



export type ConfidenceLevel = 'high' | 'medium' | 'low';



export interface TrackMetadata {
  artistName: string;
  trackTitle: string;
  albumTitle?: string;
  combined: string;
  confidence?: ConfidenceLevel;
  sources?: {
    title: string;
    artist: string;
  };
}



interface ExtractionResult {
  title?: string;
  artist?: string;
  source: string;
  confidence: ConfidenceLevel;
}



interface BandcampTrackInfo {
  title?: string;
  is_playing?: boolean;
  artist?: string;
  track_id?: number;
  id?: number;
}



interface BandcampTralbumData {
  artist?: string;
  album_title?: string;
  current?: {
    title?: string;
    type?: 'track' | 'album';
  };
  trackinfo?: BandcampTrackInfo[];
}



interface BandcampBandData {
  id?: number;
  name?: string;
  subdomain?: string;
  url?: string;
}



interface JsonLdData {
  '@type'?: string;
  name?: string;
  byArtist?: {
    name?: string;
  };
  inAlbum?: {
    name?: string;
    byArtist?: {
      name?: string;
    };
  };
}



/* ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================ */



function norm(s: string | null | undefined): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}



function stripLeadingBy(s: string | null | undefined): string {
  return norm(s).replace(/^by\s+/i, '').trim();
}



/**
 * Detect if current page is a collection page (bandcamp.com/username)
 * @returns {boolean}
 */
function isCollectionPage(): boolean {
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;

  // Collection pages are on bandcamp.com (no subdomain) with a username path
  return hostname === 'bandcamp.com' && pathname.length > 1 && !pathname.startsWith('/search');
}



/**
 * Extract track_id from audio element's currentSrc
 * @returns {string|null} Track ID or null
 */
function getAudioTrackId(): string | null {
  const audio = document.querySelector('audio');
  if (!audio?.currentSrc) return null;

  const value = String(audio.currentSrc || '');
  const pathMatch = value.match(/\/(\d+)(?:\?|$)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const queryMatch = value.match(/[?&](?:track_id|id)=(\d+)(?:&|$)/i);
  return queryMatch?.[1] || null;
}

function normalizeCmpText(s: string | null | undefined): string {
  return norm(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function getPlayingRecommendationRoot(): Element | null {
  const selectors = [
    '#recommendations_container .album-art-container.playing',
    '.recs-section .album-art-container.playing',
    '.recommended-album .album-art-container.playing',
    '.recommended_items .playing',
    '.recommended-items .playing',
    '.recommended_grid .playing',
    '.recommendations .playing',
    '.you-may-also-like .playing',
    '.track_play_waypoint.playing',
    '.waypoint.track_play_waypoint.playing',
    '.waypoint.playing',
    '[class*="recommend"] .playing',
    '[class*="related"] .playing',
    '[class*="recommend"][class*="playing"]',
    '[class*="related"][class*="playing"]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function getRecommendationItemRoot(root: Element): Element {
  const li = root.closest('li.recommended-album, li[class*="recommended"]');
  if (li) return li;
  const section = root.closest('.recs-section, #recommendations_container, .recommendations-container');
  if (section) return section;
  return root;
}

function parseRecommendationText(text: string): { title: string; artist: string } {
  const raw = norm(text);
  if (!raw) return { title: '', artist: '' };

  const cut = raw.replace(/\s+supported by[\s\S]*$/i, '').replace(/\s+go to album[\s\S]*$/i, '').trim();
  let m = cut.match(/^(.+?)\s+by\s+(.+)$/i);
  if (!m) {
    // Handle Bandcamp rec DOM where title and "by" are concatenated: "Black Bloodby Ketch"
    m = cut.match(/^(.+?)by\s+(.+)$/i);
  }
  if (!m) return { title: '', artist: '' };
  return { title: norm(m[1]), artist: stripLeadingBy(m[2]) };
}

function isGenericRecommendationTitle(value: string): boolean {
  const v = normalizeCmpText(value);
  if (!v) return true;
  return v === 'go to album' || v === 'go to track' || v === 'buy now' || v === 'wishlist';
}

function isExternalRecommendationPlayback(): boolean {
  // When a recommendation card is explicitly marked as playing, trust that
  // context for metadata extraction. This avoids stale local tralbum metadata
  // overriding the actually playing recommendation track.
  return Boolean(getPlayingRecommendationRoot());
}

function getRecommendationNowPlayingMeta(): { title: string; artist: string } | null {
  const root = getPlayingRecommendationRoot();
  if (!root) return null;
  const itemRoot = getRecommendationItemRoot(root);

  const titleSelectors = [
    '.collection-item-title',
    '.recommended-item-title',
    '.item-title',
    '.title',
    '.waypoint-item-title',
    '.track-title',
    'a.item-link',
    'a[href*="/album/"]',
    'a[href*="/track/"]',
  ];
  const artistSelectors = [
    '.collection-item-artist',
    '.recommended-item-artist',
    '.item-artist',
    '.artist',
    '.by',
    '.waypoint-artist-title',
  ];

  let title = '';
  for (const selector of titleSelectors) {
    const el = itemRoot.querySelector(selector);
    const text = norm(el?.textContent);
    if (text && !isGenericRecommendationTitle(text)) {
      title = text;
      break;
    }
  }

  let artist = '';
  for (const selector of artistSelectors) {
    const el = itemRoot.querySelector(selector);
    const text = stripLeadingBy(el?.textContent);
    if (text) {
      artist = text;
      break;
    }
  }

  if (!title || !artist) {
    const parsed = parseRecommendationText(itemRoot.textContent || '');
    if ((!title || isGenericRecommendationTitle(title)) && parsed.title) title = parsed.title;
    if (!artist && parsed.artist) artist = parsed.artist;
  }

  if (!title && !artist) return null;
  return { title, artist };
}



/* ============================================================================
 * JSON EXTRACTION HELPERS
 * ============================================================================ */



/**
 * Extract and parse JSON-LD structured data
 * @returns {JsonLdData|null} Parsed JSON-LD or null
 */
function extractJsonLd(): JsonLdData | null {
  const script = document.querySelector('script[type="application/ld+json"]');
  if (!script?.textContent) return null;

  try {
    return JSON.parse(script.textContent) as JsonLdData;
  } catch (error) {
    return null;
  }
}



/**
 * Extract JSON from a data-* attribute
 * @param {string} selector - Element selector
 * @param {string} attr - Attribute name
 * @returns {any|null} Parsed JSON or null
 */
function extractDataAttribute(selector: string, attr: string): any | null {
  const element = document.querySelector(selector);
  if (!element) return null;

  const data = element.getAttribute(attr);
  if (!data) return null;

  try {
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}



/* ============================================================================
 * TRACK TITLE EXTRACTION
 * ============================================================================ */



/**
 * Extract track title using multiple methods
 * FIXED v1.5: Added waypoint support for Feed pages (now playing track)
 * @returns {ExtractionResult|null} Title extraction result
 */
function extractTrackTitle(): ExtractionResult | null {
  // METHOD 0: External recommendation playback on release pages.
  // When audio track_id is not part of local data-tralbum, prefer active recommendation card metadata.
  if (isExternalRecommendationPlayback()) {
    const meta = getRecommendationNowPlayingMeta();
    if (meta?.title) {
      return {
        title: meta.title,
        source: 'recommendation:playing',
        confidence: 'high',
      };
    }
  }

  // METHOD 0A: Feed page waypoint (HIGHEST PRIORITY for feed pages)
  // The waypoint shows the currently playing track, not just any track in the feed
  const waypointTitle = document.querySelector('.waypoint-item-title, #track_play_waypoint .waypoint-item-title');
  if (waypointTitle) {
    const text = norm(waypointTitle.textContent);
    if (text) {
      return {
        title: text,
        source: 'waypoint:title',
        confidence: 'high',
      };
    }
  }

  // METHOD 0B: Collection page data-bind (HIGHEST PRIORITY for collection pages)
  if (isCollectionPage()) {
    const collectionSelectors = [
      '[data-bind*="trackTitle"]',
      '[data-bind*="currentTrack().title"]',
    ];

    for (const selector of collectionSelectors) {
      const element = document.querySelector(selector);
      const text = norm(element?.textContent);
      if (text && !text.includes('collection')) {
        return {
          title: text,
          source: `collection:${selector}`,
          confidence: 'high',
        };
      }
    }
  }

  // METHOD 0C: Collection item title (LOWER priority - may not be playing track)
  if (isCollectionPage()) {
    const collectionItem = document.querySelector('.collection-item-title');
    if (collectionItem) {
      const text = norm(collectionItem.textContent);
      if (text && !text.includes('collection')) {
        return {
          title: text,
          source: 'collection:.collection-item-title',
          confidence: 'medium', // Lower confidence - might not be playing
        };
      }
    }
  }

  // METHOD 1: Match audio track_id (for album pages)
  const audioTrackId = getAudioTrackId();
  if (audioTrackId) {
    const tralbum = extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;
    if (tralbum?.trackinfo && tralbum.trackinfo.length > 0) {
      const matchingTrack = tralbum.trackinfo.find(
        (t: BandcampTrackInfo) => String(t.track_id) === audioTrackId || String(t.id) === audioTrackId
      );

      if (matchingTrack?.title) {
        return {
          title: norm(matchingTrack.title),
          source: 'data-tralbum:trackinfo[audio_match]',
          confidence: 'high',
        };
      }
    }
  }

  // METHOD 2: JSON-LD (highest confidence)
  const ldJson = extractJsonLd();
  if (ldJson?.name) {
    return {
      title: norm(ldJson.name),
      source: 'json-ld',
      confidence: 'high',
    };
  }

  // METHOD 3: data-tralbum attribute - check trackinfo with is_playing
  const tralbum = extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;

  // Check if a track is marked as playing
  if (tralbum?.trackinfo && tralbum.trackinfo.length > 0) {
    const currentTrack = tralbum.trackinfo.find((t: BandcampTrackInfo) => t.is_playing);
    if (currentTrack?.title) {
      return {
        title: norm(currentTrack.title),
        source: 'data-tralbum:trackinfo[is_playing]',
        confidence: 'high',
      };
    }
  }

  // Use current.title only if type is 'track' (single track pages)
  if (tralbum?.current?.type === 'track' && tralbum?.current?.title) {
    return {
      title: norm(tralbum.current.title),
      source: 'data-tralbum:current[track]',
      confidence: 'high',
    };
  }

  // If album page with no playing track, use first track
  if (tralbum?.current?.type === 'album' && tralbum?.trackinfo && tralbum.trackinfo.length > 0) {
    const firstTrack = tralbum.trackinfo[0];
    if (firstTrack?.title) {
      return {
        title: norm(firstTrack.title),
        source: 'data-tralbum:trackinfo[0]',
        confidence: 'medium',
      };
    }
  }

  // Last resort - use current.title (might be album title)
  if (tralbum?.current?.title) {
    return {
      title: norm(tralbum.current.title),
      source: 'data-tralbum:current',
      confidence: 'medium',
    };
  }

  // METHOD 4: DOM selectors (medium confidence)
  const selectors = [
    'h2.trackTitle',
    '.trackTitle',
    '#name-section h2.trackTitle',
    '#name-section .trackTitle',
    'h2[itemprop="name"]',
    '.track_info .title',
    '.collection-player .track-title',
    '#collection-player .track-title',
    '.play_status .track-title',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = norm(element?.textContent);
    if (text) {
      return {
        title: text,
        source: `dom:${selector}`,
        confidence: 'medium',
      };
    }
  }

  // METHOD 5: Meta tags (low confidence)
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (ogTitle) {
    // og:title format is usually "Track Title, by Artist Name"
    const parts = ogTitle.split(',');
    if (parts[0]) {
      return {
        title: norm(parts[0]),
        source: 'og:title',
        confidence: 'low',
      };
    }
  }

  return null;
}



/* ============================================================================
 * ARTIST NAME EXTRACTION
 * ============================================================================ */



/**
 * Extract artist name using multiple methods
 * FIXED v1.5: Added waypoint support for Feed pages (now playing track)
 * @returns {ExtractionResult|null} Artist extraction result
 */
function extractArtistName(): ExtractionResult | null {
  // METHOD 0: External recommendation playback on release pages.
  if (isExternalRecommendationPlayback()) {
    const meta = getRecommendationNowPlayingMeta();
    if (meta?.artist) {
      return {
        artist: meta.artist,
        source: 'recommendation:playing',
        confidence: 'high',
      };
    }
  }

  // METHOD 0A: Feed page waypoint (HIGHEST PRIORITY for feed pages)
  const waypointArtist = document.querySelector('.waypoint-artist-title, #track_play_waypoint .waypoint-artist-title');
  if (waypointArtist) {
    let text = norm(waypointArtist.textContent);
    text = stripLeadingBy(text);
    if (text) {
      return {
        artist: text,
        source: 'waypoint:artist',
        confidence: 'high',
      };
    }
  }

  // METHOD 0B: Collection page data-bind (HIGHEST PRIORITY for collection pages)
  if (isCollectionPage()) {
    const collectionSelectors = [
      '[data-bind*="currentTrack().artist"]',
      '[data-bind*="artist"]',
    ];

    for (const selector of collectionSelectors) {
      const element = document.querySelector(selector);
      const text = norm(element?.textContent);
      if (text && text.length > 0) {
        return {
          artist: text,
          source: `collection:${selector}`,
          confidence: 'high',
        };
      }
    }
  }

  // METHOD 0C: Collection item artist (LOWER priority - may not be playing track)
  if (isCollectionPage()) {
    const collectionArtist = document.querySelector('.collection-item-artist');
    if (collectionArtist) {
      let text = norm(collectionArtist.textContent);
      text = stripLeadingBy(text);
      if (text) {
        return {
          artist: text,
          source: 'collection:.collection-item-artist',
          confidence: 'medium', // Lower confidence - might not be playing
        };
      }
    }
  }

  // METHOD 1: data-tralbum artist field (HIGHEST PRIORITY)
  // This is the actual track/album artist, not the page owner
  // Critical for label pages where data-band.name is the label, not the artist
  const tralbum = extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;
  if (tralbum?.artist) {
    return {
      artist: norm(tralbum.artist),
      source: 'data-tralbum',
      confidence: 'high',
    };
  }

  // METHOD 2: JSON-LD inAlbum.byArtist (for tracks on label/compilation pages)
  const ldJson = extractJsonLd();
  if (ldJson?.inAlbum?.byArtist?.name) {
    return {
      artist: norm(ldJson.inAlbum.byArtist.name),
      source: 'json-ld:inAlbum',
      confidence: 'high',
    };
  }

  // METHOD 3: JSON-LD byArtist (may be label on label pages, lower priority)
  if (ldJson?.byArtist?.name) {
    return {
      artist: norm(ldJson.byArtist.name),
      source: 'json-ld:byArtist',
      confidence: 'medium',
    };
  }

  // METHOD 4: data-band attribute (may be label, not track artist)
  // Only used if data-tralbum.artist not available
  const band = extractDataAttribute('script[data-band]', 'data-band') as BandcampBandData | null;
  if (band?.name) {
    return {
      artist: norm(band.name),
      source: 'data-band',
      confidence: 'medium',
    };
  }

  // METHOD 5: DOM selectors (low confidence)
  const selectors = [
    '#band-name-location .title',
    '#name-section .fromAlbum',
    'span[itemprop="byArtist"] span[itemprop="name"]',
    '.artist-override',
    'p#band-name-location span a',
    '.collection-player .artist',
    '#collection-player .artist',
    '.play_status .artist',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    let text = norm(element?.textContent);

    // Clean up common prefixes
    if (text) {
      text = stripLeadingBy(text);
      if (text) {
        return {
          artist: text,
          source: `dom:${selector}`,
          confidence: 'low',
        };
      }
    }
  }

  // METHOD 6: Meta tag (low confidence)
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (ogTitle) {
    // og:title format: "Track Title, by Artist Name"
    const match = ogTitle.match(/,\s*by\s+(.+)$/i);
    if (match && match[1]) {
      return {
        artist: stripLeadingBy(match[1]),
        source: 'og:title',
        confidence: 'low',
      };
    }
  }

  // METHOD 7: Subdomain (last resort) - but NOT for collection pages
  if (!isCollectionPage()) {
    const subdomain = window.location.hostname.replace('.bandcamp.com', '');
    if (subdomain && subdomain !== 'bandcamp' && subdomain !== 'www') {
      return {
        artist: subdomain,
        source: 'subdomain',
        confidence: 'low',
      };
    }
  }

  return null;
}



/* ============================================================================
 * ALBUM TITLE EXTRACTION (OPTIONAL)
 * ============================================================================ */



/**
 * Extract album title if available
 * @returns {string|null}
 */
function extractAlbumTitle(): string | null {
  // Collection page
  if (isCollectionPage()) {
    const albumElement = document.querySelector('[data-bind*="albumTitle"]') ||
                         document.querySelector('[data-bind*="currentTrack().albumTitle"]');
    if (albumElement) {
      const text = norm(albumElement.textContent);
      if (text) return text;
    }
  }

  const tralbum = extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;

  // If current item is a track, check for album title
  if (tralbum?.current?.type === 'track' && tralbum?.album_title) {
    return norm(tralbum.album_title);
  }

  // If current item is an album, use current.title
  if (tralbum?.current?.type === 'album' && tralbum?.current?.title) {
    return norm(tralbum.current.title);
  }

  // Check JSON-LD
  const ldJson = extractJsonLd();
  if (ldJson?.inAlbum?.name) {
    return norm(ldJson.inAlbum.name);
  }

  // Check DOM
  const albumLink = document.querySelector('.fromAlbum a');
  if (albumLink) {
    return norm(albumLink.textContent);
  }

  return null;
}



/* ============================================================================
 * MAIN EXTRACTION FUNCTION
 * ============================================================================ */



/**
 * Extract complete track metadata with confidence scoring
 * @returns {TrackMetadata|null} Complete track metadata or null
 */
export function getTrackMetaRobust(): TrackMetadata | null {
  const titleResult = extractTrackTitle();
  const artistResult = extractArtistName();

  if (!titleResult && !artistResult) {
    return null;
  }

  // Use results or fallback to empty strings
  const trackTitle = titleResult?.title || '';
  const artistName = artistResult?.artist || '';
  const albumTitle = extractAlbumTitle();

  // Determine overall confidence
  let overallConfidence: ConfidenceLevel = 'medium';
  if (titleResult?.confidence === 'high' && artistResult?.confidence === 'high') {
    overallConfidence = 'high';
  } else if (titleResult?.confidence === 'low' || artistResult?.confidence === 'low') {
    overallConfidence = 'low';
  }

  // Create combined string (for compatibility)
  const combined = artistName && trackTitle
    ? `${artistName} — ${trackTitle}`
    : trackTitle || artistName || '---';

  const metadata: TrackMetadata = {
    artistName,
    trackTitle,
    albumTitle: albumTitle || undefined,
    combined,
    confidence: overallConfidence,
    sources: {
      title: titleResult?.source || 'none',
      artist: artistResult?.source || 'none',
    },
  };

  return metadata;
}



/**
 * Backwards-compatible wrapper for existing code
 * @returns {TrackMetadata} Track metadata (never null for compatibility)
 */
export function getTrackMeta(): TrackMetadata {
  const robust = getTrackMetaRobust();

  if (!robust) {
    return {
      artistName: '',
      trackTitle: '',
      combined: '---',
    };
  }

  return {
    artistName: robust.artistName,
    trackTitle: robust.trackTitle,
    combined: robust.combined,
    albumTitle: robust.albumTitle,
    confidence: robust.confidence,
    sources: robust.sources,
  };
}



/* ============================================================================
 * CHANGE DETECTION (OPTIONAL)
 * ============================================================================ */



/**
 * Monitor for metadata changes (for track changes in player)
 * @param {Function} callback - Called when metadata changes
 * @returns {Function} Cleanup function to stop monitoring
 */
export function watchMetadataChanges(callback: (metadata: TrackMetadata) => void): () => void {
  let lastKey: string | null = null;

  const check = () => {
    const metadata = getTrackMetaRobust();
    if (!metadata) return;

    const key = `${metadata.artistName}|${metadata.trackTitle}`;
    if (key !== lastKey) {
      lastKey = key;
      callback(metadata);
    }
  };

  // Check immediately
  check();

  // Watch for DOM changes AND audio element changes
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: false,
  });

  // Also listen for audio track changes
  const audio = document.querySelector('audio');
  if (audio) {
    audio.addEventListener('loadedmetadata', check);
    audio.addEventListener('play', check);
  }

  // Return cleanup function
  return () => {
    observer.disconnect();
    if (audio) {
      audio.removeEventListener('loadedmetadata', check);
      audio.removeEventListener('play', check);
    }
  };
}
