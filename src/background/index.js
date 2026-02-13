/**
 * ============================================================================
 * BACKGROUND SERVICE ENTRY POINT
 * ============================================================================
 * 
 * Entry point for the browser extension's background service worker.
 * Initializes the message handling system for communication between
 * the content scripts and background service.
 * 
 * RESPONSIBILITIES:
 * - Import browser API reference
 * - Register message handlers for inter-script communication
 * - Bootstrap the background service
 * 
 * ARCHITECTURE:
 * This file acts as the minimal bootstrap layer. All actual functionality
 * is delegated to specialized modules (messaging, analyzer, storage, etc.)
 * 
 * @module background/index
 * @version 2026-02-13
 */

import { api } from './api.js';
import { registerMessageHandlers } from './messaging.js';

// Initialize message handlers with browser API
registerMessageHandlers(api);
