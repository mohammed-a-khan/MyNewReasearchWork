/**
 * Permission matrix: for each user (a REST client authenticated AS that
 * user) and each check (object, field or tab), compare the expected access
 * with what Salesforce reports — describe-as-user for objects/fields, the
 * tabs resource for tabs — and optionally with what the Lightning UI shows
 * to that user. Every disagreement is a violation with evidence.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '../browser/index.js';
import { EzTestError, nowIso } from '../core/index.js';
import { safeName } from '../runner/evidence.js';
import { SalesforceApiError, type SalesforceClient } from './client.js';
import {
  closeAppLauncher, isReadOnlyInModal, layoutItem, navTabs, openModal, poll, searchAppLauncher, waitForModal, SalesforceUiError,
} from './lightning.js';
import { assertApiName, SalesforceMetadataError, StaticDescribeSource, type SObjectDescribe } from './metadata.js';
import { SalesforceFieldResolver, normalizeLabel, suggestLabels } from './resolver.js';

export type AccessLevel = 'edit' | 'read' | 'hidden' | 'visible';

export interface PermissionCheck {
  /** sObject API name (e.g. Account). */
  object: string;
  /** Field API name or label. */
  field?: string;
  /** Tab label (e.g. "Cases"); object/field are then ignored for the API check except to identify the tab. */
  tab?: string;
  /** edit | read | hidden for objects/fields; visible | hidden for tabs. */
  expect: AccessLevel;
  /** Users this check applies to (default: all). */
  users?: string[];
}

export interface PermissionUiOptions {
  /** A browser page already signed in as each user (e.g. via loginWithPassword). */
  pages: Record<string, Page>;
  /** Lightning root URL. */
  appUrl: string;
  timeoutMs?: number;
  /** Write a screenshot per UI violation here. */
  screenshotDir?: string;
}

export interface PermissionMatrixOptions {
  /** Role -> REST client authenticated as that user. */
  users: Record<string, SalesforceClient>;
  checks: PermissionCheck[];
  ui?: PermissionUiOptions;
}

export interface PermissionResult {
  user: string;
  subject: string;
  check: PermissionCheck;
  expected: AccessLevel;
  /** What the REST API reports for this user. */
  api: AccessLevel;
  /** What the Lightning UI shows this user (when UI checking is enabled). */
  ui?: AccessLevel;
  passed: boolean;
  evidence: Record<string, unknown>;
}

export interface PermissionReport {
  schema: 'eztest.salesforce.permissions/v1';
  generatedAt: string;
  users: string[];
  results: PermissionResult[];
  violations: PermissionResult[];
  passed: boolean;
}

const FIELD_LEVELS: AccessLevel[] = ['edit', 'read', 'hidden'];
const TAB_LEVELS: AccessLevel[] = ['visible', 'hidden'];

function subjectOf(c: PermissionCheck, field?: string): string {
  if (c.tab) return `tab:${c.tab}`;
  return field ? `${c.object}.${field}` : `object:${c.object}`;
}

/** Validate the matrix input up front: nothing passes on empty or malformed input. */
function validate(o: PermissionMatrixOptions): void {
  const users = Object.keys(o?.users ?? {});
  if (!users.length) throw new EzTestError('runPermissionMatrix: no users given', 'INVALID_INPUT');
  if (!Array.isArray(o.checks) || !o.checks.length) throw new EzTestError('runPermissionMatrix: no checks given', 'INVALID_INPUT');
  o.checks.forEach((c, i) => {
    const where = `check ${i + 1}`;
    if (!c || typeof c !== 'object') throw new EzTestError(`runPermissionMatrix: ${where} is not an object`, 'INVALID_INPUT');
    assertApiName(c.object, `${where} object`);
    const levels = c.tab ? TAB_LEVELS : FIELD_LEVELS;
    if (!levels.includes(c.expect)) throw new EzTestError(`runPermissionMatrix: ${where} expects "${String(c.expect)}" (use ${levels.join(' | ')}${c.tab ? ' for tabs' : ''})`, 'INVALID_INPUT');
    if (c.tab !== undefined && !c.tab.trim()) throw new EzTestError(`runPermissionMatrix: ${where} has an empty tab`, 'INVALID_INPUT');
    if (c.field !== undefined && !c.field.trim()) throw new EzTestError(`runPermissionMatrix: ${where} has an empty field`, 'INVALID_INPUT');
    for (const u of c.users ?? []) if (!users.includes(u)) throw new EzTestError(`runPermissionMatrix: ${where} names unknown user "${u}" (users: ${users.join(', ')})`, 'INVALID_INPUT');
  });
}

async function describeOrHidden(client: SalesforceClient, object: string): Promise<SObjectDescribe | undefined> {
  try {
    return await client.describe(object);
  } catch (e) {
    if (e instanceof SalesforceMetadataError && e.code === 'SF_UNKNOWN_OBJECT') return undefined;
    if (e instanceof SalesforceApiError && (e.status === 404 || e.status === 403)) return undefined;
    throw e;
  }
}

/**
 * Run the permission matrix. Field names/labels are resolved against the
 * union of what all users can see, so a typo is an error (with suggestions)
 * instead of silently reading as "hidden".
 */
export async function runPermissionMatrix(o: PermissionMatrixOptions): Promise<PermissionReport> {
  validate(o);
  const users = Object.keys(o.users);
  const describes = new Map<string, Map<string, SObjectDescribe | undefined>>();
  const describeAs = async (user: string, object: string) => {
    let m = describes.get(user);
    if (!m) describes.set(user, (m = new Map()));
    const k = object.toLowerCase();
    if (!m.has(k)) m.set(k, await describeOrHidden(o.users[user], object));
    return m.get(k);
  };

  // Canonical field API names from the union of all users' describes.
  const fieldName = new Map<string, string>();
  for (const c of o.checks) {
    if (!c.field || c.tab) continue;
    const seen: SObjectDescribe[] = [];
    for (const u of users) {
      const d = await describeAs(u, c.object);
      if (d) seen.push(d);
    }
    if (!seen.length) throw new EzTestError(`runPermissionMatrix: no user can see sObject ${c.object}; cannot resolve field "${c.field}"`, 'INVALID_INPUT');
    const want = normalizeLabel(c.field);
    const hit = seen.flatMap((d) => d.fields).find((f) => f.name.toLowerCase() === c.field!.toLowerCase() || normalizeLabel(f.label) === want);
    if (!hit) {
      const s = suggestLabels(c.field, [...new Set(seen.flatMap((d) => d.fields.map((f) => f.label)))]);
      throw new EzTestError(`runPermissionMatrix: field "${c.field}" not found on ${c.object} for any user${s.length ? `. Did you mean ${s.map((x) => `"${x}"`).join(', ')}?` : ''}`, 'INVALID_INPUT');
    }
    fieldName.set(`${c.object}|${c.field}`, hit.name);
  }

  const results: PermissionResult[] = [];
  for (const c of o.checks) {
    const field = c.field && !c.tab ? fieldName.get(`${c.object}|${c.field}`) : undefined;
    for (const user of c.users ?? users) {
      const client = o.users[user];
      const evidence: Record<string, unknown> = { source: c.tab ? 'tabs' : 'describe' };
      let api: AccessLevel;
      if (c.tab) {
        const tabs = await client.tabs();
        const hit = tabs.find((t) => normalizeLabel(t.label) === normalizeLabel(c.tab!) || t.sobjectName === c.object);
        api = hit ? 'visible' : 'hidden';
        evidence.tabs = tabs.map((t) => t.label);
      } else {
        const d = await describeAs(user, c.object);
        if (!d) {
          api = 'hidden';
          evidence.object = { name: c.object, accessible: false };
        } else if (field) {
          const f = d.fields.find((x) => x.name === field);
          api = !f ? 'hidden' : f.updateable || f.createable ? 'edit' : 'read';
          evidence.field = f ? { name: f.name, label: f.label, type: f.type, createable: f.createable, updateable: f.updateable } : { name: field, visible: false };
        } else {
          api = d.createable || d.updateable ? 'edit' : 'read';
          evidence.object = { name: d.name, createable: d.createable, updateable: d.updateable, deletable: d.deletable };
        }
      }
      const r: PermissionResult = { user, subject: subjectOf(c, field), check: c, expected: c.expect, api, passed: api === c.expect, evidence };
      const page = o.ui?.pages[user];
      if (page && o.ui) {
        r.ui = await uiAccess(page, o.ui, c, field, o.users[user]);
        evidence.uiObservedAt = page.url();
        if (r.ui !== c.expect) r.passed = false;
        if (!r.passed && o.ui.screenshotDir) {
          await mkdir(o.ui.screenshotDir, { recursive: true });
          const file = join(o.ui.screenshotDir, `${safeName(user)}-${safeName(r.subject)}.png`);
          await writeFile(file, await page.screenshot({ fullPage: true }));
          evidence.screenshot = file;
        }
      }
      results.push(r);
    }
  }
  const violations = results.filter((r) => !r.passed);
  return { schema: 'eztest.salesforce.permissions/v1', generatedAt: nowIso(), users, results, violations, passed: violations.length === 0 };
}

async function uiAccess(page: Page, ui: PermissionUiOptions, c: PermissionCheck, field: string | undefined, client: SalesforceClient): Promise<AccessLevel> {
  const t = ui.timeoutMs ?? 10_000;
  const root = ui.appUrl.replace(/\/+$/, '');
  const errorShown = async () => (await page.locator('.slds-illustration[role="alert"]').count()) > 0;
  if (c.tab) {
    if (!/^https?:/.test(page.url()) || !new URL(page.url()).pathname.startsWith('/lightning/')) await page.goto(`${root}/lightning/page/home`, { timeout: t });
    const inNav = (await navTabs(page)).some((l) => normalizeLabel(l) === normalizeLabel(c.tab!));
    const { labels } = await searchAppLauncher(page, c.tab, t);
    await closeAppLauncher(page);
    return inNav || labels.some((l) => normalizeLabel(l) === normalizeLabel(c.tab!)) ? 'visible' : 'hidden';
  }
  if (!field) {
    await page.goto(`${root}/lightning/o/${c.object}/list`, { timeout: t });
    if (await errorShown()) return 'hidden';
    const btn = page.locator('lst-list-view-manager-header a[title="New"]');
    const state = await poll(async () => ((await btn.count()) ? 'edit' : (await page.locator('lightning-datatable').count()) ? 'read' : undefined), t);
    return state ?? 'hidden';
  }
  // Field: inspect the create form the user gets.
  await page.goto(`${root}/lightning/o/${c.object}/new`, { timeout: t });
  if (await errorShown()) return 'hidden';
  const modal = await waitForModal(page, t);
  const d = await describeOrHidden(client, c.object);
  // The user's describe lacks hidden fields: resolve against a minimal static describe of the field.
  const meta = d?.fields.find((f) => f.name === field);
  if (!meta) {
    const item = modal.locator(`records-record-layout-item[data-target-selection-name="sfdc:RecordField.${c.object}.${field}"]`);
    return (await item.count()) ? 'read' : 'hidden';
  }
  const src = new StaticDescribeSource({ schema: 'eztest.salesforce.describe/v1', takenAt: nowIso(), objects: { [d!.name]: d! } });
  const f = await new SalesforceFieldResolver(src).resolveField(d!.name, field);
  try {
    const item = await layoutItem({ root: modal, page, field: f, timeoutMs: Math.min(t, 2000), dateFormat: 'M/d/yyyy' });
    return (await isReadOnlyInModal(item, f)) ? 'read' : 'edit';
  } catch (e) {
    if (e instanceof SalesforceUiError && e.code === 'SF_NOT_FOUND') return 'hidden';
    throw e;
  } finally {
    if (await openModal(page)) await page.goto(`${root}/lightning/page/home`, { timeout: t });
  }
}
