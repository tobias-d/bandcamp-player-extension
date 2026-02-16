/**
 * Background entrypoint.
 *
 * Responsibilities:
 * - Initialize Essentia WASM once at startup
 * - Register runtime message handlers for content/background communication
 *
 * @module background/index
 */

import { registerMessageHandlers } from './messaging';
import { initEssentia } from './tempo-essentia';

const api = typeof chrome !== 'undefined' ? chrome : (globalThis as any).browser;

(async () => {
  try {
    console.log('[Extension] Initializing Essentia BPM detector...');
    await initEssentia();
    console.log('[Extension] Essentia initialized successfully');
    
    registerMessageHandlers(api);
    console.log('[Extension] Ready!');
  } catch (error) {
    console.error('[Extension] Initialization failed:', error);
  }
})();
