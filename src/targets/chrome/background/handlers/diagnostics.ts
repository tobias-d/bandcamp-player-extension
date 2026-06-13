// Chrome resource-diagnostics handlers.
//
// The shared handler manages the service-worker side (its own session set + sampler; the SW
// owns no workers, so its pool reads zero). These Chrome handlers additionally forward the
// session to the offscreen document — which owns the real Chrome worker pool — and merge its
// HostResourceDiagnostics into the response.
//
// Diagnostics must never create the offscreen document: spinning up its AudioContext just
// because the debug panel opened would be a real behavior change. We forward only when the
// document already exists (for analysis); otherwise the offscreen context reports "not running"
// (offscreen === null).

import type { ContentMessage, HostResourceDiagnostics, ResourceDiagnosticsResponse } from '@/shared/types';
import {
  handleCloseResourceDiagnosticsSession as sharedHandleCloseSession,
  handleGetResourceDiagnostics as sharedHandleGetDiagnostics,
  handleOpenResourceDiagnosticsSession as sharedHandleOpenSession
} from '@/background/handlers/diagnostics';
import {
  hasChromeAnalysisHostDocument,
  requestChromeAnalysisHost
} from '@/targets/chrome/background/offscreen-manager';

type OpenSessionMessage = Extract<ContentMessage, { type: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION' }>;
type CloseSessionMessage = Extract<ContentMessage, { type: 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION' }>;
type GetDiagnosticsMessage = Extract<ContentMessage, { type: 'GET_RESOURCE_DIAGNOSTICS' }>;

// Forward a diagnostics action to the offscreen host only if it already exists. Returns the
// offscreen diagnostics for GET (null on any failure), null otherwise.
async function forwardToOffscreen(
  action: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION' | 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION' | 'GET_RESOURCE_DIAGNOSTICS',
  sessionId: string
): Promise<HostResourceDiagnostics | null> {
  if (!(await hasChromeAnalysisHostDocument())) {
    return null;
  }
  try {
    const response = await requestChromeAnalysisHost<HostResourceDiagnostics>(action, { sessionId });
    return response.ok ? response.result : null;
  } catch {
    return null;
  }
}

export async function handleOpenResourceDiagnosticsSession(
  message: OpenSessionMessage
): Promise<{ ok: boolean }> {
  await sharedHandleOpenSession(message);
  void forwardToOffscreen('OPEN_RESOURCE_DIAGNOSTICS_SESSION', message.sessionId);
  return { ok: true };
}

export async function handleCloseResourceDiagnosticsSession(
  message: CloseSessionMessage
): Promise<{ ok: boolean }> {
  await sharedHandleCloseSession(message);
  void forwardToOffscreen('CLOSE_RESOURCE_DIAGNOSTICS_SESSION', message.sessionId);
  return { ok: true };
}

export async function handleGetResourceDiagnostics(
  message: GetDiagnosticsMessage
): Promise<ResourceDiagnosticsResponse> {
  const [base, offscreen] = await Promise.all([
    sharedHandleGetDiagnostics(message),
    forwardToOffscreen('GET_RESOURCE_DIAGNOSTICS', message.sessionId)
  ]);
  return { ...base, offscreen };
}
