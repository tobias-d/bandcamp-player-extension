export const ORIGIN_BRIDGE_SCRIPT_SECTION_B = `
          if (!Array.isArray(entries) || !entries.length) {
            return;
          }
          entries.slice(-200).forEach((entry) => {
            const url = entry && typeof entry === 'object' && 'name' in entry ? String(entry.name || '') : '';
            if (url) {
              postIdentityHintFromUrl(url);
            }
          });
        } catch (_) {}
      };

      const scanIdentityHintsFromPayload = (payload, sourceUrl) => {
        try {
          const wantedTrackId = getCurrentAudioTrackId();
          const queue = [
            {
              node: payload,
              depth: 0,
              bandId: '',
              tralbumId: '',
              tralbumType: '',
              trackId: ''
            }
          ];
          const visited = new Set();
          const maxDepth = 8;
          const maxNodes = 5000;
          let scanned = 0;

          while (queue.length > 0 && scanned < maxNodes) {
            const item = queue.shift();
            if (!item || !item.node || typeof item.node !== 'object') {
              continue;
            }
            if (visited.has(item.node)) {
              continue;
            }
            visited.add(item.node);
            scanned += 1;

            const record = item.node;
            const bandId = firstNonEmpty(
              toId(record.band_id),
              toId(record.bandId),
              toId(record.selling_band_id),
              toId(record.sellingBandId),
              item.bandId
            );
            const tralbumId = firstNonEmpty(
              toId(record.tralbum_id),
              toId(record.tralbumId),
              toId(record.item_id),
              toId(record.itemId),
              toId(record.album_id),
              toId(record.albumId),
              toId(record.release_id),
              toId(record.releaseId),
              item.tralbumId
            );
            const tralbumType =
              toType(record.tralbum_type || record.tralbumType || record.item_type || record.itemType) || item.tralbumType || '';
            const trackId = firstNonEmpty(
              toId(record.track_id),
              toId(record.trackId),
              toId(record.trackid),
              tralbumType === 't' ? toId(record.item_id) : '',
              tralbumType === 't' ? toId(record.itemId) : '',
              tralbumType === 't' ? toId(record.id) : '',
              item.trackId
            );
            const isPlayingFlag = Boolean(
              record.is_playing ||
              record.isPlaying ||
              record.playing ||
              record.currently_playing ||
              record.is_current ||
              record.current
            );
            const releaseUrl = firstNonEmpty(
              normalizeReleaseUrl(
                firstNonEmpty(
                  record.item_url,
                  record.itemUrl,
                  record.tralbum_url,
                  record.tralbumUrl,
                  record.album_url,
                  record.albumUrl,
                  record.track_url,
                  record.trackUrl,
                  record.url,
                  record.link
                )
              ),
              sourceUrl || 'api-payload'
            );

            if (bandId && tralbumId) {
              emitApiHint(bandId, tralbumId, tralbumType, releaseUrl, trackId);
              if (wantedTrackId && isPlayingFlag) {
                emitApiHint(bandId, tralbumId, tralbumType, releaseUrl, wantedTrackId);
              }
            }

            if (item.depth >= maxDepth) {
              continue;
            }

            Object.values(record).forEach((value) => {
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
                        tralbumType,
                        trackId
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
                  tralbumType,
                  trackId
                });
              }
            });
          }
        } catch (_) {}
      };

      const scanWindowForTrackIdentity = () => {
        try {
          const wantedTrackId = getCurrentAudioTrackId();

          const roots = [];
          const seenRoots = new Set();
          const pushRoot = (value) => {
            if (!value || typeof value !== 'object' || seenRoots.has(value)) {
              return;
            }
            seenRoots.add(value);
            roots.push(value);
          };

          pushRoot(window.TralbumData);
          pushRoot(window.BandData);
          pushRoot(window.PageData);
          pushRoot(window.FanData);
          pushRoot(window.CurrentFan);
          pushRoot(window.CollectionData);
          pushRoot(window.CollectionGridsData);
          pushRoot(window.CollectionGrids);
          pushRoot(window.CollectionItems);
          pushRoot(window.WishlistData);
          pushRoot(window.WishlistItems);
          pushRoot(window.BCData);

          Object.keys(window).forEach((key) => {
            if (!/(collection|wishlist|fan|bc|player|track|item|release)/i.test(key)) {
              return;
            }
            try {
              const value = window[key];
              pushRoot(value);
            } catch (_) {}
          });

          const queue = roots.map((node) => ({
            node,
            depth: 0,
            bandId: '',
            tralbumId: '',
            tralbumType: ''
          }));

          const visited = new Set();
          const maxDepth = 8;
          const maxNodes = 12000;
          let postedInThisScan = 0;
          const maxPostsPerScan = 80;
          let scanned = 0;

          while (queue.length > 0 && scanned < maxNodes) {
            const item = queue.shift();
            if (!item || !item.node || typeof item.node !== 'object') {
              continue;
            }
            if (visited.has(item.node)) {
              continue;
            }
            visited.add(item.node);
            scanned += 1;

            const record = item.node;
            const bandId = firstNonEmpty(
              toId(record.band_id),
              toId(record.bandId),
              toId(record.selling_band_id),
              toId(record.sellingBandId),
              item.bandId
            );
            const tralbumId = firstNonEmpty(
              toId(record.tralbum_id),
              toId(record.tralbumId),
              toId(record.item_id),
              toId(record.itemId),
              toId(record.album_id),
              toId(record.albumId),
              toId(record.release_id),
              toId(record.releaseId),
              item.tralbumId
            );
            const tralbumType =
              toType(record.tralbum_type || record.tralbumType || record.item_type || record.itemType) || item.tralbumType || '';
            const inferredTrackId = firstNonEmpty(
              toId(record.track_id),
              toId(record.trackId),
              toId(record.trackid),
              tralbumType === 't' ? toId(record.item_id) : '',
              tralbumType === 't' ? toId(record.itemId) : '',
              tralbumType === 't' ? toId(record.id) : ''
            );
            const isPlayingFlag = Boolean(
              record.is_playing ||
              record.isPlaying ||
              record.playing ||
              record.currently_playing ||
              record.is_current ||
              record.current
            );
            const releaseUrl = normalizeReleaseUrl(
              firstNonEmpty(
                record.item_url,
                record.itemUrl,
                record.tralbum_url,
                record.tralbumUrl,
                record.album_url,
                record.albumUrl,
                record.track_url,
                record.trackUrl,
                record.url,
                record.link
              )
            );
`;
