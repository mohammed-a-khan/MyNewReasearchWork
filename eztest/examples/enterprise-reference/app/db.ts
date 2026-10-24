/**
 * The Larkspur Mutual database (node:sqlite, WAL mode so the test suite can
 * read and write the same file while the apps run). Schema and seed data are
 * invented for this reference system.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export type Row = Record<string, unknown>;

export const hashPassword = (pw: string): string => createHash('sha256').update(`larkspur:${pw}`).digest('hex');

/** Seeded users. Passwords and TOTP seeds are test-only values for this local reference system. */
export const SEED_USERS = {
  amelia: { id: 'C-1001', username: 'amelia.hart', password: 'Harbour#2026', totp: 'LARKSPURAMELIAMFAQXYZABC', email: 'amelia.hart@mail.larkspur.test' },
  rohan: { id: 'C-1002', username: 'rohan.mehta', password: 'Monsoon#2026', totp: 'LARKSPURROHANMFAQXYZABCD', email: 'rohan.mehta@mail.larkspur.test' },
  bramble: { id: 'C-1003', username: 'bramble.ops', password: 'Thicket#2026', totp: 'LARKSPURBRAMBLEMFAQXYZAB', email: 'ops@bramble-property.larkspur.test' },
};
export const SEED_STAFF = {
  adjuster: { username: 'dana.okafor', password: 'ClaimDesk#1', name: 'Dana Okafor', role: 'ADJUSTER', limit: 10_000 },
  senior: { username: 'victor.lindqvist', password: 'ClaimDesk#2', name: 'Victor Lindqvist', role: 'SENIOR', limit: 250_000 },
};
export const SEED_CLIENTS = {
  broker: { id: 'broker-gateway', secret: 'bg-s3cr3t-2026', scopes: 'claims:read claims:write quotes:write policies:read batch:run' },
  readonly: { id: 'reporting-readonly', secret: 'ro-s3cr3t-2026', scopes: 'claims:read policies:read' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
  username TEXT UNIQUE, password_hash TEXT, totp_secret TEXT,
  segment TEXT NOT NULL DEFAULT 'RETAIL', region TEXT NOT NULL, date_of_birth TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), product TEXT NOT NULL,
  status TEXT NOT NULL, sum_insured REAL NOT NULL, deductible REAL NOT NULL, region TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, annual_premium REAL NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, customer_id TEXT, channel TEXT NOT NULL, product TEXT NOT NULL, sum_insured REAL NOT NULL,
  region TEXT NOT NULL, risk_age INTEGER NOT NULL, no_claims_years INTEGER NOT NULL,
  base_premium REAL NOT NULL, loaded_premium REAL NOT NULL, discount REAL NOT NULL, net_premium REAL NOT NULL,
  tax REAL NOT NULL, total_premium REAL NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(id), customer_id TEXT NOT NULL,
  type TEXT NOT NULL, channel TEXT NOT NULL, incident_date TEXT NOT NULL, reported_at TEXT NOT NULL,
  description TEXT NOT NULL, amount_claimed REAL NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'NORMAL',
  late_notification INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, referred_to TEXT,
  decision_by TEXT, decision_at TEXT, decision_reason TEXT, approved_amount REAL, payout_amount REAL,
  settlement_code TEXT, settlement_token TEXT, settlement_accepted_at TEXT, bank_iban TEXT,
  external_ref TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS claims_customer ON claims(customer_id, status);
CREATE TABLE IF NOT EXISTS claim_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL REFERENCES claims(id), filename TEXT NOT NULL,
  content_type TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, uploaded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, claim_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT, channel TEXT NOT NULL, recipient TEXT NOT NULL,
  subject TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id), batch_id TEXT NOT NULL,
  amount REAL NOT NULL, iban TEXT NOT NULL, business_date TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batch_runs (
  id TEXT PRIMARY KEY, job TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, file_name TEXT, record_count INTEGER, total_amount REAL, error TEXT);
CREATE TABLE IF NOT EXISTS staff (
  username TEXT PRIMARY KEY, full_name TEXT NOT NULL, role TEXT NOT NULL, approval_limit REAL NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_clients (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, scopes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

/** Deterministic pseudo-random numbers for the seed (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ava', 'Noah', 'Isla', 'Leo', 'Maya', 'Omar', 'Zara', 'Ethan', 'Priya', 'Lucas', 'Chloe', 'Mateo', 'Freya', 'Kenji', 'Sofia', 'Ibrahim'];
const LAST = ['Okonkwo', 'Fischer', 'Tanaka', 'Moreau', 'Novak', 'Haddad', 'Silva', 'Kowalski', 'Larsen', 'Duarte', 'Brennan', 'Achebe', 'Varga', 'Castillo'];
export const REGIONS = ['NORTH', 'SOUTH', 'COAST', 'METRO'] as const;
const HOME_TYPES = ['WATER', 'FIRE', 'THEFT', 'STORM', 'GLASS'];
const MOTOR_TYPES = ['COLLISION', 'GLASS', 'THEFT'];

export function openDatabase(file: string, reset = false): DatabaseSync {
  if (reset) for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

export function nextId(db: DatabaseSync, name: string, start: number): number {
  db.prepare('INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name, start);
  return (db.prepare('SELECT value FROM sequences WHERE name = ?').get(name) as { value: number }).value;
}

function seed(db: DatabaseSync) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n > 0) return;
  const now = '2026-01-05T09:00:00.000Z';
  db.exec('BEGIN');
  const cust = db.prepare(
    'INSERT INTO customers (id, full_name, email, phone, username, password_hash, totp_secret, segment, region, date_of_birth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const pol = db.prepare(
    'INSERT INTO policies (id, customer_id, product, status, sum_insured, deductible, region, start_date, end_date, annual_premium) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const claim = db.prepare(
    `INSERT INTO claims (id, policy_id, customer_id, type, channel, incident_date, reported_at, description, amount_claimed, status, priority,
       decision_by, decision_at, decision_reason, approved_amount, payout_amount, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const { amelia, rohan, bramble } = SEED_USERS;
  cust.run(amelia.id, 'Amelia Hart', amelia.email, '+44 7700 900101', amelia.username, hashPassword(amelia.password), amelia.totp, 'RETAIL', 'COAST', '1986-04-17', now);
  cust.run(rohan.id, 'Rohan Mehta', rohan.email, '+44 7700 900102', rohan.username, hashPassword(rohan.password), rohan.totp, 'RETAIL', 'METRO', '2003-09-02', now);
  cust.run(bramble.id, 'Bramble Property Group', bramble.email, '+44 20 7946 0103', bramble.username, hashPassword(bramble.password), bramble.totp, 'COMMERCIAL', 'NORTH', null, now);
  pol.run('POL-H-100231', amelia.id, 'HOME', 'ACTIVE', 450_000, 500, 'COAST', '2026-01-01', '2026-12-31', 1512.0);
  pol.run('POL-M-200455', amelia.id, 'MOTOR', 'ACTIVE', 32_000, 750, 'COAST', '2026-03-01', '2027-02-28', 1176.0);
  pol.run('POL-M-200981', rohan.id, 'MOTOR', 'ACTIVE', 18_500, 1000, 'METRO', '2026-02-10', '2027-02-09', 1310.4);
  pol.run('POL-H-100877', rohan.id, 'HOME', 'LAPSED', 210_000, 500, 'METRO', '2025-01-01', '2025-12-31', 708.5);
  pol.run('POL-H-109000', bramble.id, 'HOME', 'ACTIVE', 4_800_000, 2500, 'NORTH', '2026-01-01', '2026-12-31', 13_440.0);

  // 200 synthetic retail customers with one policy each (for data-driven and search journeys)
  const rnd = prng(20260105);
  for (let i = 0; i < 200; i++) {
    const id = `C-${2000 + i}`;
    const region = REGIONS[Math.floor(rnd() * REGIONS.length)];
    const name = `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`;
    cust.run(id, name, `${id.toLowerCase()}@mail.larkspur.test`, null, null, null, null, 'DIRECT', region, `19${60 + Math.floor(rnd() * 40)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`, now);
    const home = rnd() < 0.6;
    const sum = home ? 150_000 + Math.floor(rnd() * 60) * 10_000 : 8_000 + Math.floor(rnd() * 40) * 1_000;
    pol.run(`POL-${home ? 'H' : 'M'}-${300000 + i}`, id, home ? 'HOME' : 'MOTOR', rnd() < 0.9 ? 'ACTIVE' : 'LAPSED', sum, home ? 500 : 750, region, '2026-01-01', '2026-12-31', Math.round(sum * (home ? 0.0032 : 0.041)));
  }

  // 420 historical claims on Bramble's commercial policy: the virtualized "My claims" grid
  const statuses = ['SETTLED', 'SETTLED', 'SETTLED', 'REJECTED', 'APPROVED', 'IN_REVIEW'];
  for (let i = 0; i < 420; i++) {
    const id = `CLM-${100000 + i}`;
    const type = HOME_TYPES[Math.floor(rnd() * HOME_TYPES.length)];
    const month = 1 + Math.floor(rnd() * 9);
    const day = 1 + Math.floor(rnd() * 27);
    const incident = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const amount = Math.round((200 + rnd() * 24_000) * 100) / 100;
    const status = statuses[Math.floor(rnd() * statuses.length)];
    const decided = status !== 'IN_REVIEW';
    const approved = status === 'REJECTED' || !decided ? null : Math.round(amount * (0.7 + rnd() * 0.3) * 100) / 100;
    claim.run(
      id, 'POL-H-109000', bramble.id, type, 'PORTAL', incident, `${incident}T10:00:00.000Z`, `${type.toLowerCase()} damage at site ${1 + (i % 37)}`,
      amount, status, amount > 10_000 ? 'HIGH' : 'NORMAL', decided ? SEED_STAFF.adjuster.username : null, decided ? `${incident}T16:00:00.000Z` : null,
      status === 'REJECTED' ? 'NOT_COVERED' : decided ? 'COVERED' : null, approved, approved === null ? null : Math.max(0, approved - 2500), `${incident}T16:00:00.000Z`,
    );
  }
  // Two motor claims for Rohan (one rejected: data for "previous claims" branching)
  claim.run('CLM-190001', 'POL-M-200981', rohan.id, 'GLASS', 'PHONE', '2026-04-02', '2026-04-03T08:30:00.000Z', 'windscreen chip', 240, 'SETTLED', 'NORMAL', SEED_STAFF.adjuster.username, '2026-04-04T12:00:00.000Z', 'COVERED', 240, 0, '2026-04-04T12:00:00.000Z');
  claim.run('CLM-190002', 'POL-M-200981', rohan.id, 'THEFT', 'PORTAL', '2026-06-11', '2026-06-12T09:00:00.000Z', 'stereo stolen', 1800, 'REJECTED', 'NORMAL', SEED_STAFF.adjuster.username, '2026-06-15T12:00:00.000Z', 'NOT_COVERED', null, null, '2026-06-15T12:00:00.000Z');

  const staff = db.prepare('INSERT INTO staff (username, full_name, role, approval_limit, password_hash) VALUES (?, ?, ?, ?, ?)');
  for (const s of Object.values(SEED_STAFF)) staff.run(s.username, s.name, s.role, s.limit, hashPassword(s.password));
  const client = db.prepare('INSERT INTO api_clients (id, secret_hash, scopes) VALUES (?, ?, ?)');
  for (const c of Object.values(SEED_CLIENTS)) client.run(c.id, hashPassword(c.secret), c.scopes);
  db.exec('COMMIT');
}
