type TralbumEndpointType = 'mobile' | 'info' | 'other';

interface EndpointHealth {
  failureStreak: number;
  lastFailureAt: number;
  suppressUntil: number;
}

interface PreparedAttemptUrls {
  urls: string[];
  suppressedInfoCount: number;
}

interface EndpointHealthConfig {
  failureStreakThreshold: number;
  suppressTtlMs: number;
  staleResetMs: number;
}

const ENDPOINT_HEALTH_CONFIG: EndpointHealthConfig = {
  failureStreakThreshold: 3,
  suppressTtlMs: 7 * 60 * 1000,
  staleResetMs: 2 * 60 * 1000
};

const MAX_SUPPRESS_TTL_MS = ENDPOINT_HEALTH_CONFIG.suppressTtlMs;
const INFO_HEALTH_MAX_ORIGINS = 200;

const endpointHealthByKey = new Map<string, EndpointHealth>();

function readOrigin(urlRaw: string): string {
  try {
    const parsed = new URL(urlRaw);
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

function pruneInfoHealth(now = Date.now()): void {
  if (endpointHealthByKey.size <= INFO_HEALTH_MAX_ORIGINS) {
    return;
  }

  for (const [healthKey, state] of endpointHealthByKey.entries()) {
    if (state.suppressUntil > now) {
      continue;
    }
    if (now - state.lastFailureAt > MAX_SUPPRESS_TTL_MS) {
      endpointHealthByKey.delete(healthKey);
    }
  }
}

function getEndpointType(urlRaw: string): TralbumEndpointType {
  try {
    const parsed = new URL(urlRaw);
    const path = parsed.pathname.toLowerCase();
    if (path.includes('/api/mobile/24/tralbum_details')) {
      return 'mobile';
    }
    if (path.includes('/api/tralbum/2/info')) {
      return 'info';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

function isHealthManagedEndpoint(endpointType: TralbumEndpointType): endpointType is 'info' {
  return endpointType === 'info';
}

function buildHealthKey(endpointType: 'info', origin: string): string {
  return `${endpointType}|${origin}`;
}

function isEndpointSuppressed(endpointType: 'info', origin: string, now = Date.now()): boolean {
  if (!origin) {
    return false;
  }
  const state = endpointHealthByKey.get(buildHealthKey(endpointType, origin));
  if (!state) {
    return false;
  }
  return state.suppressUntil > now;
}

export function prepareAttemptUrlsForEndpointHealth(urls: string[]): PreparedAttemptUrls {
  const now = Date.now();
  const hasMobileCandidate = urls.some((url) => getEndpointType(url) === 'mobile');
  if (!hasMobileCandidate) {
    return {
      urls,
      suppressedInfoCount: 0
    };
  }

  const kept: string[] = [];
  let suppressedInfoCount = 0;
  for (const url of urls) {
    const endpointType = getEndpointType(url);
    if (isHealthManagedEndpoint(endpointType)) {
      const origin = readOrigin(url);
      if (isEndpointSuppressed(endpointType, origin, now)) {
        suppressedInfoCount += 1;
        continue;
      }
    }
    kept.push(url);
  }

  // Fail-safe: if filtering removed everything, keep original order.
  if (!kept.length) {
    return {
      urls,
      suppressedInfoCount: 0
    };
  }

  return {
    urls: kept,
    suppressedInfoCount
  };
}

export function noteAttemptEndpointFailure(urlRaw: string): void {
  const endpointType = getEndpointType(urlRaw);
  if (!isHealthManagedEndpoint(endpointType)) {
    return;
  }
  const origin = readOrigin(urlRaw);
  if (!origin) {
    return;
  }

  const config = ENDPOINT_HEALTH_CONFIG;
  const now = Date.now();
  const healthKey = buildHealthKey(endpointType, origin);
  const current = endpointHealthByKey.get(healthKey) ?? {
    failureStreak: 0,
    lastFailureAt: 0,
    suppressUntil: 0
  };

  const staleFailureWindow = now - current.lastFailureAt > config.staleResetMs;
  const nextFailureStreak = staleFailureWindow ? 1 : current.failureStreak + 1;
  const nextSuppressUntil =
    nextFailureStreak >= config.failureStreakThreshold
      ? Math.max(current.suppressUntil, now + config.suppressTtlMs)
      : current.suppressUntil;

  endpointHealthByKey.set(healthKey, {
    failureStreak: nextFailureStreak,
    lastFailureAt: now,
    suppressUntil: nextSuppressUntil
  });
  pruneInfoHealth(now);
}

export function noteAttemptEndpointSuccess(urlRaw: string): void {
  const endpointType = getEndpointType(urlRaw);
  if (!isHealthManagedEndpoint(endpointType)) {
    return;
  }
  const origin = readOrigin(urlRaw);
  if (!origin) {
    return;
  }
  const healthKey = buildHealthKey(endpointType, origin);
  const existing = endpointHealthByKey.get(healthKey);
  if (!existing) {
    return;
  }

  endpointHealthByKey.set(healthKey, {
    failureStreak: 0,
    lastFailureAt: existing.lastFailureAt,
    suppressUntil: 0
  });
}
