/**
 * ============================================================================
 * BROWSER API REFERENCE
 * ============================================================================
 * 
 * Provides a unified reference to the browser extension API.
 * Handles cross-browser compatibility (Chrome vs Firefox).
 * 
 * USAGE:
 * Import this module whenever you need to access browser.* or chrome.* APIs
 * 
 * BROWSER COMPATIBILITY:
 * - Firefox: uses 'browser' namespace
 * - Chrome/Edge: uses 'chrome' namespace
 * 
 * @module background/api
 * @exports {object} api - Browser extension API object (browser or chrome)
 */

export const api = typeof browser !== 'undefined' ? browser : chrome;
