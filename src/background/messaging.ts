/**
 * ============================================================================
 * MESSAGE HANDLER REGISTRY
 * ============================================================================
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
 * @version 2026-02-15-typescript
 */

import type { BeatMode, AnalysisResult } from '../types/index';
import { analyzeUrl } from './analyzer.js';
import { getBeatModeStored, setBeatModeStored } from './storage.js';
import { getWaveformForUrl } from './waveform.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

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
  | { type: 'ANALYZE_TRACK' | 'ANALYZETRACK'; url: string; beatMode?: BeatMode };

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
type ProgressCallback = ((partial: Partial<AnalysisResult>) => void) | null;

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

/**
 * Register all message handlers for the extension
 * 
 * HANDLER PATTERN:
 * - Each handler returns a Promise
 * - Errors are caught and converted to {error, ts} responses
 * - Undefined returns allow message propagation
 * 
 * @param api - Browser API object (from api.js)
 */
export function registerMessageHandlers(api: BrowserAPI): void {
  api.runtime.onMessage.addListener(
    (
      msg: IncomingMessage,
      sender: chrome.runtime.MessageSender
    ): Promise<any> | undefined => {
      // Ignore malformed messages
      if (!msg || !msg.type) return;

      // Get beat mode preference
      if (msg.type === 'GETBEATMODE') {
        return getBeatModeStored(api as any).then(
          (beatMode): BeatModeResponse => ({ beatMode })
        );
      }

      // Set beat mode preference
      if (msg.type === 'SETBEATMODE') {
        return setBeatModeStored(api as any, msg.beatMode);
      }

      // Get waveform data only (without BPM analysis)
      if ((msg.type === 'GETWAVEFORM' || msg.type === 'GET_WAVEFORM') && msg.url) {
        return getWaveformForUrl(msg.url).catch(
          (e: any): ErrorResponse => ({
            error: e?.message || String(e),
            ts: Date.now(),
          })
        );
      }

      // Full track analysis with progressive updates
      if ((msg.type === 'ANALYZE_TRACK' || msg.type === 'ANALYZETRACK') && msg.url) {
        const tabId = sender?.tab?.id;

        // Create update callback to send partial results back to content script
        const onUpdate: ProgressCallback =
          tabId !== undefined && tabId !== null
            ? (partial: Partial<AnalysisResult>) => {
                try {
                  const message: AnalysisPartialMessage = {
                    type: 'ANALYSIS_PARTIAL',
                    url: msg.url,
                    ...partial,
                  };
                  api.tabs.sendMessage(tabId, message);
                } catch (_) {
                  // Ignore errors (tab might be closed)
                }
              }
            : null;

        // Start analysis with progress updates
        return analyzeUrl(msg.url, msg.beatMode, onUpdate).catch(
          (e: any): ErrorResponse => ({
            error: e?.message || String(e),
            ts: Date.now(),
          })
        );
      }

      // Message not handled - allow propagation
      return undefined;
    }
  );
}
