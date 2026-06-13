// @ts-nocheck
const SNAPSHOT_GATE_KEY = '__BC_UNIFIED_NON_RELEASE_SNAPSHOT__';
function parseBooleanToken(value) {
    const token = String(value || '').trim().toLowerCase();
    if (!token) {
        return null;
    }
    if (token === '1' || token === 'true' || token === 'on' || token === 'yes') {
        return true;
    }
    if (token === '0' || token === 'false' || token === 'off' || token === 'no') {
        return false;
    }
    return null;
}
function getSnapshotContext(input) {
    if (input.context === 'discover') {
        return 'discover';
    }
    const pageType = String(input.pageType || '').trim();
    if (pageType === 'feed') {
        return 'feed';
    }
    if (pageType === 'bandcamp-root') {
        return 'bandcamp-root';
    }
    if (pageType === 'recommendations') {
        return 'recommendations';
    }
    return 'other';
}
function getDefaultGate(context) {
    // Unified non-release resolver snapshot is now the default for core non-release contexts.
    // Keep localStorage overrides as an immediate runtime rollback/opt-in control:
    // - __BC_UNIFIED_NON_RELEASE_SNAPSHOT__=<0|1>
    // - __BC_UNIFIED_NON_RELEASE_SNAPSHOT__:feed=<0|1>
    // - __BC_UNIFIED_NON_RELEASE_SNAPSHOT__:bandcamp-root=<0|1>
    // - __BC_UNIFIED_NON_RELEASE_SNAPSHOT__:discover=<0|1>
    if (context === 'feed' || context === 'bandcamp-root' || context === 'discover') {
        return true;
    }
    return false;
}
function readStorageOverride(key) {
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) {
            return null;
        }
        return parseBooleanToken(raw);
    }
    catch {
        return null;
    }
}
export function shouldUseUnifiedNonReleaseSnapshot(input) {
    const context = getSnapshotContext(input);
    const contextOverride = readStorageOverride(`${SNAPSHOT_GATE_KEY}:${context}`);
    if (contextOverride !== null) {
        return contextOverride;
    }
    const globalOverride = readStorageOverride(SNAPSHOT_GATE_KEY);
    if (globalOverride !== null) {
        return globalOverride;
    }
    return getDefaultGate(context);
}
