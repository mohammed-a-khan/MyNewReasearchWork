/**
 * EZ Shop chat under /chat: a tiny two-user chat for multi-actor journeys
 * (docs/multi-actor.md).
 *
 *   /chat/login              sign in with a name (cookie "chatuser", one per browser context)
 *   /chat                    the room: messages (refreshed every 250 ms, no reload), a message box and Send
 *   /chat/api/messages       GET the messages (JSON); POST {text} as the signed-in user
 *   /chat/reset              POST: empty the room (tests)
 *
 * Who you are comes only from your own cookie, so two users in one browser
 * context would overwrite each other: the chat proves actors are isolated.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ChatState {
  messages: Array<{ id: number; from: string; text: string; at: string }>;
  seq: number;
}

export function newChatState(): ChatState {
  return { messages: [], seq: 0 };
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function userOf(req: IncomingMessage): string | undefined {
  const m = /(?:^|;\s*)chatuser=([A-Za-z0-9_-]{1,20})(?:;|$)/.exec(req.headers.cookie ?? '');
  return m?.[1];
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:1rem;max-width:40rem}#messages{list-style:none;padding:0;border:1px solid #ccc;min-height:6rem}#messages li{padding:.2rem .5rem}</style></head><body>${body}</body></html>`;

/** Handle /chat requests; returns false for other paths. */
export async function handleChat(req: IncomingMessage, res: ServerResponse, url: URL, state: ChatState): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/chat' && !path.startsWith('/chat/')) return false;
  const user = userOf(req);
  if (path === '/chat/login' && req.method === 'GET') {
    send(res, 200, page('Chat sign in', `<h1>Chat</h1><form method="post" action="/chat/login"><p><label for="name">Your name</label> <input id="name" name="name" autocomplete="off"></p><p><button type="submit">Join the chat</button></p></form>`));
    return true;
  }
  if (path === '/chat/login' && req.method === 'POST') {
    const name = (new URLSearchParams(await readBody(req)).get('name') ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(name)) {
      send(res, 400, page('Chat sign in', '<p role="alert">A name has 1-20 letters or digits</p>'));
      return true;
    }
    res.writeHead(302, { location: '/chat', 'set-cookie': `chatuser=${name}; Path=/; SameSite=Lax` });
    res.end();
    return true;
  }
  if (path === '/chat/reset' && req.method === 'POST') {
    state.messages = [];
    send(res, 200, '{"ok":true}', 'application/json');
    return true;
  }
  if (path === '/chat/api/messages') {
    if (req.method === 'POST') {
      if (!user) {
        send(res, 401, '{"error":"sign in first"}', 'application/json');
        return true;
      }
      let text = '';
      try {
        text = String((JSON.parse(await readBody(req)) as { text?: unknown }).text ?? '').trim().slice(0, 500);
      } catch {
        /* empty */
      }
      if (!text) {
        send(res, 400, '{"error":"empty message"}', 'application/json');
        return true;
      }
      const m = { id: ++state.seq, from: user, text, at: new Date().toISOString() };
      state.messages.push(m);
      send(res, 201, JSON.stringify(m), 'application/json');
      return true;
    }
    send(res, 200, JSON.stringify(state.messages), 'application/json');
    return true;
  }
  if (path === '/chat') {
    if (!user) {
      res.writeHead(302, { location: '/chat/login' });
      res.end();
      return true;
    }
    send(res, 200, page(`Chat - ${user}`, `<h1>Chat</h1><p>Signed in as <strong data-testid="chat-user">${esc(user)}</strong></p>
<ul id="messages" aria-label="Messages" aria-live="polite"></ul>
<form id="send-form"><label for="message">Message</label> <input id="message" autocomplete="off"> <button type="submit">Send</button></form>
<p id="sent" role="status"></p>
<script>
const list = document.getElementById('messages');
let shown = 0;
async function refresh() {
  try {
    const all = await (await fetch('/chat/api/messages')).json();
    if (all.length < shown) { list.textContent = ''; shown = 0; }
    for (const m of all.slice(shown)) {
      const li = document.createElement('li');
      li.textContent = m.from + ': ' + m.text;
      li.dataset.from = m.from;
      list.appendChild(li);
    }
    shown = all.length;
  } catch (e) { /* the next poll retries */ }
}
setInterval(refresh, 250);
refresh();
document.getElementById('send-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const box = document.getElementById('message');
  const text = box.value;
  const r = await fetch('/chat/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  document.getElementById('sent').textContent = r.ok ? 'Sent' : 'Not sent';
  box.value = '';
  refresh();
});
</script>`));
    return true;
  }
  send(res, 404, page('Not found', '<h1>Page not found</h1>'));
  return true;
}
