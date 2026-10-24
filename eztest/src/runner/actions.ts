/**
 * Action execution: one function per core ActionType. Missing handlers and
 * missing inputs are errors (never skips).
 */
import { unresolvedNames } from '../core/util.js';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import type { Locator } from '../browser/index.js';
import { DataNeed, EzTestError, NotSupportedError, sleep, type ActionType, type Step } from '../core/index.js';
import { createFetchApiHandler, resolveUrl } from './api.js';
import { safeName } from './evidence.js';
import type { DownloadRecord } from './ledger.js';
import type { RunOptions, StepContext } from './types.js';
import { advancedNeedsTarget, dbAction, performAdvancedAction, waitAction } from './advanced.js';
import { buildApiCall, finishApiResponse } from './data-steps.js';
import { dropFiles } from './inpage.js';
import { rememberApiRequest } from '../contracts/condition-rules.js';
import { normalizeModifiers, pressKey } from './input.js';
import { NEAR_FILE_INPUT } from './locate.js';
import { freshTotp } from '../identity/totp.js';

const MIME_BY_EXT: Record<string, string> = { '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xml': 'application/xml', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const mimeOf = (f: string) => MIME_BY_EXT[extname(f).toLowerCase()] ?? 'application/octet-stream';

/** Actions that act on a target element. */
export const TARGET_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'click', 'dblclick', 'fill', 'clear', 'select', 'check', 'uncheck', 'hover', 'upload', 'download', 'capture',
]);

/**
 * The file input an upload goes to. Apps hide the real `<input type=file>` behind a picture, a "+" button or a
 * drop area, so the step names what the person sees ("the profile picture"); the input is the one that element
 * holds, or the one in the nearest enclosing group. Several inputs there are ambiguous and fail.
 */
async function fileInputFor(target: Locator, step: Step): Promise<Locator> {
  const isFile = await target.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
  if (isFile) return target;
  const near = target.locator(NEAR_FILE_INPUT);
  const n = await near.count();
  if (n === 1) return near;
  throw new EzTestError(
    n === 0
      ? `Step "${step.intent}": ${step.target?.description ?? 'the target'} is not a file input and has none near it`
      : `Step "${step.intent}": ${n} file inputs are near ${step.target?.description ?? 'the target'}; name the one to use`,
    'UPLOAD_TARGET',
  );
}

/** True when this step needs its target resolved before acting. */
export function needsTarget(step: Step): boolean {
  if (step.action === 'wait' && step.args?.for !== undefined) {
    // Advanced waits resolve their own targets (e.g. "detached" must not require the element to exist).
    return step.target !== undefined && ['textChange', 'event', 'listen'].includes(String(step.args.for));
  }
  if (step.action === 'upload' && step.args?.mode === 'drop') return true;
  return TARGET_ACTIONS.has(step.action) || (step.target !== undefined && (step.action === 'press' || step.action === 'wait')) || advancedNeedsTarget(step);
}

export interface ActionOutcome {
  captured?: Record<string, unknown>;
  evidence?: string[];
  /** What the action itself verified (component steps read the widget back); used to accept heals. */
  verified?: { ok: boolean; message: string };
}

function requireValue(step: Step, ctx: StepContext): string {
  if (step.value === undefined) throw new EzTestError(`Step "${step.intent}" (${step.action}) needs a value`, 'MISSING_VALUE');
  // Never type, select or open a placeholder literally: "${password}" in the Password field logs in with the wrong
  // password and the failure looks like the app's ("Invalid credentials").
  const missing = unresolvedNames(step.value, ctx.vars());
  if (missing.length) throw missingVariables(missing);
  return ctx.interpolate(step.value);
}

/** A run-time value nobody supplied, with the three ways to supply it. */
export function missingVariables(names: string[]): EzTestError {
  const list = names.map((n) => `\${${n}}`).join(', ');
  const first = names[0];
  return new EzTestError(
    `${list} ${names.length > 1 ? 'have' : 'has'} no value, so EZTest did not use ${names.length > 1 ? 'them' : 'it'}. ` +
      `Supply ${names.length > 1 ? 'them' : 'it'} at run time: in Studio, the Run page's "Variables" fields; on the command line, ` +
      `eztest run --var ${first}=...; or once for the project, vars: { ${first}: secret://env/${first.toUpperCase().replace(/\W/g, '_')} } in eztest.config.yaml ` +
      `with that variable in .env (recorded passwords are never saved in journeys).`,
    'MISSING_VARIABLE',
    { names },
  );
}

function key(step: Step, fallback?: string): string {
  const k = step.captureAs ?? fallback;
  if (!k) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
  return k;
}

/** Perform a step's action. `loc` is the resolved target for target actions. */
export async function performAction(step: Step, loc: Locator | undefined, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  const { page } = ctx;
  const need = (): Locator => {
    if (!loc) throw new EzTestError(`Step "${step.intent}" (${step.action}) needs a target`, 'MISSING_TARGET');
    return loc;
  };
  switch (step.action) {
    case 'navigate': {
      const mode = step.args?.mode;
      if (mode === 'reload') await page.reload({ timeout });
      else if (mode === 'back') await page.goBack({ timeout });
      else if (mode === 'forward') await page.goForward({ timeout });
      else if (mode !== undefined) throw new NotSupportedError(`navigate mode "${String(mode)}"`);
      else await page.goto(resolveUrl(requireValue(step, ctx), ctx.baseUrl), { timeout });
      return {};
    }
    case 'click': {
      const button = step.args?.button;
      if (button !== undefined && button !== 'left' && button !== 'right' && button !== 'middle') throw new NotSupportedError(`click button "${String(button)}"`);
      const a = step.args ?? {};
      const extra = {
        ...(a.modifiers ? { modifiers: normalizeModifiers(a.modifiers) } : {}),
        ...(a.position ? { position: a.position as { x: number; y: number } } : {}),
        ...(a.clickCount ? { clickCount: Number(a.clickCount) } : {}),
        ...(a.force ? { force: true } : {}),
      };
      // "Click X and switch to the new tab": wait for the popup/tab the click opens and make it current.
      const since = a.newPage && ctx.session ? ctx.session.pages.lastNumber : undefined;
      const target = need();
      try {
        await target.click({ timeout, ...(button ? { button } : {}), ...extra });
      } catch (e) {
        // A button that closes its own window (OAuth/payment popups, "Send back") can close the page
        // before the driver finishes the click; the click happened, so this is not a failure.
        if (!target.page().isClosed()) throw e;
      }
      if (since !== undefined && ctx.session) {
        const entry = await ctx.session.pages.waitForNewPage(timeout, since);
        if (a.newPage !== 'wait') ctx.session.pages.activate(entry);
        await entry.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
      }
      return {};
    }
    case 'dblclick': await need().dblclick({ timeout }); return {};
    case 'fill': {
      if (step.args?.totp !== undefined) {
        // "Type the one-time code from ${totpSecret} into ...": a fresh TOTP code from the (base32) secret.
        const seedText = String(step.args.totp);
        const missing = unresolvedNames(seedText, ctx.vars());
        if (missing.length) throw missingVariables(missing);
        const seed = ctx.interpolate(seedText).trim();
        if (!seed || seed === seedText && /\$\{/.test(seedText)) throw new EzTestError(`Step "${step.intent}": no TOTP secret`, 'MISSING_VALUE');
        await need().fill(await freshTotp(seed), { timeout });
        return {};
      }
      await need().fill(requireValue(step, ctx), { timeout });
      return {};
    }
    case 'clear': await need().clear({ timeout }); return {};
    case 'select': await need().selectOption(requireValue(step, ctx), { timeout }); return {};
    case 'check': await need().check({ timeout }); return {};
    case 'uncheck': await need().uncheck({ timeout }); return {};
    case 'hover': await need().hover({ timeout }); return {};
    case 'press': {
      await pressKey(page, loc, requireValue(step, ctx), Number(step.args?.times ?? 1), timeout);
      return {};
    }
    case 'upload': {
      const base = opts.baseDir ?? process.cwd();
      const files = (Array.isArray(step.args?.files) ? (step.args.files as unknown[]).map(String) : [requireValue(step, ctx)])
        .map((f) => resolvePath(base, ctx.interpolate(f)));
      if (step.args?.mode === 'drop') {
        // Drag-to-upload: drop the files onto a drop zone as a user dragging from the desktop would.
        const payload = await Promise.all(files.map(async (f) => ({ name: basename(f), type: mimeOf(f), b64: (await readFile(f)).toString('base64') })));
        await need().evaluate(dropFiles, payload, { timeout });
        return {};
      }
      await (await fileInputFor(need(), step)).setInputFiles(files.length === 1 ? files[0] : files, { timeout });
      return {};
    }
    case 'download': {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout }), need().click({ timeout })]);
      const failure = await download.failure();
      if (failure) throw new EzTestError(`Download failed: ${failure}`, 'DOWNLOAD_FAILED');
      const filename = safeName(download.suggestedFilename());
      const relPath = ctx.evidence.reserve(`downloads/${safeName(ctx.journey.id)}/${safeName(step.id)}-${filename}`);
      const abs = join(ctx.runDir, relPath);
      await mkdir(join(ctx.runDir, 'downloads', safeName(ctx.journey.id)), { recursive: true });
      await download.saveAs(abs);
      const ref = await ctx.evidence.recordFile('download', abs, { journeyId: ctx.journey.id, stepId: step.id, description: `download ${filename}` });
      const rec: DownloadRecord = { path: abs, relPath: ref.path, filename, evidenceId: ref.id, sha256: ref.sha256, size: (await stat(abs)).size };
      const k = key(step, 'download');
      ctx.ledger.set(k, rec);
      return { captured: { [k]: rec }, evidence: [ref.id] };
    }
    case 'wait': {
      if (step.args?.for !== undefined) return waitAction(step, loc, ctx, opts, timeout);
      if (loc) {
        await loc.waitFor({ state: 'visible', timeout });
        return {};
      }
      if (step.value !== undefined) {
        const ms = Number(ctx.interpolate(step.value));
        if (!Number.isFinite(ms) || ms < 0) throw new EzTestError(`wait value must be milliseconds, got "${step.value}"`, 'BAD_WAIT');
        await sleep(ms);
        return {};
      }
      if (step.postconditions.length === 0) throw new EzTestError('wait needs a duration, a target or a condition', 'BAD_WAIT');
      return {};
    }
    case 'assert':
      if (step.postconditions.length === 0) throw new EzTestError('assert step has no post-conditions; nothing would be checked', 'EMPTY_ASSERT');
      return {};
    case 'capture': {
      const l = need();
      const mode = step.args?.mode ?? 'text';
      let v: string;
      if (mode === 'value') v = await l.inputValue({ timeout });
      else if (mode === 'text') v = (await l.innerText({ timeout })).replace(/\s+/g, ' ').trim();
      else throw new NotSupportedError(`capture mode "${String(mode)}"`);
      const k = key(step);
      ctx.ledger.set(k, v);
      return { captured: { [k]: v } };
    }
    case 'api': {
      const call = await buildApiCall(step, ctx, opts);
      const handler = opts.api ?? createFetchApiHandler({ authHeaders: opts.apiAuth, clientCertificates: opts.clientCertificates });
      const started = Date.now();
      const raw = await handler(call, ctx);
      const timing = Date.now() - started;
      const k = key(step, 'response');
      const mask = ctx.session?.mask ?? opts.mask ?? ((s: string) => s);
      // Same shape as the browser network log ({ entries }), so triage and EZTest Load's user-path generator can read API steps too.
      // Request headers are not recorded: they may carry credentials. Bodies are masked.
      const asText = (b: unknown) => (b === undefined ? undefined : typeof b === 'string' ? b : b instanceof FormData ? '[multipart form]' : b instanceof Uint8Array ? `[${b.length} bytes]` : JSON.stringify(b));
      const entry = {
        method: call.method, url: resolveUrl(call.url, ctx.baseUrl), status: raw.status, timing,
        requestBody: asText(call.body), responseHeaders: raw.headers, responseBody: asText(raw.body),
        journeyId: ctx.journey.id, stepId: step.id, asRole: call.asRole,
      };
      const ref = await ctx.evidence.store('network', `api/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`,
        mask(JSON.stringify({ entries: [entry] }, null, 2)),
        { journeyId: ctx.journey.id, stepId: step.id, description: `API ${call.method} ${call.url}` });
      const res = finishApiResponse(step, raw, timing);
      ctx.ledger.set(k, res);
      // Contract checks (api.spec) and contract recording see every exchange; a contract break fails the step here.
      const ct = Object.entries(call.headers ?? {}).find(([h]) => h.toLowerCase() === 'content-type')?.[1];
      rememberApiRequest(res, { method: call.method, url: entry.url, requestBody: call.body instanceof FormData ? undefined : call.body, ...(ct ? { requestContentType: ct } : {}), requestHeaders: call.headers });
      const hookEvidence = opts.apiHook ? ((await opts.apiHook({ call, url: entry.url, response: res, step }, ctx)) ?? []) : [];
      const hasStatusCheck = step.postconditions.some((c) => c.type === 'apiStatus');
      if (!hasStatusCheck && step.args?.allowErrors !== true && res.status >= 400) throw new EzTestError(`API ${call.method} ${call.url} returned ${res.status}`, 'API_STATUS');
      return { captured: { [k]: res }, evidence: [ref.id, ...hookEvidence] };
    }
    case 'db': {
      // ${var} in SQL becomes a bound parameter, never spliced text.
      return dbAction(step, ctx, opts);
    }
    case 'login': {
      if (!opts.login) throw new EzTestError('No login handler configured (RunOptions.login)', 'NO_HANDLER');
      const role = step.value !== undefined ? ctx.interpolate(step.value) : ctx.journey.role;
      if (!role) throw new EzTestError('login step has no role and the journey has no role', 'MISSING_VALUE');
      await opts.login(page, role, ctx);
      return {};
    }
    case 'useData': {
      if (!opts.data) throw new EzTestError('No data handler configured (RunOptions.data)', 'NO_HANDLER');
      const a = step.args ?? {};
      const alias = typeof a.as === 'string' ? a.as : undefined;
      if (!alias) throw new EzTestError('useData step needs args.as', 'MISSING_VALUE');
      const declared = ctx.journey.data.find((d) => d.as === alias);
      const needData = declared ?? DataNeed.parse({ entity: a.entity, as: alias, where: a.where ?? {} });
      const record = await opts.data(needData, ctx);
      ctx.ledger.set(alias, record);
      return { captured: { [alias]: record } };
    }
    case 'compareDocument': {
      if (!opts.compareDocument) throw new EzTestError('No compareDocument handler configured (RunOptions.compareDocument)', 'NO_HANDLER');
      const args = Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? ctx.interpolate(v) : v]));
      const r = await opts.compareDocument(args, ctx);
      const k = step.captureAs;
      if (k) ctx.ledger.set(k, r.details);
      const ref = await ctx.evidence.store('data', `compare/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(r, null, 2),
        { journeyId: ctx.journey.id, stepId: step.id, description: 'document comparison' });
      if (!r.passed) throw new EzTestError('Document comparison failed', 'COMPARE_FAILED', { details: r.details });
      return { captured: k ? { [k]: r.details } : undefined, evidence: [ref.id] };
    }
    case 'custom': {
      const name = step.handler;
      if (!name) throw new EzTestError('custom step needs a handler name', 'MISSING_VALUE');
      const h = opts.customSteps?.[name];
      if (!h) throw new EzTestError(`No custom step handler "${name}" registered`, 'NO_HANDLER');
      const out = await h(page, step, ctx);
      if (out) for (const [k, v] of Object.entries(out)) ctx.ledger.set(k, v);
      return out ? { captured: out } : {};
    }
    default:
      return performAdvancedAction(step, loc, ctx, opts, timeout);
  }
}

/**
 * Checks implied by the action itself, used to verify heals (a healed fill
 * must have put the value into the healed field). Undefined: nothing implied.
 */
export async function implicitCheck(step: Step, loc: Locator, ctx: StepContext, outcome: ActionOutcome): Promise<{ ok: boolean; message: string } | undefined> {
  switch (step.action) {
    case 'fill': {
      const want = ctx.interpolate(step.value ?? '');
      const v = await loc.inputValue({ timeout: 2000 }).catch(() => undefined);
      return { ok: v === want, message: v === want ? 'field holds the typed value' : 'field does not hold the typed value' };
    }
    case 'clear': {
      const v = await loc.inputValue({ timeout: 2000 }).catch(() => undefined);
      return { ok: v === '', message: v === '' ? 'field is empty' : 'field is not empty' };
    }
    case 'select': {
      const want = ctx.interpolate(step.value ?? '');
      const sel = await loc
        .evaluate((el) => (el instanceof HTMLSelectElement ? Array.from(el.selectedOptions).flatMap((o) => [o.value, o.label]) : []), undefined, { timeout: 2000 })
        .catch(() => [] as string[]);
      const ok = sel.includes(want);
      return { ok, message: ok ? 'option selected' : `option "${want}" is not selected` };
    }
    case 'check':
    case 'uncheck': {
      const c = await loc.isChecked({ timeout: 2000 }).catch(() => undefined);
      const ok = c === (step.action === 'check');
      return { ok, message: ok ? `element is ${step.action === 'check' ? 'checked' : 'unchecked'}` : 'checked state did not change' };
    }
    case 'capture': {
      const v = outcome.captured ? Object.values(outcome.captured)[0] : undefined;
      const ok = typeof v === 'string' && v.length > 0;
      return { ok, message: ok ? 'captured a value' : 'captured an empty value' };
    }
    case 'download':
      return { ok: !!outcome.captured, message: 'file downloaded' };
    case 'keyboard': {
      if ((step.args?.op ?? 'type') !== 'type') return undefined;
      const want = ctx.interpolate(step.value ?? '');
      const v = await loc.inputValue({ timeout: 2000 }).catch(() => undefined);
      const ok = v !== undefined && v.includes(want);
      return { ok, message: ok ? 'field holds the typed text' : 'field does not hold the typed text' };
    }
    case 'component':
      return outcome.verified;
    case 'query': {
      const v = outcome.captured ? Object.values(outcome.captured)[0] : undefined;
      const ok = v !== undefined && v !== null && v !== '';
      return { ok, message: ok ? 'query returned a value' : 'query returned nothing' };
    }
    case 'upload': {
      const n = await loc.evaluate((el) => (el instanceof HTMLInputElement && el.files ? el.files.length : 0), undefined, { timeout: 2000 }).catch(() => 0);
      return { ok: n > 0, message: n > 0 ? 'file attached' : 'no file attached' };
    }
    default:
      return undefined;
  }
}

