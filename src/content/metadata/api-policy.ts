import { isReleaseContext } from '@/content/metadata/common';

export type ApiPolicyContext = 'release' | 'discover' | 'non-release';
export type ApiFallbackMode = 'release-only' | 'allowed';

export interface ApiPolicyDescriptor {
  context: ApiPolicyContext;
  fallbackMode: ApiFallbackMode;
  strategy: 'api-first';
}

export function readApiPolicyDescriptor(): ApiPolicyDescriptor {
  const inDiscover = window.location.pathname.startsWith('/discover');
  const inRelease = isReleaseContext();
  const context: ApiPolicyContext = inRelease ? 'release' : inDiscover ? 'discover' : 'non-release';
  return {
    context,
    fallbackMode: 'release-only',
    strategy: 'api-first'
  };
}

export function formatApiPolicyLine(): string {
  const policy = readApiPolicyDescriptor();
  return `context=${policy.context}, strategy=${policy.strategy}, fallback=${policy.fallbackMode}`;
}

function normalizeResolutionSource(source: string): string {
  const value = String(source || '').trim();
  if (!value) {
    return 'unknown';
  }
  if (value.startsWith('TralbumAPI')) {
    return 'api';
  }
  if (value.startsWith('TralbumData')) {
    return 'globals';
  }
  if (value.startsWith('none')) {
    return 'none';
  }
  return 'other';
}

function parseFetchGateReason(fetchGateDebug: string): string {
  const raw = String(fetchGateDebug || '').trim();
  if (!raw) {
    return 'none';
  }
  const match = raw.match(/\breason=([^\s]+)/);
  return match?.[1] ? String(match[1]).trim() : 'none';
}

function formatFetchGateState(fetchGateReason: string): string {
  switch (fetchGateReason) {
    case 'request-start':
      return 'request-started';
    case 'in-flight':
      return 'request-in-flight';
    case 'request-error':
      return 'request-error';
    case 'cache-hit':
      return 'cache-hit';
    case 'none':
      return 'idle';
    default:
      return fetchGateReason;
  }
}

export function formatApiShadowPolicyLine(input: { playlistSource: string; fetchGateDebug: string }): string {
  const policy = readApiPolicyDescriptor();
  const wouldBlockHtmlFallback = policy.context === 'release' ? 0 : 1;
  const apiGateState = formatFetchGateState(parseFetchGateReason(input.fetchGateDebug));
  const finalResolutionSource = normalizeResolutionSource(input.playlistSource);
  const fallbackUsed = finalResolutionSource === 'api' ? 0 : finalResolutionSource === 'none' ? '-' : 1;
  return `wouldBlockHtmlFallback=${wouldBlockHtmlFallback}, apiGate=${apiGateState}, finalResolutionSource=${finalResolutionSource}, fallbackUsed=${fallbackUsed}`;
}
