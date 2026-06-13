import { dispatchSharedRuntimeMessage, registerRuntimeRouter } from '@/background/router-core';
import type { ContentMessage } from '@/shared/types';
import {
  handleAnalyzeBpmPrototype,
  handleAnalyzeKey,
  handleAnalyzeKeyDebug,
  handleAnalyzeTrack,
  handleAnalyzeTrackSilent,
  handleCancelAnalysis,
  handleCancelKeyAnalysis,
  handleGetWaveform
} from '@/targets/chrome/background/handlers/analysis';
import {
  handleCloseResourceDiagnosticsSession,
  handleGetResourceDiagnostics,
  handleOpenResourceDiagnosticsSession
} from '@/targets/chrome/background/handlers/diagnostics';

function dispatchChromeRuntimeMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> | undefined {
  switch (message.type) {
    case 'ANALYZE_TRACK':
      return handleAnalyzeTrack(message);
    case 'ANALYZE_TRACK_SILENT':
      return handleAnalyzeTrackSilent(message);
    case 'CANCEL_ANALYSIS':
      return handleCancelAnalysis(message);
    case 'ANALYZE_KEY':
      return handleAnalyzeKey(message);
    case 'CANCEL_KEY_ANALYSIS':
      return handleCancelKeyAnalysis(message);
    case 'GET_WAVEFORM':
      return handleGetWaveform(message);
    case 'ANALYZE_KEY_DEBUG':
      return handleAnalyzeKeyDebug(message);
    case 'ANALYZE_BPM_PROTOTYPE':
      return handleAnalyzeBpmPrototype(message);
    case 'OPEN_RESOURCE_DIAGNOSTICS_SESSION':
      return handleOpenResourceDiagnosticsSession(message);
    case 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION':
      return handleCloseResourceDiagnosticsSession(message);
    case 'GET_RESOURCE_DIAGNOSTICS':
      return handleGetResourceDiagnostics(message);
    default:
      return dispatchSharedRuntimeMessage(message, sender);
  }
}

export function registerRouter(): void {
  registerRuntimeRouter(dispatchChromeRuntimeMessage);
}
