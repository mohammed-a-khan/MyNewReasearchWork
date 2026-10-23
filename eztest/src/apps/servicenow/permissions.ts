/**
 * ServiceNow role matrix: per user, table and field access as the Table API
 * reports it when called AS that user (403 = no read ACL; a field missing
 * from the response = no field read ACL), and optionally what the UI16 form
 * shows that user (no form, read-only, editable; UI action present or not).
 * The Table API cannot show write access without writing, so "write"
 * expectations are checked as "read" on the API side and as "write" on the UI.
 */
import type { Page } from '../../browser/index.js';
import { AppApiError } from '../common/http.js';
import { cssq } from '../common/kit.js';
import { runMatrix, type MatrixReport, type PermissionCheckBase, type ProbeResult } from '../common/permissions.js';
import type { ServiceNowClient } from './client.js';

export interface ServiceNowPermissionCheck extends PermissionCheckBase {
  table: string;
  /** Field element or label. */
  field?: string;
  /** UI action label (expect visible | hidden). */
  uiAction?: string;
  /** write | read | none (tables, fields); visible | hidden (UI actions). */
  expect: string | Record<string, string>;
}

export interface ServiceNowPermissionUi {
  /** A page already logged in as each user. */
  pages: Record<string, Page>;
  instanceUrl: string;
  timeoutMs?: number;
}

const ORDER = ['none', 'read', 'write'];

export async function serviceNowPermissionMatrix(o: {
  users: Record<string, ServiceNowClient>;
  /** Integration client (to resolve labels and find a sample record). */
  admin: ServiceNowClient;
  checks: ServiceNowPermissionCheck[];
  ui?: ServiceNowPermissionUi;
}): Promise<MatrixReport> {
  const t = o.ui?.timeoutMs ?? 10_000;
  const root = o.ui?.instanceUrl.replace(/\/+$/, '');
  return runMatrix<ServiceNowPermissionCheck>({
    pack: 'servicenow',
    users: Object.keys(o.users),
    checks: o.checks,
    order: [...ORDER, 'hidden', 'visible'],
    subject: (c) => (c.uiAction ? `${c.table} UI action "${c.uiAction}"` : c.field ? `${c.table}.${c.field}` : `table:${c.table}`),
    apiLevel: (e, c) => (c.uiAction ? e : e === 'write' ? 'read' : e),
    probe: async (user, c): Promise<ProbeResult> => {
      const client = o.users[user];
      const table = (await o.admin.resolveTable(c.table)).name;
      const field = c.field ? await o.admin.resolveField(table, c.field) : undefined;
      const r: ProbeResult = {};
      if (!c.uiAction) {
        try {
          const rows = await client.query(table, { fields: ['sys_id', ...(field ? [field.element] : [])], limit: 1 });
          r.api = field ? (rows.length === 0 ? 'read' : field.element in rows[0] ? 'read' : 'none') : 'read';
          if (field && rows.length === 0) r.detail = 'no record visible to this user; field read ACL not observable via API';
        } catch (e) {
          if (e instanceof AppApiError && e.status === 403) r.api = 'none';
          else throw e;
        }
      }
      const page = o.ui?.pages[user];
      if (page && root) {
        if (c.uiAction) {
          const sample = await o.admin.query(table, { fields: ['sys_id'], query: 'active=true', limit: 1 });
          const id = String(sample[0]?.sys_id ?? '-1');
          await page.goto(`${root}/${table}.do?sys_id=${id}`, { timeout: t });
          const labels = (await page.locator('#ui_actions button.form_action_button').allInnerTexts()).map((s) => s.trim().toLowerCase());
          r.ui = labels.includes(c.uiAction.toLowerCase()) ? 'visible' : 'hidden';
        } else {
          await page.goto(`${root}/${table}.do?sys_id=-1`, { timeout: t });
          const form = (await page.locator(`form[id="${cssq(table)}.do"]`).count()) === 1;
          if (!form) r.ui = 'none';
          else if (!field) r.ui = (await page.locator('#sysverb_insert').count()) === 1 ? 'write' : 'read';
          else {
            const box = page.locator(`[id="element.${cssq(table)}.${cssq(field.element)}"]`);
            if (!(await box.count())) r.ui = 'none';
            else {
              const ro = await box.locator('select, input:not([type="hidden"]), textarea').first().evaluate((e) => e.hasAttribute('readonly') || e.hasAttribute('disabled'));
              r.ui = ro ? 'read' : 'write';
            }
          }
        }
      }
      return r;
    },
  });
}
