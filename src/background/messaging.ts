/**
 * ============================================================================
 * MESSAGE HANDLER REGISTRY
 * ============================================================================
 * 
 * VERSION: 1.1 (2026-02-15)
 * 
 * Central message routing for browser extension communication.
 * Handles messages from content scripts and dispatches to appropriate services.
 * 
 * MESSAGE TYPES:
 * - GETBEATMODE: Retrieve stored beat mode preference
 * - SETBEATMODE: Update beat mode preference
 * - GETWAVEFORM/GET_WAVEFORM: Fetch waveform data for URL
 * - ANALYZE_TRACK/ANALYZETRACK: Start full track analysis
 * 
 * COMMUNICATION FLOW:
 * Content Script → Background Service → Storage/Analyzer → Response
 *                  ↓ (during analysis)
 *                  ANALYSIS_PARTIAL messages sent back to content script
 * 
 * PROGRESSIVE UPDATES:
 * During analysis, sends partial updates back to the requesting tab
 * via ANALYSIS_PARTIAL messages for real-time UI feedback.
 * 
 * @module background/messaging
 * @version 2026-02-15-v1.1
 */

import type { BeatMode, AnalysisResult } from '../shared/index';
import { analyzeUrl } from './analyzer';
import { getBeatModeStored, setBeatModeStored } from './storage';
import { getWaveformForUrl } from './waveform';

/* ============================================================================
 * TYPE DEFINITIONS
 * ============================================================================ */

/**
 * Browser API object (chrome or browser namespace)
 */
interface BrowserAPI {
  runtime: {
    onMessage: {
      addListener(
        callback: (
          message: any,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void | Promise<any>
      ): void;
    };
  };
  tabs: {
    sendMessage(tabId: number, message: any): Promise<any>;
  };
}

/**
 * Incoming message types from content scripts
 */
type IncomingMessage =
  | { type: 'GETBEATMODE' }
  | { type: 'SETBEATMODE'; beatMode: string }
  | { type: 'GETWAVEFORM' | 'GET_WAVEFORM'; url: string }
  | { type: 'ANALYZE_TRACK' | 'ANALYZETRACK'; url: string; beatMode?: BeatMode; cacheKey?: string }
  | { type: 'CANCEL_ANALYSIS'; url?: string };

/**
 * Response for beat mode get request
 */
interface BeatModeResponse {
  beatMode: BeatMode;
}

/**
 * Error response
 */
interface ErrorResponse {
  error: string;
  ts: number;
}

/**
 * Partial analysis update message sent to content script
 */
interface AnalysisPartialMessage extends Partial<AnalysisResult> {
  type: 'ANALYSIS_PARTIAL';
  url: string;
}

/**
 * Progress update callback type
 */
type ProgressCallback = (partial: Partial<AnalysisResult>) => void;

interface ActiveAnalysis {
  url: string;
  controller: AbortController;
}

const activeAnalysisByTab = new Map<number, ActiveAnalysis>();

function isAbortError(error: unknown): boolean {
  return (error as any)?.name === 'AbortError';
}

function cancelActiveAnalysisForTab(tabId: number | null | undefined, url?: string): boolean {
  if (tabId === undefined || tabId === null) return false;
  const active = activeAnalysisByTab.get(tabId);
  if (!active) return false;
  if (url && active.url !== url) return false;
  active.controller.abort();
  activeAnalysisByTab.delete(tabId);
  return true;
}

/* ============================================================================
 * MESSAGE HANDLER
 * ============================================================================ */

/**
 * Handle a single incoming message and return appropriate response
 * 
 * @param msg - Incoming message from content script
 * @param sender - Message sender information
 * @param api - Browser API object
 * @returns Promise with response data, or undefined if message not handled
 */
async function handleMessage(
  msg: IncomingMessage,
  sender: chrome.runtime.MessageSender,
  api: BrowserAPI
): Promise<any> {
  // Validate message
  if (!msg || !msg.type) {
    return undefined;
  }

  try {
    // Get beat mode preference
    if (msg.type === 'GETBEATMODE') {
      const beatMode = await getBeatModeStored(api as any);
      return { beatMode } as BeatModeResponse;
    }

    // Set beat mode preference
    if (msg.type === 'SETBEATMODE') {
      await setBeatModeStored(api as any, msg.beatMode);
      return { success: true };
    }

    // Get waveform data only (without BPM analysis)
    if (msg.type === 'GETWAVEFORM' || msg.type === 'GET_WAVEFORM') {
      if (!msg.url) {
        return { error: 'URL required', ts: Date.now() } as ErrorResponse;
      }

      try {
        const waveform = await getWaveformForUrl(msg.url);
        return waveform;
      } catch (e: any) {
        return {
          error: e?.message || String(e),
          ts: Date.now(),
        } as ErrorResponse;
      }
    }

    if (msg.type === 'CANCEL_ANALYSIS') {
      const tabId = sender?.tab?.id;
      const cancelled = cancelActiveAnalysisForTab(tabId, msg.url);
      return { cancelled, ts: Date.now() };
    }

    // Full track analysis with progressive updates
    if (msg.type === 'ANALYZE_TRACK' || msg.type === 'ANALYZETRACK') {
      if (!msg.url) {
        return { error: 'URL required', ts: Date.now() } as ErrorResponse;
      }

      const tabId = sender?.tab?.id;
      if (tabId !== undefined && tabId !== null) {
        const existing = activeAnalysisByTab.get(tabId);
        if (existing && existing.url !== msg.url) {
          existing.controller.abort();
          activeAnalysisByTab.delete(tabId);
        }
      }

      // Create update callback to send partial results back to content script
      let onUpdate: ProgressCallback | null = null;
      let controller: AbortController | null = null;

      if (tabId !== undefined && tabId !== null) {
        controller = new AbortController();
        activeAnalysisByTab.set(tabId, { url: msg.url, controller });

        onUpdate = (partial: Partial<AnalysisResult>): void => {
          try {
            if (controller?.signal.aborted) return;
            const message: AnalysisPartialMessage = {
              type: 'ANALYSIS_PARTIAL',
              url: msg.url,
              ...partial,
            };
            api.tabs.sendMessage(tabId, message).catch(() => {
              // Ignore errors (tab might be closed)
            });
          } catch (error) {
            // Ignore errors (tab might be closed)
          }
        };
      }

      // Start analysis with progress updates
      try {
        const result = await analyzeUrl(msg.url, msg.beatMode, onUpdate, {
          signal: controller?.signal || undefined,
          cacheIdentity: typeof msg.cacheKey === 'string' ? msg.cacheKey : undefined,
        });
        return result;
      } catch (e: any) {
        if (isAbortError(e)) {
          return {
            cancelled: true,
            ts: Date.now(),
          };
        }
        return {
          error: e?.message || String(e),
          ts: Date.now(),
        } as ErrorResponse;
      } finally {
        if (tabId !== undefined && tabId !== null) {
          const active = activeAnalysisByTab.get(tabId);
          if (active && active.controller === controller) {
            activeAnalysisByTab.delete(tabId);
          }
        }
      }
    }

    // Message type not recognized
    return undefined;
  } catch (error: any) {
    console.error('[Messaging] Unexpected error:', error);
    return {
      error: error?.message || String(error),
      ts: Date.now(),
    } as ErrorResponse;
  }
}

/**
 * Register all message handlers for the extension
 * 
 * HANDLER PATTERN:
 * - Each handler returns a Promise
 * - Errors are caught and converted to {error, ts} responses
 * - Undefined returns allow message propagation
 * 
 * @param api - Browser API object (from api.ts)
 */
export function registerMessageHandlers(api: BrowserAPI): void {
  api.runtime.onMessage.addListener(
    (
      msg: IncomingMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ): boolean => {
      // Handle message asynchronously
      handleMessage(msg, sender, api)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error) => {
          console.error('[Messaging] Handler error:', error);
          sendResponse({
            error: error?.message || String(error),
            ts: Date.now(),
          });
        });

      // Return true to indicate we'll call sendResponse asynchronously
      return true;
    }
  );
}
