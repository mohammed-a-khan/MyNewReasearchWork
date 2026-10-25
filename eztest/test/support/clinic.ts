/**
 * A small pet clinic for tests: a web app (sign-in form, a home page that keeps who signed in in a cookie and in
 * localStorage, a page with console noise) and a project folder with an SQLite clinic database, a query
 * catalogue and a configuration. Neutral example domain; nothing here is a real product.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ClinicApp {
  url: string;
  /** Passwords by user (changeable by a test: password rotation). */
  users: Record<string, string>;
  /** Sign-in attempts (POST /login) by user. */
  attempts: Record<string, number>;
  close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return Object.fromEntries(new URLSearchParams(text));
}

/** Start the clinic web app on a free port. */
export async function startClinicApp(users: Record<string, string> = { desk: 'Desk#2026', vet: 'Vet#2026' }): Promise<ClinicApp> {
  const app: ClinicApp = { url: '', users, attempts: {}, close: async () => undefined };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://clinic.test');
    const who = cookie(req, 'clinic_user');
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    if (url.pathname === '/login' && req.method === 'GET') {
      // Signed in already: the clinic sends the user home (a second "Log in as" must sign out first).
      if (who && users[who] !== undefined) return send(302, '', { location: '/home' });
      return send(200, page('Sign in', `<h1>Pet clinic</h1><form method="post" action="/login">
        <label for="u">Username</label><input id="u" name="username">
        <label for="p">Password</label><input id="p" name="password" type="password">
        <button type="submit">Sign in</button></form>${url.searchParams.get('error') ? '<p role="alert">Wrong username or password</p>' : ''}`));
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const f = await body(req);
      app.attempts[f.username] = (app.attempts[f.username] ?? 0) + 1;
      if (users[f.username] !== undefined && users[f.username] === f.password) return send(302, '', { location: '/home', 'set-cookie': `clinic_user=${encodeURIComponent(f.username)}; Path=/; HttpOnly` });
      return send(302, '', { location: '/login?error=1' });
    }
    if (url.pathname === '/home') {
      if (!who || users[who] === undefined) return send(302, '', { location: '/login' });
      // The browser keeps who used it (localStorage): a sign-in that does not clear storage shows both users.
      return send(200, page('Home', `<h1>Signed in as ${who}</h1><p id="seen"></p>
        <script>
          const seen = (localStorage.getItem('clinic_seen') || '').split(',').filter(Boolean);
          if (!seen.includes(${JSON.stringify(who)})) seen.push(${JSON.stringify(who)});
          localStorage.setItem('clinic_seen', seen.join(','));
          document.getElementById('seen').textContent = 'Users seen here: ' + seen.join(',');
        </script>`));
    }
    if (url.pathname === '/noisy') {
      return send(200, page('Waiting room', `<h1>Waiting room</h1><script>
        console.error('ResizeObserver loop completed with undelivered notifications');
        console.error('chat-widget: tracking blocked');
        ${url.searchParams.get('real') ? "console.error('Appointment list failed to load');" : ''}
      </script>`));
    }
    send(404, page('Not found', '<h1>Not found</h1>'));
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      res.writeHead(500);
      res.end(e.message);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  app.url = `http://127.0.0.1:${addr.port}`;
  app.close = () => new Promise<void>((r) => server.close(() => r()));
  return app;
}

/** Seed an SQLite clinic database: owners, pets, visits and holidays. */
export function seedClinicDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE owners (owner_id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);
    CREATE TABLE pets (pet_id INTEGER PRIMARY KEY, name TEXT NOT NULL, species TEXT NOT NULL, owner_id INTEGER NOT NULL, state TEXT NOT NULL, weight_kg REAL);
    CREATE TABLE visits (visit_id TEXT PRIMARY KEY, pet_id INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE holidays (day TEXT PRIMARY KEY, name TEXT);
    INSERT INTO owners VALUES (1, 'Mira Okafor', 'Lyon'), (2, 'Tomas Berg', 'Oslo');
    INSERT INTO pets VALUES (10, 'Biscuit', 'dog', 1, 'healthy', 12.5), (11, 'Pepper', 'cat', 1, 'in-treatment', 4.1), (12, 'Juniper', 'rabbit', 2, 'healthy', 2.0);
    INSERT INTO visits VALUES ('V-OPEN-1', 12, 'check-up', 'open');
    INSERT INTO holidays VALUES ('2026-12-25', 'Christmas'), ('2026-12-28', 'Clinic closed'), ('2027-01-01', 'New year');
  `);
  db.close();
}

export const CLINIC_QUERIES: Record<string, string> = {
  OWNER_NAME: '-- connection: clinic\n-- params: owner_id\nSELECT name FROM owners WHERE owner_id = :owner_id',
  PET_BY_ID: '-- connection: clinic\n-- params: pet_id\nSELECT pet_id, name, species, state, weight_kg FROM pets WHERE pet_id = :pet_id',
  PET_ROW: '-- connection: clinic\n-- params: pet_id\nSELECT pet_id, name, state, weight_kg FROM pets WHERE pet_id = :pet_id',
  RESTORE_PET: '-- connection: clinic\n-- params: pet_id, name, state, weight_kg\nUPDATE pets SET name = :name, state = :state, weight_kg = :weight_kg WHERE pet_id = :pet_id',
  RENAME_PET: '-- connection: clinic\n-- params: pet_id, name\nUPDATE pets SET name = :name WHERE pet_id = :pet_id',
  INSERT_VISIT: '-- connection: clinic\n-- params: visit_id, pet_id, reason\nINSERT INTO visits (visit_id, pet_id, reason) VALUES (:visit_id, :pet_id, :reason)',
  DELETE_VISIT: '-- connection: clinic\n-- params: visit_id\nDELETE FROM visits WHERE visit_id = :visit_id',
  VISIT_COUNT: '-- connection: clinic\n-- params: pet_id\nSELECT COUNT(*) AS n FROM visits WHERE pet_id = :pet_id',
  VISIT_BY_ID: '-- connection: clinic\n-- params: visit_id\nSELECT visit_id, pet_id, reason FROM visits WHERE visit_id = :visit_id',
  ANY_OPEN_VISIT: "-- connection: clinic\nSELECT visit_id, pet_id FROM visits WHERE status = 'open' ORDER BY visit_id",
  FIND_PET_FOR_STATE: '-- connection: clinic\n-- params: state\nSELECT pet_id, name, species FROM pets WHERE state = :state ORDER BY pet_id',
  CLINIC_HOLIDAYS: '-- connection: clinic\nSELECT day FROM holidays ORDER BY day',
};

export interface ClinicProject {
  dir: string;
  db: string;
  /** Open the clinic database (close it after use). */
  open(): DatabaseSync;
  write(rel: string, text: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * A project folder: eztest.config.yaml (the given YAML after a base with the clinic connection), the query
 * catalogue, the seeded database and the given files.
 */
export async function clinicProject(config: string, files: Record<string, string> = {}, o: { appUrl?: string } = {}): Promise<ClinicProject> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-clinic-'));
  const db = join(dir, 'clinic.db');
  seedClinicDb(db);
  const write = async (rel: string, text: string) => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  };
  for (const [name, sql] of Object.entries(CLINIC_QUERIES)) await write(`queries/${name}.sql`, `${sql}\n`);
  await write('eztest.config.yaml', [
    `baseUrl: ${o.appUrl ?? 'http://127.0.0.1:9'}`,
    'browser: chromium',
    'headless: true',
    'journeysDir: journeys',
    'bddDir: features',
    'outputDir: eztest-results',
    'reporters: [json, html]',
    'timeouts:',
    '  step: 5000',
    'healing:',
    '  enabled: false',
    'db:',
    '  connections:',
    `    clinic: { driver: sqlite, file: ${JSON.stringify(db)} }`,
    '  queries:',
    '    dir: queries',
    config,
  ].join('\n'));
  for (const [rel, text] of Object.entries(files)) await write(rel, text);
  return {
    dir, db, write,
    open: () => new DatabaseSync(db),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
