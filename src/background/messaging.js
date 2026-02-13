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
 *                ↓ (during analysis)
 *         ANALYSIS_PARTIAL messages sent back to content script
 * 
 * PROGRESSIVE UPDATES:
 * During analysis, sends partial updates back to the requesting tab
 * via ANALYSIS_PARTIAL messages for real-time UI feedback.
 * 
 * @module background/messaging
 * @version 2026-02-13
 */

import { analyzeUrl } from './analyzer.js';
import { getBeatModeStored, setBeatModeStored } from './storage.js';
import { getWaveformForUrl } from './waveform.js';

/**
 * Register all message handlers for the extension
 * 
 * HANDLER PATTERN:
 * - Each handler returns a Promise
 * - Errors are caught and converted to {error, ts} responses
 * - Undefined returns allow message propagation
 * 
 * @param {object} api - Browser API object (from api.js)
 */
export function registerMessageHandlers(api) {
  api.runtime.onMessage.addListener((msg, sender) => {
    // Ignore malformed messages
    if (!msg || !msg.type) return;

    // Get beat mode preference
    if (msg.type === 'GETBEATMODE') {
      return getBeatModeStored(api).then((beatMode) => ({ beatMode }));
    }

    // Set beat mode preference
    if (msg.type === 'SETBEATMODE') {
      return setBeatModeStored(api, msg.beatMode);
    }

    // Get waveform data only (without BPM analysis)
    if ((msg.type === 'GETWAVEFORM' || msg.type === 'GET_WAVEFORM') && msg.url) {
      return getWaveformForUrl(msg.url).catch((e) => ({
        error: e?.message || String(e),
        ts: Date.now(),
      }));
    }

    // Full track analysis with progressive updates
    if ((msg.type === 'ANALYZE_TRACK' || msg.type === 'ANALYZETRACK') && msg.url) {
      const tabId = sender?.tab?.id;
      
      // Create update callback to send partial results back to content script
      const onUpdate = (tabId !== undefined && tabId !== null)
        ? (partial) => {
            try {
              api.tabs.sendMessage(tabId, { type: 'ANALYSIS_PARTIAL', url: msg.url, ...partial });
            } catch (_) {}
          }
        : null;
      
      // Start analysis with progress updates
      return analyzeUrl(msg.url, msg.beatMode, onUpdate).catch((e) => ({
        error: e?.message || String(e),
        ts: Date.now(),
      }));
    }

    // Message not handled - allow propagation
    return;
  });
}
