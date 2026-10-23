/** The page (token-gated) and the client bundle. */
import { randomBytes } from 'node:crypto';
import { COOKIE_NAME, tokenMatches } from '../security.js';
import { loadClient } from '../bundle.js';
import { PAGE_CSP, sendText } from '../http.js';
import { INDEX_HTML, LOGIN_HTML } from '../ui/html.js';
import type { StudioRoute } from './route.js';

export function staticRoutes(token: string): StudioRoute[] {
  return [
    {
      method: ['GET', 'HEAD'],
      path: /^\/(?:index\.html)?$/,
      auth: 'public',
      summary: 'The Studio page (needs ?token= or the session cookie)',
      handler({ req, res, app, query, method }) {
        const qp = query.get('token');
        const ok = qp !== null ? tokenMatches(token, qp) : app.authed(req, true);
        if (!ok) {
          res.setHeader('Content-Security-Policy', PAGE_CSP);
          return sendText(res, 401, 'text/html; charset=utf-8', LOGIN_HTML, method === 'HEAD');
        }
        // The editor (CodeMirror) mounts its base styles in a <style> element: allow exactly that element with a
        // per-response nonce. Scripts stay 'self' only; no 'unsafe-inline' anywhere.
        const nonce = randomBytes(16).toString('base64');
        res.setHeader('Content-Security-Policy', PAGE_CSP.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
        if (qp !== null) res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        sendText(res, 200, 'text/html; charset=utf-8', INDEX_HTML.replace('__TOKEN__', token).replace('__STYLE_NONCE__', nonce), method === 'HEAD');
      },
    },
    {
      method: ['GET', 'HEAD'],
      path: '/app.js',
      auth: 'public',
      summary: 'Client bundle',
      async handler({ res, method }) {
        const b = await loadClient();
        sendText(res, 200, 'text/javascript; charset=utf-8', b.js, method === 'HEAD');
      },
    },
    {
      method: ['GET', 'HEAD'],
      path: '/app.css',
      auth: 'public',
      summary: 'Client styles',
      async handler({ res, method }) {
        const b = await loadClient();
        sendText(res, 200, 'text/css; charset=utf-8', b.css, method === 'HEAD');
      },
    },
    {
      method: ['GET', 'HEAD'],
      path: '/favicon.ico',
      auth: 'public',
      handler({ res }) {
        res.writeHead(204);
        res.end();
      },
    },
  ];
}
