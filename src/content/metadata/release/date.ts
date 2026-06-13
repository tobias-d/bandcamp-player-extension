// @ts-nocheck
import { asRecord } from '@/content/metadata/common';
function toEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        if (value >= 1000000000000) {
            return Math.floor(value);
        }
        return Math.floor(value * 1000);
    }
    const text = String(value ?? '').trim();
    if (!text) {
        return 0;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
        if (numeric >= 1000000000000) {
            return Math.floor(numeric);
        }
        return Math.floor(numeric * 1000);
    }
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }
    return parsed;
}
function buildReleaseDate(value, source) {
    const epochMs = toEpochMs(value);
    if (!epochMs) {
        return null;
    }
    return {
        raw: String(value ?? '').trim(),
        iso: new Date(epochMs).toISOString(),
        epochMs,
        source
    };
}
export function pickReleaseDateFromTralbum(tralbum, sourcePrefix) {
    const record = asRecord(tralbum);
    if (!record) {
        return undefined;
    }
    const current = asRecord(record['current']);
    const candidates = [
        { value: record['album_release_date'], source: `${sourcePrefix}.album_release_date` },
        { value: record['release_date'], source: `${sourcePrefix}.release_date` },
        { value: record['publish_date'], source: `${sourcePrefix}.publish_date` },
        { value: current?.['album_release_date'], source: `${sourcePrefix}.current.album_release_date` },
        { value: current?.['release_date'], source: `${sourcePrefix}.current.release_date` },
        { value: current?.['publish_date'], source: `${sourcePrefix}.current.publish_date` },
        { value: record['new_date'], source: `${sourcePrefix}.new_date` }
    ];
    for (const candidate of candidates) {
        const resolved = buildReleaseDate(candidate.value, candidate.source);
        if (resolved) {
            return resolved;
        }
    }
    return undefined;
}
