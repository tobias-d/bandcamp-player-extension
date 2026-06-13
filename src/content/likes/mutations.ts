import type { LikeIdentity, PageGlobals } from '@/shared/types';
import { getLatestPageGlobals, requestLikesMutationViaBridge } from '@/content/discover/origin-bridge';
import { normalizeLikeId } from '@/content/likes/state';
import { resolveViewerFanId } from '@/content/likes/viewer-id';
import { detectPageContext, resolveLikeMutationRuntimeContext } from '@/content/page-context';
import { extractMutationCrumbFromText } from '@/utils/html-parser';

export interface LikeMutationResult {
  ok: boolean;
  reason: string;
  error?: string;
  transport?: 'page-bridge' | '-';
  status?: number;
}

export interface LikeMutationRequestInput {
  action: 'collect' | 'uncollect';
  fanId: string;
  itemId: string;
  itemType: 'album' | 'track';
  bandId?: string;
  crumb: string;
  pageUrl: string;
  requestContextFamily: string;
  requestContextVariant: string;
}

export interface LikeMutationPreflight {
  ok: boolean;
  reasonCode: string;
  request: LikeMutationRequestInput | null;
  details: {
    identityItemId: string;
    identityItemType: string;
    identityBandId: string;
    identityPageUrl: string;
    pageHost: string;
    targetHost: string;
    sameHost: boolean;
    fanId: string;
    crumbPresent: boolean;
    crumbLength: number;
    crumbSource: string;
    requestPreview: string;
    requestContextFamily: string;
    requestContextVariant: string;
  };
}

const ROOT_CRUMB_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedRootCrumb = '';
let cachedRootCrumbAt = 0;

function readRecordValue(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) {
    return '';
  }
  for (const key of keys) {
    const value = String(record[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function readEndpointRecordCrumb(record: Record<string, unknown> | null, endpointKey: string): string {
  const normalizedEndpointKey = String(endpointKey || '').trim().replace(/^\//, '');
  if (!normalizedEndpointKey) {
    return '';
  }
  return readRecordValue(record, [normalizedEndpointKey, `/${normalizedEndpointKey}`]);
}

function readDomCrumb(): string {
  const byInput = document.querySelector<HTMLInputElement>('input[name="crumb"][value]');
  const inputValue = String(byInput?.value || '').trim();
  if (inputValue) {
    return inputValue;
  }

  const byDataAttr = document.querySelector<HTMLElement>('[data-crumb]');
  const dataAttrValue = String(byDataAttr?.getAttribute('data-crumb') || '').trim();
  if (dataAttrValue) {
    return dataAttrValue;
  }

  const html = String(document.documentElement?.outerHTML || '');
  if (!html) {
    return '';
  }

  const jsonMatch = html.match(/["'](?:bc_)?crumb["']\s*[:=]\s*["']([^"']{8,})["']/i);
  if (jsonMatch?.[1]) {
    return String(jsonMatch[1]).trim();
  }
  const inputMatch = html.match(/name=["']crumb["']\s+value=["']([^"']{8,})["']/i);
  if (inputMatch?.[1]) {
    return String(inputMatch[1]).trim();
  }
  const dataMatch = html.match(/data-crumb=["']([^"']{8,})["']/i);
  if (dataMatch?.[1]) {
    return String(dataMatch[1]).trim();
  }
  return '';
}

function readMutationCrumb(
  globals: PageGlobals | null,
  action: 'collect' | 'uncollect'
): { value: string; source: string } {
  const endpointKey = action === 'collect' ? 'collect_item_cb' : 'uncollect_item_cb';
  const endpointPath = `/${endpointKey}`;
  const globalValue = window as unknown as Record<string, unknown>;

  const crumbs = globalValue['_crumbs'] as Record<string, unknown> | undefined;
  if (crumbs && typeof crumbs === 'object') {
    const fromCrumbs = readRecordValue(crumbs, [
      endpointKey,
      endpointPath,
      'crumb',
      'bc_page',
      'global',
      'bc_crumb'
    ]);
    if (fromCrumbs) {
      return { value: fromCrumbs, source: '_crumbs' };
    }
  }

  const gCrumb = readRecordValue(globalValue, ['gCrumb', 'crumb', 'bc_crumb']);
  if (gCrumb) {
    return { value: gCrumb, source: 'window' };
  }

  const tralbumData = globalValue['TralbumData'] as Record<string, unknown> | undefined;
  if (tralbumData && typeof tralbumData === 'object') {
    const fromTralbumData = readRecordValue(tralbumData, ['crumb', 'bc_crumb']);
    if (fromTralbumData) {
      return { value: fromTralbumData, source: 'tralbum' };
    }
    const tralbumCurrent =
      tralbumData['current'] && typeof tralbumData['current'] === 'object'
        ? (tralbumData['current'] as Record<string, unknown>)
        : null;
    const fromTralbumCurrent = readRecordValue(tralbumCurrent, ['crumb', 'bc_crumb']);
    if (fromTralbumCurrent) {
      return { value: fromTralbumCurrent, source: 'tralbum.current' };
    }
  }

  if (globals) {
    const records: Array<Record<string, unknown> | null> = [
      globals.page && typeof globals.page === 'object' ? (globals.page as Record<string, unknown>) : null,
      globals.bc && typeof globals.bc === 'object' ? (globals.bc as Record<string, unknown>) : null,
      globals.tralbum && typeof globals.tralbum === 'object' ? (globals.tralbum as Record<string, unknown>) : null,
      globals.band && typeof globals.band === 'object' ? (globals.band as Record<string, unknown>) : null,
      globals.collection && typeof globals.collection === 'object' ? (globals.collection as Record<string, unknown>) : null,
      globals.wishlist && typeof globals.wishlist === 'object' ? (globals.wishlist as Record<string, unknown>) : null
    ];
    for (const record of records) {
      const value = readEndpointRecordCrumb(record, endpointKey);
      if (value) {
        return { value, source: `globals.${endpointKey}` };
      }
    }
    for (const record of records) {
      const value = readRecordValue(record, ['crumb', 'bc_crumb', 'gCrumb', 'bc_page']);
      if (value) {
        return { value, source: 'globals' };
      }
    }
  }

  const domCrumb = readDomCrumb();
  return {
    value: domCrumb,
    source: domCrumb ? 'dom' : 'none'
  };
}

function readBandId(globals: PageGlobals | null): string {
  if (!globals) {
    return '';
  }
  const candidates: unknown[] = [];
  if (globals.tralbum && typeof globals.tralbum === 'object') {
    const tralbum = globals.tralbum as Record<string, unknown>;
    candidates.push(tralbum['band_id'], tralbum['selling_band_id'], tralbum['collect_band_id'], tralbum['account_id']);
  }
  if (globals.band && typeof globals.band === 'object') {
    const band = globals.band as Record<string, unknown>;
    candidates.push(band['band_id'], band['id']);
  }
  if (globals.page && typeof globals.page === 'object') {
    const page = globals.page as Record<string, unknown>;
    candidates.push(page['band_id'], page['selling_band_id'], page['collect_band_id']);
  }
  for (const candidate of candidates) {
    const value = normalizeLikeId(candidate);
    if (value) {
      return value;
    }
  }
  return '';
}

function readHost(rawUrl: string): string {
  const value = String(rawUrl || '').trim();
  if (!value) {
    return '';
  }
  try {
    return new URL(value, window.location.href).host.toLowerCase();
  } catch {
    return '';
  }
}

async function readRootCrumb(action: 'collect' | 'uncollect'): Promise<{ value: string; source: string }> {
  if (cachedRootCrumb && Date.now() - cachedRootCrumbAt <= ROOT_CRUMB_CACHE_TTL_MS) {
    return { value: cachedRootCrumb, source: 'root-cache' };
  }
  const endpointKey = action === 'collect' ? 'collect_item_cb' : 'uncollect_item_cb';
  try {
    const response = await fetch(`${window.location.origin}/`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) {
      return { value: '', source: `root-http-${response.status}` };
    }
    const html = await response.text();
    const crumb = String(extractMutationCrumbFromText(html, endpointKey) || '').trim();
    if (!crumb) {
      return { value: '', source: 'root-none' };
    }
    cachedRootCrumb = crumb;
    cachedRootCrumbAt = Date.now();
    return { value: crumb, source: 'root-html' };
  } catch {
    return { value: '', source: 'root-error' };
  }
}

export async function resolveLikeMutationPreflight(
  action: 'collect' | 'uncollect',
  identity: LikeIdentity | null
): Promise<LikeMutationPreflight> {
  const pageHost = readHost(window.location.href);
  const identityItemId = normalizeLikeId(identity?.itemId || '');
  const identityItemType = identity?.itemType === 'track' ? 'track' : 'album';
  const identityBandId = normalizeLikeId(identity?.bandId || '');
  const identityPageUrl = String(identity?.pageUrl || window.location.href || '').trim();
  const targetHost = readHost(identityPageUrl);
  let sameHostMutation = Boolean(
    (pageHost && targetHost && pageHost === targetHost) ||
    pageHost === 'bandcamp.com'
  );
  const emptyDetails = {
    identityItemId,
    identityItemType,
    identityBandId,
    identityPageUrl,
    pageHost,
    targetHost,
    sameHost: sameHostMutation,
    fanId: '',
    crumbPresent: false,
    crumbLength: 0,
    crumbSource: '',
    requestPreview: '-',
    requestContextFamily: '',
    requestContextVariant: ''
  };
  if (!identity) {
    return { ok: false, reasonCode: 'blocked_identity_missing', request: null, details: emptyDetails };
  }

  const itemId = normalizeLikeId(identity.itemId || '');
  if (!itemId) {
    return { ok: false, reasonCode: 'blocked_missing_item_id', request: null, details: emptyDetails };
  }

  const globals = getLatestPageGlobals(15_000);
  const viewer = await resolveViewerFanId();
  const fanId = normalizeLikeId(viewer.fanId);
  if (!fanId) {
    return {
      ok: false,
      reasonCode: 'blocked_missing_fan_id',
      request: null,
      details: {
        ...emptyDetails,
        fanId: ''
      }
    };
  }

  const pageUrl = identityPageUrl;
  const pageContextForGate = detectPageContext({
    pageGlobals: globals,
    viewerFanIdHint: fanId
  });
  const runtimeContextForGate = resolveLikeMutationRuntimeContext(
    pageContextForGate,
    pageUrl,
    window.location.href
  );
  const runtimeContextFamily = String(runtimeContextForGate.family || '').trim();
  if (runtimeContextFamily && runtimeContextFamily !== 'release-pages') {
    sameHostMutation = true;
  }
  if (!sameHostMutation) {
    return {
      ok: false,
      reasonCode: `blocked_cross_host_release_required:${pageHost || '-'}->${targetHost || '-'}`,
      request: null,
      details: {
        ...emptyDetails,
        fanId
      }
    };
  }

  const rawCrumb = readMutationCrumb(globals, action);
  let crumb = String(rawCrumb.value || '').trim();
  let crumbSource = String(rawCrumb.source || '').trim();
  if (!crumb) {
    const rootCrumb = await readRootCrumb(action);
    crumb = String(rootCrumb.value || '').trim();
    if (crumb) {
      crumbSource = rootCrumb.source || 'root-html';
    } else if (!crumbSource) {
      crumbSource = rootCrumb.source || 'none';
    }
  }
  if (!crumb) {
    return {
      ok: false,
      reasonCode: 'blocked_missing_crumb',
      request: null,
      details: {
        ...emptyDetails,
        fanId,
        crumbPresent: false,
        crumbLength: 0,
        crumbSource: crumbSource || 'none'
      }
    };
  }

  const bandId = identityBandId || readBandId(globals) || '';
  const itemType = identity.itemType === 'track' ? 'track' : 'album';
  const requestContextFamily = String(runtimeContextForGate.family || pageContextForGate.likeContextFamily || '').trim();
  const requestContextVariant = String(runtimeContextForGate.variant || pageContextForGate.likeContextVariant || '').trim();
  const requestPreview = `fan=${fanId} item=${itemId} type=${itemType} band=${bandId || '-'} crumbLen=${crumb.length} page=${pageUrl || '-'} ctx=${requestContextFamily || '-'}:${requestContextVariant || '-'}`;
  return {
    ok: true,
    reasonCode: 'allowed',
    request: {
      action,
      fanId,
      itemId,
      itemType,
      bandId: bandId || undefined,
      crumb,
      pageUrl,
      requestContextFamily,
      requestContextVariant
    },
    details: {
      identityItemId: itemId,
      identityItemType: itemType,
      identityBandId: bandId || identityBandId || '',
      identityPageUrl: pageUrl,
      pageHost,
      targetHost,
      sameHost: sameHostMutation,
      fanId,
      crumbPresent: true,
      crumbLength: crumb.length,
      crumbSource: crumbSource || rawCrumb.source || 'unknown',
      requestPreview,
      requestContextFamily,
      requestContextVariant
    }
  };
}

export async function toggleWishlistItemPhase1StatusOnly(
  action: 'collect' | 'uncollect',
  identity: LikeIdentity | null,
  requestInput?: LikeMutationRequestInput | null
): Promise<LikeMutationResult> {
  const prepared = requestInput || (await resolveLikeMutationPreflight(action, identity)).request;
  if (!prepared) {
    return { ok: false, reason: 'wishlist-mutation-failed', error: 'preflight-missing' };
  }

  const bridgeResult: LikeMutationResult = await requestLikesMutationViaBridge(prepared)
    .then((response) => ({
      ok: Boolean(response.ok),
      reason: String(response.reason || (response.ok ? 'ok' : 'page-bridge-failed')),
      error: response.error,
      transport: 'page-bridge' as const,
      status: Number.isFinite(Number(response.status)) ? Number(response.status) : (response.ok ? 200 : 0)
    }))
    .catch((error) => ({
      ok: false,
      error: `page-bridge-error:${error instanceof Error ? error.message : String(error)}`,
      reason: 'page-bridge-failed',
      transport: 'page-bridge' as const,
      status: 0
    }));

  if (bridgeResult?.ok) {
    return { ok: true, reason: 'ok', transport: 'page-bridge', status: 200 };
  }
  const bridgeError = String((bridgeResult && (bridgeResult.error || bridgeResult.reason)) || '').trim();
  return {
    ok: false,
    reason: 'wishlist-mutation-failed',
    error: bridgeError || 'wishlist-mutation-failed',
    transport: 'page-bridge',
    status: Number.isFinite(Number(bridgeResult.status)) ? Number(bridgeResult.status) : 0
  };
}
