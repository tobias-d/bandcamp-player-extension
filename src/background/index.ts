/**
 * ============================================================================
 * BACKGROUND SERVICE ENTRY POINT
 * ============================================================================
 * 
 * Entry point for the browser extension's background service worker.
 * Initializes the message handling system for communication between
 * the content scripts and background service.
 * 
 * @module background/index
 * @version 2026-02-15-typescript
 */

import { api } from './api.js';
import { registerMessageHandlers } from './messaging.js';

// Initialize message handlers with browser API
registerMessageHandlers(api);

console.log('Bandcamp Player Extension: Background service initialized');
