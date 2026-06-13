export const ORIGIN_BRIDGE_SCRIPT_SECTION_C = `

            if (bandId && tralbumId && postedInThisScan < maxPostsPerScan) {
              const candidateKey = String(bandId) + ':' + String(tralbumId) + ':' + String(tralbumType || '-');
              if (!emittedIdentityKeys.has(candidateKey)) {
                emittedIdentityKeys.add(candidateKey);
                postedInThisScan += 1;
                emitApiHint(bandId, tralbumId, tralbumType, releaseUrl || 'window-candidate', inferredTrackId);
              }
            }

            if (wantedTrackId && isPlayingFlag && bandId && tralbumId && postedInThisScan < maxPostsPerScan) {
              postedInThisScan += 1;
              emitApiHint(bandId, tralbumId, tralbumType, releaseUrl || 'window-playing', wantedTrackId);
            }

            let matchesTrack = false;
            if (wantedTrackId) {
              if (inferredTrackId && inferredTrackId === wantedTrackId) {
                matchesTrack = true;
              }
            }

            if (wantedTrackId && !matchesTrack && record.file && typeof record.file === 'object') {
              const stream = String(record.file['mp3-128'] || record.file['mp3-v0'] || record.file['mp3-320'] || '');
              if (stream && readTrackIdFromUrl(stream) === wantedTrackId) {
                matchesTrack = true;
              }
            }

            if (wantedTrackId && !matchesTrack) {
              const streamLike = String(record.stream_url || record.streamUrl || record.url || '');
              if (streamLike && readTrackIdFromUrl(streamLike) === wantedTrackId) {
                matchesTrack = true;
              }
            }

            if (wantedTrackId && matchesTrack && bandId && tralbumId && postedInThisScan < maxPostsPerScan) {
              const dedupeKey = String(bandId) + ':' + String(tralbumId) + ':' + String(tralbumType || '-');
              if (!emittedIdentityKeys.has(dedupeKey)) {
                emittedIdentityKeys.add(dedupeKey);
                postedInThisScan += 1;
                emitApiHint(bandId, tralbumId, tralbumType, releaseUrl || 'window-scan', wantedTrackId);
              }
            }

            if (item.depth >= maxDepth) {
              continue;
            }

            Object.values(record).forEach((value) => {
              if (typeof value === 'string' && value.includes('band_id=') && value.includes('tralbum_id=')) {
                postIdentityHintFromUrl(value);
              }
              if (typeof value === 'string') {
                const trimmed = value.trim();
                if (
                  trimmed.length > 2 &&
                  trimmed.length < 200000 &&
                  (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
                  (trimmed.includes('track_id') || trimmed.includes('tralbum_id') || trimmed.includes('band_id'))
                ) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed && typeof parsed === 'object') {
                      queue.push({
                        node: parsed,
                        depth: item.depth + 1,
                        bandId,
                        tralbumId,
                        tralbumType
                      });
                    }
                  } catch (_) {}
                }
              }
              if (value && typeof value === 'object') {
                queue.push({
                  node: value,
                  depth: item.depth + 1,
                  bandId,
                  tralbumId,
                  tralbumType
                });
              }
            });
          }
        } catch (_) {}
      };

      const readFanIdFromRecord = (record) => {
        if (!record || typeof record !== 'object') {
          return '';
        }
        const direct = firstNonEmpty(
          toId(record.fan_id),
          toId(record.fanId),
          toId(record.fanid),
          toId(record.id),
          toId(record.user_id),
          toId(record.userId),
          toId(record.viewer_fan_id)
        );
        if (direct) {
          return direct;
        }
        const nested = record.fan || record.user || record.owner || record.current_fan || record.currentFan;
        if (nested && typeof nested === 'object') {
          return firstNonEmpty(
            toId(nested.fan_id),
            toId(nested.fanId),
            toId(nested.fanid),
            toId(nested.id),
            toId(nested.user_id),
            toId(nested.userId)
          );
        }
        return '';
      };

      const readPagedataBlob = () => {
        try {
          if (window.jQuery && typeof window.jQuery === 'function') {
            const blob = window.jQuery('#pagedata').data('blob');
            if (blob && typeof blob === 'object') {
              return blob;
            }
          }
        } catch (_) {}
        return null;
      };

      const readMutationCrumb = () => {
        const direct = firstNonEmpty(
          String(window.gCrumb || '').trim(),
          window._crumbs && typeof window._crumbs === 'object' ? String(window._crumbs.crumb || '').trim() : '',
          window._crumbs && typeof window._crumbs === 'object' ? String(window._crumbs.bc_page || '').trim() : '',
          window._crumbs && typeof window._crumbs === 'object' ? String(window._crumbs.global || '').trim() : ''
        );
        if (direct) {
          return direct;
        }

        const pagedataBlob = readPagedataBlob();
        if (pagedataBlob && typeof pagedataBlob === 'object') {
          const blobCrumb = firstNonEmpty(
            String(pagedataBlob.crumb || '').trim(),
            String(pagedataBlob.bc_crumb || '').trim(),
            String(pagedataBlob.bc_page || '').trim()
          );
          if (blobCrumb) {
            return blobCrumb;
          }
        }

        try {
          const input = document.querySelector('input[name="crumb"][value]');
          if (input && typeof input.value === 'string' && input.value.trim()) {
            return input.value.trim();
          }
          const withDataCrumb = document.querySelector('[data-crumb]');
          if (withDataCrumb) {
            const fromAttr = String(withDataCrumb.getAttribute('data-crumb') || '').trim();
            if (fromAttr) {
              return fromAttr;
            }
          }
        } catch (_) {}

        return '';
      };

      const readEndpointMutationCrumb = (endpointKey) => {
        const key = String(endpointKey || '').replace(/^\\//, '');
        if (!key || !window._crumbs || typeof window._crumbs !== 'object') {
          return '';
        }
        return firstNonEmpty(
          String(window._crumbs[key] || '').trim(),
          String(window._crumbs['/' + key] || '').trim()
        );
      };

      const resolveInjectedFan = () => {
        const candidates = [];
        const pagedataBlob = readPagedataBlob();
        if (window.FanData && typeof window.FanData === 'object') {
          candidates.push(window.FanData);
        }
        if (window.CurrentFan && typeof window.CurrentFan === 'object') {
          candidates.push(window.CurrentFan);
        }
        if (window.Identities && typeof window.Identities === 'object') {
          try {
            if (typeof window.Identities.fan === 'function') {
              const fanObj = window.Identities.fan();
              if (fanObj && typeof fanObj === 'object') {
                candidates.push(fanObj);
              }
            }
          } catch (_) {}
        }
        if (pagedataBlob && typeof pagedataBlob === 'object') {
          if (pagedataBlob.fan_data && typeof pagedataBlob.fan_data === 'object') {
            candidates.push(pagedataBlob.fan_data);
          }
          if (pagedataBlob.current_fan && typeof pagedataBlob.current_fan === 'object') {
            candidates.push(pagedataBlob.current_fan);
          }
        }
        if (window.PageData && typeof window.PageData === 'object') {
          if (window.PageData.current_fan && typeof window.PageData.current_fan === 'object') {
            candidates.push(window.PageData.current_fan);
          }
          if (window.PageData.fan && typeof window.PageData.fan === 'object') {
            candidates.push(window.PageData.fan);
          }
        }

        for (const candidate of candidates) {
          const fanId = readFanIdFromRecord(candidate);
          if (fanId) {
            const output = Object.assign({}, candidate);
            output.fan_id = output.fan_id || fanId;
            return output;
          }
        }
        return candidates[0] || null;
      };

      let lastObservedDiscoverPayloadKey = '';

      const extractDiscoverResults = (payload) => {
        if (Array.isArray(payload)) {
          return payload;
        }
        if (!payload || typeof payload !== 'object') {
          return [];
        }
        if (Array.isArray(payload.results)) {
          return payload.results;
        }
        if (payload.discovery && typeof payload.discovery === 'object' && Array.isArray(payload.discovery.results)) {
          return payload.discovery.results;
        }
        return [];
      };

      const normalizeObservedDiscoverPayload = (payload) => {
        if (Array.isArray(payload)) {
          return { results: payload };
        }
        return payload && typeof payload === 'object' ? payload : null;
      };

      const isDiscoverResultRecord = (item) => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        const featured = item.featured_track && typeof item.featured_track === 'object' ? item.featured_track : {};
        const streamUrl = String(featured.stream_url || featured.streamUrl || item.stream_url || item.streamUrl || '').trim();
        const releaseUrl = normalizeReleaseUrl(
          firstNonEmpty(
            item.item_url,
            item.itemUrl,
            item.tralbum_url,
            item.tralbumUrl,
            item.album_url,
            item.albumUrl,
            item.track_url,
            item.trackUrl,
            item.url,
            item.link
          )
        );
        const trackId = firstNonEmpty(
          toId(item.track_id),
          toId(item.trackId),
          toId(featured.track_id),
          toId(featured.trackId),
          readTrackIdFromUrl(streamUrl)
        );
        return Boolean(trackId || streamUrl || releaseUrl);
      };

      const buildObservedDiscoverPayloadKey = (payload) => {
        const results = extractDiscoverResults(payload);
        if (!results.length) {
          return '';
        }
        const sample = results
          .slice(0, 5)
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return '';
            }
            const featured = item.featured_track && typeof item.featured_track === 'object' ? item.featured_track : {};
            return firstNonEmpty(
              readTrackIdFromUrl(featured.stream_url || featured.streamUrl || ''),
              toId(item.track_id),
              normalizeReleaseUrl(item.item_url || item.itemUrl || item.url || item.link),
              String(item.title || '').trim()
            );
          })
          .filter(Boolean)
          .join('|');
        return String(results.length) + ':' + sample;
      };

      const postObservedDiscoverPayload = (payload, sourceUrl = 'window-discover') => {
        const normalizedPayload = normalizeObservedDiscoverPayload(payload);
        if (!normalizedPayload) {
          return false;
        }
        const results = extractDiscoverResults(normalizedPayload);
        if (!results.length || !results.some((item) => isDiscoverResultRecord(item))) {
          return false;
        }
        const payloadKey = buildObservedDiscoverPayloadKey(normalizedPayload);
        if (payloadKey && payloadKey === lastObservedDiscoverPayloadKey) {
          return true;
        }
        lastObservedDiscoverPayloadKey = payloadKey;
        post('DISCOVER_OBSERVED', normalizedPayload);
        scanIdentityHintsFromPayload(normalizedPayload, sourceUrl);
        return true;
      };

      const scanWindowForDiscoverPayload = () => {
        try {
          const pagedataBlob = readPagedataBlob();
          const roots = [];
          const seenRoots = new Set();
          const pushRoot = (value) => {
            if (!value || typeof value !== 'object' || seenRoots.has(value)) {
              return;
            }
            seenRoots.add(value);
            roots.push(value);
          };

          pushRoot(window.DiscoverData);
          pushRoot(window.BCData);
          pushRoot(window.PageData);
          pushRoot(window.__INITIAL_STATE__);
          pushRoot(window.__NEXT_DATA__);
          pushRoot(window.__NUXT__);
          pushRoot(window.APP_DATA);
          pushRoot(window.__APP_DATA__);
          pushRoot(pagedataBlob);
          pushRoot(pagedataBlob && typeof pagedataBlob === 'object' ? pagedataBlob.discovery_data : null);
          pushRoot(pagedataBlob && typeof pagedataBlob === 'object' ? pagedataBlob.discover_data : null);
          pushRoot(pagedataBlob && typeof pagedataBlob === 'object' ? pagedataBlob.results : null);

          Object.keys(window).forEach((key) => {
            if (!/(discover|discovery|featured|result|playlist)/i.test(key)) {
              return;
            }
            try {
              pushRoot(window[key]);
            } catch (_) {}
          });

          const queue = roots.map((node) => ({ node, depth: 0 }));
          const visited = new Set();
          const maxDepth = 7;
          const maxNodes = 4000;
          let scanned = 0;

          while (queue.length > 0 && scanned < maxNodes) {
            const item = queue.shift();
            if (!item) {
              continue;
            }
            const node = item.node;
            if (!node || typeof node !== 'object') {
              continue;
            }
            if (visited.has(node)) {
              continue;
            }
            visited.add(node);
            scanned += 1;

            if (postObservedDiscoverPayload(node, 'window-discover-scan')) {
              return;
            }

            if (Array.isArray(node) && postObservedDiscoverPayload({ results: node }, 'window-discover-array')) {
              return;
            }

            if (item.depth >= maxDepth) {
              continue;
            }

            Object.values(node).forEach((value) => {
              if (typeof value === 'string') {
                const trimmed = value.trim();
                if (
                  trimmed.length > 2 &&
                  trimmed.length < 250000 &&
                  (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
                  (
                    trimmed.includes('featured_track') ||
                    (trimmed.includes('results') && trimmed.includes('track_id'))
                  )
                ) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (postObservedDiscoverPayload(parsed, 'window-discover-json')) {
                      return;
                    }
                    if (parsed && typeof parsed === 'object') {
                      queue.push({ node: parsed, depth: item.depth + 1 });
                    }
                  } catch (_) {}
                }
              }
              if (value && typeof value === 'object') {
                queue.push({ node: value, depth: item.depth + 1 });
              }
            });
          }
        } catch (_) {}
      };

      const postGlobals = () => {
        const pagedataBlob = readPagedataBlob();
        const crumb = readMutationCrumb();
        const collectItemCrumb = readEndpointMutationCrumb('collect_item_cb');
        const uncollectItemCrumb = readEndpointMutationCrumb('uncollect_item_cb');
        post('PAGE_GLOBALS', {
          tralbum: window.TralbumData ?? null,
          band: window.BandData ?? null,
          page: window.PageData ?? pagedataBlob?.page_data ?? pagedataBlob?.page ?? null,
          fan: resolveInjectedFan(),
          collection:
            window.CollectionData ??
            window.CollectionGridsData ??
            window.CollectionGrids ??
            window.CollectionItems ??
            pagedataBlob?.collection_data ??
            null,
          wishlist:
            window.WishlistData ??
            window.WishlistItems ??
            pagedataBlob?.wishlist_data ??
            null,
          bc: Object.assign({}, window.BCData || {}, {
            crumb: crumb || undefined,
            bc_crumb: crumb || undefined,
            collect_item_cb: collectItemCrumb || undefined,
            uncollect_item_cb: uncollectItemCrumb || undefined
          })
        });
      };

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : req && typeof req === 'object' && 'url' in req ? req.url : '';
          postIdentityHintFromUrl(String(url || ''));
        } catch (_) {}

        const response = await originalFetch(...args);
        try {
          const url = String(args[0]);
          postIdentityHintFromUrl(response.url || url);
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json') || contentType.includes('+json')) {
            response
              .clone()
              .json()
              .then((json) => {
                scanIdentityHintsFromPayload(json, response.url || url);
                if (url.includes('/api/discover/1/discover_web')) {
                  post('DISCOVER_OBSERVED', json);
                }
              })
              .catch(() => {});
          } else if (url.includes('/api/discover/1/discover_web')) {
            response.clone().json().then((json) => post('DISCOVER_OBSERVED', json)).catch(() => {});
          }
          scanWindowForTrackIdentity();
          scanWindowForDiscoverPayload();
          scanPerformanceForHints();
        } catch (_) {}
        return response;
      };

      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          try {
            const responseUrl = String(this.responseURL || '');
            postIdentityHintFromUrl(responseUrl);
            const responseType = String(this.getResponseHeader('content-type') || '').toLowerCase();
            if (responseType.includes('application/json') || responseType.includes('+json')) {
              try {
                const parsed = JSON.parse(String(this.responseText || '{}'));
                scanIdentityHintsFromPayload(parsed, responseUrl);
                if (responseUrl.includes('/api/discover/1/discover_web')) {
                  post('DISCOVER_OBSERVED', parsed);
                }
              } catch (_) {}
            } else if (responseUrl.includes('/api/discover/1/discover_web')) {
              post('DISCOVER_OBSERVED', JSON.parse(String(this.responseText || '{}')));
            }
            scanWindowForTrackIdentity();
            scanWindowForDiscoverPayload();
            scanPerformanceForHints();
          } catch (_) {}
        });
        return originalSend.apply(this, args);
      };

      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const anchor = target.closest('a[href*="/album/"],a[href*="/track/"]');
        if (!anchor || !(anchor instanceof HTMLAnchorElement)) {
          return;
        }
        post('DISCOVER_SELECTION', { url: anchor.href });
        if (detachedAudio && !detachedAudio.paused && !detachedAudio.ended) {
          try {
            detachedAudio.pause();
          } catch (_) {}
        }
        const originAudio = pickOriginAudio();
        if (originAudio) {
          activeAudio = originAudio;
        }
        emitDiscoverAudioState(activeAudio || pickActiveAudio());
      }, true);

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', postGlobals, { once: true });
      } else {
        postGlobals();
      }

      const globalsPollId = window.setInterval(postGlobals, 3000);
      window.setTimeout(() => window.clearInterval(globalsPollId), 300000);
      const identityPollId = window.setInterval(scanWindowForTrackIdentity, 2000);
      window.setTimeout(() => window.clearInterval(identityPollId), 45000);
      const discoverPayloadPollId = window.setInterval(scanWindowForDiscoverPayload, 2000);
      window.setTimeout(() => window.clearInterval(discoverPayloadPollId), 45000);
      const perfPollId = window.setInterval(scanPerformanceForHints, 3000);
      window.setTimeout(() => window.clearInterval(perfPollId), 45000);

      document.addEventListener('play', postGlobals, true);
      document.addEventListener('playing', postGlobals, true);
      document.addEventListener('play', scanWindowForTrackIdentity, true);
      document.addEventListener('playing', scanWindowForTrackIdentity, true);
      document.addEventListener('play', scanWindowForDiscoverPayload, true);
      document.addEventListener('playing', scanWindowForDiscoverPayload, true);
      document.addEventListener('play', registerMediaSessionBridge, true);
      document.addEventListener('playing', registerMediaSessionBridge, true);

      ownedPlaybackHostStatus = 'ready';
      ownedPlaybackHostDetail = 'page-context bridge ready';
      registerMediaSessionBridge();
      emitOwnedPlaybackHostState();

      setTimeout(postGlobals, 50);
      setTimeout(postGlobals, 250);
      setTimeout(postGlobals, 1000);
      setTimeout(postGlobals, 3000);
      setTimeout(scanWindowForTrackIdentity, 400);
      setTimeout(scanWindowForTrackIdentity, 1200);
      setTimeout(scanWindowForTrackIdentity, 3000);
      setTimeout(scanWindowForDiscoverPayload, 150);
      setTimeout(scanWindowForDiscoverPayload, 800);
      setTimeout(scanWindowForDiscoverPayload, 2500);
      setTimeout(scanPerformanceForHints, 800);
      setTimeout(scanPerformanceForHints, 2500);
      setTimeout(emitOwnedPlaybackHostState, 50);
      setTimeout(emitOwnedPlaybackHostState, 500);

      Array.from(document.querySelectorAll('audio')).forEach((audio) => bindDiscoverAudio(audio));
      setInterval(() => emitOwnedPlaybackHostState(), 5000);
      setInterval(() => {
        const hasStableActive = Boolean(
          activeAudio &&
          !activeAudio.ended &&
          (activeAudio.currentSrc || activeAudio.src)
        );
        if (!hasStableActive) {
          activeAudio = pickActiveAudio();
        }
        emitDiscoverAudioState(activeAudio);
      }, 1000);
    })();
`;
