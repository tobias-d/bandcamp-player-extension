/**
 * ============================================================================
 * BROWSER API REFERENCE
 * ============================================================================
 * 
 * Provides a single reference to the browser extension API.
 * Supports both Chrome (chrome.*) and Firefox (browser.*) namespaces.
 * 
 * This allows the rest of the codebase to use a consistent API reference
 * without worrying about browser-specific globals.
 * 
 * @module background/api
 * @version 2026-02-15-typescript
 */

/**
 * Browser API object (chrome or browser namespace)
 * 
 * In Chrome: uses 'chrome' global
 * In Firefox: uses 'browser' global
 */
export const api = (typeof chrome !== 'undefined' ? chrome : (self as any).browser) || chrome;
