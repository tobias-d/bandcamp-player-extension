import type { ContentMessage } from '@/shared/types';
import {
  handleAnalyzeBpmPrototype,
  handleAnalyzeKey,
  handleAnalyzeKeyDebug,
  handleClearAnalysisCache,
  handleAnalyzeTrack,
  handleAnalyzeTrackSilent,
  handleCancelAnalysis,
  handleCancelKeyAnalysis,
  handleGetWaveform
} from '@/background/handlers/analysis';
import {
  handleFetchFancollectionItems,
  handleGetPersistentBoughtLikesCache,
  handleGetSharedLikesCache,
  handleResolveFanId,
  handleSetPersistentBoughtLikesCache,
  handleSetSharedLikesCache,
  handleToggleWishlistItem
} from '@/background/handlers/likes';
import { handleNotifyPlaybackStarted } from '@/background/handlers/playback-handoff';
import {
  handleCancelPlaybackAudio,
  handleFetchPlaybackAudio
} from '@/background/handlers/playback-audio';
import { handleFetchTralbum } from '@/background/handlers/tralbum';
import { handleOpenBackgroundTab } from '@/background/handlers/open-tab';
import {
  handleCloseResourceDiagnosticsSession,
  handleGetResourceDiagnostics,
  handleOpenResourceDiagnosticsSession
} from '@/background/handlers/diagnostics';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';

const logger = createLogger('MESSAGING');

export type RuntimeMessageDispatcher = (
  message: ContentMessage,
  sender: chrome.runtime.MessageSender
) => Promise<unknown> | undefined;

export function dispatchSharedRuntimeMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> | undefined {
  switch (message.type) {
    case 'ANALYZE_TRACK':
      return handleAnalyzeTrack(message, sender);
    case 'ANALYZE_TRACK_SILENT':
      return handleAnalyzeTrackSilent(message);
    case 'ANALYZE_BPM_PROTOTYPE':
      return handleAnalyzeBpmPrototype(message);
    case 'CANCEL_ANALYSIS':
      return handleCancelAnalysis(message, sender);
    case 'ANALYZE_KEY':
      return handleAnalyzeKey(message, sender);
    case 'CANCEL_KEY_ANALYSIS':
      return handleCancelKeyAnalysis(message, sender);
    case 'GET_WAVEFORM':
      return handleGetWaveform(message);
    case 'ANALYZE_KEY_DEBUG':
      return handleAnalyzeKeyDebug(message);
    case 'CLEAR_ANALYSIS_CACHE':
      return handleClearAnalysisCache();
    case 'FETCH_TRALBUM':
      return handleFetchTralbum(message);
    case 'RESOLVE_FAN_ID':
      return handleResolveFanId(message);
    case 'GET_SHARED_LIKES_CACHE':
      return handleGetSharedLikesCache(message);
    case 'SET_SHARED_LIKES_CACHE':
      return handleSetSharedLikesCache(message);
    case 'GET_PERSISTENT_BOUGHT_LIKES_CACHE':
      return handleGetPersistentBoughtLikesCache(message);
    case 'SET_PERSISTENT_BOUGHT_LIKES_CACHE':
      return handleSetPersistentBoughtLikesCache(message);
    case 'FETCH_FANCOLLECTION_ITEMS':
      return handleFetchFancollectionItems(message);
    case 'TOGGLE_WISHLIST_ITEM':
      return handleToggleWishlistItem(message);
    case 'CANCEL_PLAYBACK_AUDIO':
      return handleCancelPlaybackAudio(message);
    case 'FETCH_PLAYBACK_AUDIO':
      return handleFetchPlaybackAudio(message);
    case 'NOTIFY_PLAYBACK_STARTED':
      return handleNotifyPlaybackStarted(message, sender);
    case 'OPEN_BACKGROUND_TAB':
      return handleOpenBackgroundTab(message, sender);
    case 'OPEN_RESOURCE_DIAGNOSTICS_SESSION':
      return handleOpenResourceDiagnosticsSession(message);
    case 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION':
      return handleCloseResourceDiagnosticsSession(message);
    case 'GET_RESOURCE_DIAGNOSTICS':
      return handleGetResourceDiagnostics(message);
    default:
      return undefined;
  }
}

export function registerRuntimeRouter(dispatch: RuntimeMessageDispatcher = dispatchSharedRuntimeMessage): void {
  if (!browserApi.runtime?.onMessage) {
    logger.warn('runtime.onMessage unavailable; router not registered');
    return;
  }

  browserApi.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as ContentMessage;
    const handler = dispatch(msg, sender);

    if (!handler) {
      return false;
    }

    handler
      .then((value) => {
        sendResponse(value);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ error: message });
      });

    return true;
  });
}
