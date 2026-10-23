/**
 * The Studio page skeleton. The client bundle (`/app.js`, `/app.css`) builds
 * the whole UI; no inline script or style (CSP `script-src 'self'`). The
 * session token reaches the client through the meta tag only.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="eztest-token" content="__TOKEN__">
<meta name="eztest-style-nonce" content="__STYLE_NONCE__">
<title>EZTest Studio</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<div id="app" class="boot" aria-busy="true"><p class="boot-msg">Loading EZTest Studio…</p></div>
<noscript><p>EZTest Studio needs JavaScript.</p></noscript>
</body>
</html>
`;

/** Shown without a valid token. */
export const LOGIN_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EZTest Studio</title></head><body><main><h1>EZTest Studio</h1>' +
  '<p>Open the Studio with the link printed by <code>eztest studio</code> (it contains the session token).</p></main></body></html>';
