// Build-time constants injected by webpack DefinePlugin (see webpack.config.js).

// The browser this bundle was built for ('firefox' | 'chrome'). Lets shared code compile
// browser-specific behavior per build; dead branches are dropped by the minifier.
declare const __BUILD_TARGET__: string;
