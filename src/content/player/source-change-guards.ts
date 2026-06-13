import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';

export interface SourceEventAcceptanceInput {
  candidateSrc: string;
  origin: string;
  now: number;
  isAuthoritativeEvent: boolean;
  forceUnifiedNonReleaseSnapshot: boolean;
  sourceVersion: number;
  activeAudioSrc: string;
  currentSrc: string;
  lastAuthoritativeSource: string;
  lastAuthoritativeSourceAt: number;
  lastAuthoritativeSourceVersion: number;
  staleBridgeSourceGuardMs: number;
  isPageReleaseSource(candidateSrc: string): boolean;
}

export interface SourceEventAcceptanceResult {
  accept: boolean;
  detail?: string;
}

export function isAuthoritativeSourceEvent(origin: string): boolean {
  return origin === 'audio-changed' || origin === 'source-changed';
}

export function resolveSourceEventAcceptance(
  input: SourceEventAcceptanceInput
): SourceEventAcceptanceResult {
  const nextSrc = String(input.candidateSrc || '').trim();
  if (!nextSrc) {
    return { accept: true };
  }

  if (input.isAuthoritativeEvent) {
    return { accept: true };
  }

  const currentSrc = String(input.currentSrc || '').trim();
  const latestAuthoritativeSource = String(input.lastAuthoritativeSource || '').trim();
  const currentSourceIsAuthoritative = Boolean(
    currentSrc &&
    latestAuthoritativeSource &&
    sourcesShareTrackIdentity(currentSrc, latestAuthoritativeSource)
  );
  if (
    currentSourceIsAuthoritative &&
    !sourcesShareTrackIdentity(currentSrc, nextSrc)
  ) {
    return {
      accept: false,
      detail: `origin=${input.origin} candidate=${nextSrc} authoritative=${currentSrc}`
    };
  }

  if (input.forceUnifiedNonReleaseSnapshot && !input.isPageReleaseSource(nextSrc)) {
    return { accept: true };
  }

  if (input.activeAudioSrc && input.activeAudioSrc !== nextSrc) {
    return {
      accept: false,
      detail: `origin=${input.origin} candidate=${nextSrc} active=${input.activeAudioSrc}`
    };
  }

  const staleAgainstLatestAuthoritative =
    Boolean(
      input.lastAuthoritativeSource &&
      input.lastAuthoritativeSource !== nextSrc &&
      input.sourceVersion >= input.lastAuthoritativeSourceVersion &&
      input.now - input.lastAuthoritativeSourceAt <= input.staleBridgeSourceGuardMs
    );
  if (staleAgainstLatestAuthoritative) {
    return {
      accept: false,
      detail: `origin=${input.origin} candidate=${nextSrc} authoritative=${input.lastAuthoritativeSource}`
    };
  }

  if (
    input.currentSrc &&
    input.currentSrc !== nextSrc &&
    input.activeAudioSrc &&
    input.activeAudioSrc === input.currentSrc
  ) {
    return {
      accept: false,
      detail: `origin=${input.origin} candidate=${nextSrc} current=${input.currentSrc}`
    };
  }

  return { accept: true };
}
