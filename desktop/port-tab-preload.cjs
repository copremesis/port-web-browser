const { webFrame } = require('electron');

// Lets Dark Reader's world add styles on pages with a strict Content-Security-Policy.
// The page's own code stays under its policy. The ID must match DARK_READER_WORLD in main.cjs.
webFrame.setIsolatedWorldInfo(1001, {
  name: 'Dark Reader',
  securityOrigin: location.origin,
  csp: "default-src * 'unsafe-inline' data: blob:",
});
