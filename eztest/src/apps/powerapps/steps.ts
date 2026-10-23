/**
 * Power Apps canvas custom steps (`pa.*`). The app runs inside the player's
 * `fullscreen-app-host` iframe; controls are found by their control name
 * (`data-control-name`, the name makers give them: TextInput1, galAccounts).
 * Property values (Text, Default, Visible, DisplayMode, Selected, AllItems,
 * Value) are read through the app's object model, the binding contexts Power
 * Apps Test Engine reads (`AppMagic.Controls.GlobalContextManager
 * .bindingContext.controlContexts[name].modelProperties[prop].getValue()`),
 * read-only and in the app frame; when it is not there, from the DOM.
 * Results go to the `powerapps` ledger key.
 */
import type { FrameLocator, Locator, Page } from '../../browser/index.js';
import { EzTestError, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import type { CustomStepHandler, StepContext } from '../../runner/types.js';
import { AppPackError, argOpt, argStr, cssq, ledgerBag, looseEquals, normalizeLabel, optText, packEvidence, poll, reveal } from '../common/kit.js';
import { evaluatePowerFx, type FxValue } from './powerfx.js';

export interface PowerAppsCredentials { username: string; password: SecretInput }
export interface CanvasAppRef { name: string; url: string }
export interface PowerAppsStepsOptions {
  apps: CanvasAppRef[];
  credentials?: (role: string) => Promise<PowerAppsCredentials>;
  timeoutMs?: number;
  screenshots?: boolean;
}

export const POWERAPPS_STEP_NAMES = [
  'pa.login', 'pa.openApp', 'pa.setControl', 'pa.select', 'pa.selectItem', 'pa.expectProperty', 'pa.expectState', 'pa.expectGallery', 'pa.expectPowerFx', 'pa.expectNotification', 'pa.expectScreen',
] as const;
export type PowerAppsStepName = (typeof POWERAPPS_STEP_NAMES)[number];

export interface CanvasSnapshot { model: 'object-model' | 'dom'; activeScreen?: string; controls: Record<string, { type: string; props: Record<string, FxValue> }> }

interface Bag {
  user?: { role: string; username: string };
  app?: string;
  bridge?: CanvasSnapshot['model'];
  values: Record<string, unknown>;
  notifications: string[];
}
const KEY = 'powerapps';
const bag = (ctx: StepContext) => ledgerBag<Bag>(ctx, KEY, () => ({ values: {}, notifications: [] }));
const save = (ctx: StepContext, b: Bag) => ctx.ledger.set(KEY, b);
const S = (step: Step, ctx: StepContext, k: string, allowEmpty = false) => argStr(step, ctx, k, 'PA_BAD_STEP', allowEmpty);
export const APP_FRAME = 'iframe#fullscreen-app-host';

/** Read every control's properties in the app frame (object model first, DOM fallback). */
export async function canvasSnapshot(frame: FrameLocator): Promise<CanvasSnapshot> {
  return frame.locator('body').evaluate((body) => {
    type V = unknown;
    const w = window as unknown as { AppMagic?: { Controls?: { GlobalContextManager?: { bindingContext?: { controlContexts?: Record<string, { modelProperties?: Record<string, { getValue(): V }> }> } } }; AuthoringTool?: { Runtime?: { getActiveScreen?: () => string } } } };
    const cc = w.AppMagic?.Controls?.GlobalContextManager?.bindingContext?.controlContexts;
    const out: Record<string, { type: string; props: Record<string, V> }> = {};
    const typeOf = (name: string) => body.querySelector(`[data-control-name="${name}"]`)?.getAttribute('data-control-type') ?? '';
    if (cc && Object.keys(cc).length) {
      for (const [name, c] of Object.entries(cc)) {
        const props: Record<string, V> = {};
        for (const [p, m] of Object.entries(c.modelProperties ?? {})) {
          try {
            props[p] = m.getValue();
          } catch {
            props[p] = undefined;
          }
        }
        out[name] = { type: typeOf(name) || (name === 'App' ? 'App' : ''), props };
      }
      return { model: 'object-model' as const, activeScreen: w.AppMagic?.AuthoringTool?.Runtime?.getActiveScreen?.(), controls: out } as never;
    }
    // DOM fallback: what the player renders.
    let active: string | undefined;
    for (const el of Array.from(body.querySelectorAll('[data-control-name]'))) {
      const name = el.getAttribute('data-control-name')!;
      const type = el.getAttribute('data-control-type') ?? '';
      if (el.closest('[role="listitem"]')) continue;
      const shown = (el as HTMLElement).getClientRects().length > 0;
      if (type === 'Screen') {
        if (shown) active = name;
        continue;
      }
      const input = el.querySelector('input') as HTMLInputElement | null;
      const text = input ? input.value : (el.querySelector('.appmagic-label-text, .appmagic-button-label, .appmagic-dropdownLabelText, .appmagic-combobox-selected')?.textContent ?? '');
      const props: Record<string, V> = { Visible: shown, DisplayMode: el.querySelector('[aria-disabled="true"]') ? 'Disabled' : 'Edit', Text: text };
      const sw = el.querySelector('[role="switch"]');
      if (sw) props.Value = sw.getAttribute('aria-checked') === 'true';
      if (type === 'Dropdown' || type === 'ComboBox') props.Selected = { Value: text };
      if (type === 'Gallery') {
        props.AllItems = Array.from(el.querySelectorAll('[role="listitem"]')).map((it) => Object.fromEntries(Array.from(it.querySelectorAll('[data-control-name]')).map((c) => [c.getAttribute('data-control-name'), { Text: c.textContent?.trim() ?? '' }])));
        props.Items = props.AllItems;
      }
      out[name] = { type, props };
    }
    out.App = { type: 'App', props: { ActiveScreen: active } };
    return { model: 'dom' as const, activeScreen: active, controls: out } as never;
  }) as Promise<CanvasSnapshot>;
}

export async function powerAppsLogin(page: Page, url: string, username: string, password: string, t: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await page.goto(url, { timeout: t });
  if ((await page.locator('#playerHeader').count()) === 1) return { ok: true };
  await page.locator('#i0116').fill(username, { timeout: t });
  await page.locator('#idSIButton9').click({ timeout: t });
  const pwd = await poll(async () => ((await page.locator('#i0118').count()) ? true : (await page.locator('#usernameError').count()) ? false : undefined), t);
  if (!pwd) return { ok: false, error: (await page.locator('#usernameError').innerText().catch(() => 'no password page')).trim() };
  await page.locator('#i0118').fill(password, { timeout: t });
  await page.locator('#idSIButton9').click({ timeout: t });
  const kmsi = await poll(async () => ((await page.locator('#idBtn_Back').count()) ? true : (await page.locator('#usernameError').count()) ? false : undefined), t);
  if (!kmsi) return { ok: false, error: (await page.locator('#usernameError').innerText().catch(() => 'sign-in failed')).trim() };
  await page.locator('#idBtn_Back').click({ timeout: t });
  const ok = await poll(async () => ((await page.locator('#playerHeader').count()) ? true : undefined), t);
  return ok ? { ok: true } : { ok: false, error: 'no Power Apps player after sign-in' };
}

export function createPowerAppsSteps(opts: PowerAppsStepsOptions): Record<PowerAppsStepName, CustomStepHandler> {
  const ev = packEvidence('powerapps', opts.screenshots ?? true);
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;
  const frameOf = (page: Page) => page.frameLocator(APP_FRAME);

  async function ready(page: Page, t: number): Promise<FrameLocator> {
    if ((await page.locator(APP_FRAME).count()) !== 1) {
      const err = await optText(page.locator('.player-error'));
      throw new AppPackError(err ? `Power Apps: ${err.replace(/\s+/g, ' ').trim()}` : 'No canvas app is open (use "Open the Power Apps app ...")', 'PA_NO_APP');
    }
    const f = frameOf(page);
    await poll(async () => ((await f.locator('#loading').count()) === 0 && (await f.locator('[data-control-type="Screen"]').count()) > 0 ? true : undefined), t);
    return f;
  }

  /** The control on the active screen (not inside a gallery item). */
  async function control(page: Page, name: string, t: number): Promise<{ f: FrameLocator; el: Locator; type: string }> {
    const f = await ready(page, t);
    const el = f.locator(`[data-control-type="Screen"]:not([style*="display:none"]) [data-control-name="${cssq(name)}"]:not([role="listitem"] [data-control-name])`);
    const n = await poll(async () => ((await el.count()) > 0 ? await el.count() : undefined), Math.min(t, 3000));
    if (!n) {
      const snap = await canvasSnapshot(f);
      const names = Object.entries(snap.controls).filter(([, c]) => c.props.Visible !== false && c.type && c.type !== 'App').map(([k]) => k);
      throw new AppPackError(`No Power Apps control "${name}" on the screen ${snap.activeScreen ?? ''} (controls: ${names.join(', ')})`.replace(' ()', ''), 'PA_NO_CONTROL');
    }
    return { f, el: el.first(), type: (await el.first().getAttribute('data-control-type')) ?? '' };
  }

  async function props(page: Page, t: number): Promise<CanvasSnapshot> {
    return canvasSnapshot(await ready(page, t));
  }

  async function notifications(f: FrameLocator): Promise<string[]> {
    return (await f.locator('.appmagic-notification .appmagic-notification-message').allInnerTexts()).map((x) => x.trim());
  }

  const prop = (snap: CanvasSnapshot, name: string, p: string): FxValue => {
    const c = snap.controls[name];
    if (!c) throw new AppPackError(`No Power Apps control "${name}" (controls: ${Object.keys(snap.controls).join(', ')})`, 'PA_NO_CONTROL');
    const key = Object.keys(c.props).find((k) => k.toLowerCase() === p.toLowerCase());
    if (!key) throw new AppPackError(`Power Apps control "${name}" (${c.type}) has no readable property ${p} (properties: ${Object.keys(c.props).join(', ')})`, 'PA_NO_PROPERTY');
    return c.props[key];
  };
  const show = (v: FxValue): string => (v && typeof v === 'object' && !Array.isArray(v) && 'Value' in v ? String(v.Value) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));

  const handlers: Record<PowerAppsStepName, CustomStepHandler> = {
    'pa.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to Power Apps" needs powerapps.users', 'PA_CONFIG');
      const role = S(step, ctx, 'role');
      const cred = await opts.credentials(role);
      const app = opts.apps[0];
      if (!app) throw new EzTestError('powerapps.apps is empty', 'PA_CONFIG');
      const r = await powerAppsLogin(page, app.url, cred.username, (await reveal(cred.password)) ?? '', timeout(step));
      if (!r.ok) throw new AppPackError(`Power Apps sign-in as ${role} (${cred.username}) failed: ${r.error}`, 'PA_LOGIN_FAILED');
      const b = bag(ctx);
      b.user = { role, username: cred.username };
      save(ctx, b);
      await ev.json(ctx, step, 'login', b.user);
    },

    'pa.openApp': async (page, step, ctx) => {
      const name = S(step, ctx, 'app');
      const app = opts.apps.find((a) => normalizeLabel(a.name) === normalizeLabel(name));
      if (!app) throw new AppPackError(`Unknown canvas app "${name}" (powerapps.apps: ${opts.apps.map((a) => `"${a.name}"`).join(', ')})`, 'PA_UNKNOWN_APP');
      const t = timeout(step);
      await page.goto(app.url, { timeout: t });
      if ((await page.locator('#i0116').count()) === 1) throw new AppPackError('Not signed in to Power Apps (add "Log in to Power Apps as <role>" first)', 'PA_NOT_LOGGED_IN');
      const f = await ready(page, t);
      const snap = await canvasSnapshot(f);
      const b = bag(ctx);
      b.app = app.name;
      b.bridge = snap.model;
      save(ctx, b);
      await ev.json(ctx, step, 'app', { app: app.name, bridge: snap.model, screen: snap.activeScreen, controls: Object.keys(snap.controls) });
      await ev.screenshot(page, ctx, step, 'app');
    },

    'pa.setControl': async (page, step, ctx) => {
      const name = S(step, ctx, 'control');
      const value = S(step, ctx, 'value', true);
      const t = timeout(step);
      const { f, el, type } = await control(page, name, t);
      if ((await el.locator('[aria-disabled="true"]').count()) > 0) throw new AppPackError(`Power Apps control "${name}" is disabled (DisplayMode.Disabled)`, 'PA_DISABLED');
      if (type === 'TextInput' || type === 'DatePicker') await el.locator('input').first().fill(value, { timeout: t });
      else if (type === 'Toggle' || type === 'Checkbox') {
        const sw = el.locator('[role="switch"], [role="checkbox"]');
        if ((await sw.getAttribute('aria-checked')) === 'true' !== looseEquals(true, value)) await sw.click({ timeout: t });
      } else if (type === 'Dropdown' || type === 'ComboBox') {
        const search = el.locator('input');
        if (type === 'ComboBox' && (await search.count())) await search.fill(value, { timeout: t });
        else await el.locator('[role="combobox"]').click({ timeout: t });
        const items = f.locator('[role="listbox"] [role="option"]');
        const texts = (await poll(async () => ((await items.count()) ? items.allInnerTexts() : undefined), t)) ?? [];
        const i = texts.findIndex((x) => normalizeLabel(x) === normalizeLabel(value));
        if (i < 0) throw new AppPackError(`Power Apps ${type.toLowerCase()} "${name}" has no item "${value}" (items: ${texts.map((x) => x.trim()).join(', ') || 'none'})`, 'PA_NO_OPTION');
        await items.nth(i).click({ timeout: t });
      } else throw new AppPackError(`Power Apps control "${name}" is a ${type || 'control'}; it has no value to set`, 'PA_BAD_STEP');
      const snap = await props(page, t);
      const c = snap.controls[name]?.props ?? {};
      const readBack = show((c.Text ?? c.Value ?? c.Selected) as FxValue);
      const b = bag(ctx);
      b.values[name] = readBack;
      save(ctx, b);
      await ev.json(ctx, step, 'control', { control: name, type, value, readBack, bridge: snap.model });
    },

    'pa.select': async (page, step, ctx) => {
      const name = S(step, ctx, 'control');
      const t = timeout(step);
      const { el, type } = await control(page, name, t);
      if ((await el.locator('[aria-disabled="true"]').count()) > 0) throw new AppPackError(`Power Apps control "${name}" is disabled (DisplayMode.Disabled)`, 'PA_DISABLED');
      if (!(await el.isVisible())) throw new AppPackError(`Power Apps control "${name}" is not visible`, 'PA_HIDDEN');
      await (type === 'Button' ? el.locator('[role="button"]') : el).click({ timeout: t });
      await new Promise((r) => setTimeout(r, 50));
      const f = frameOf(page);
      const b = bag(ctx);
      b.notifications = await notifications(f);
      save(ctx, b);
    },

    'pa.selectItem': async (page, step, ctx) => {
      const gallery = S(step, ctx, 'gallery');
      const t = timeout(step);
      const { el } = await control(page, gallery, t);
      const items = el.locator('[role="listitem"]');
      const n = await items.count();
      let idx = typeof step.args?.index === 'number' ? Number(step.args.index) - 1 : -1;
      const where = step.args?.where as { control: string; value: string } | undefined;
      if (where) {
        const want = ctx.interpolate(where.value);
        const vals: string[] = [];
        for (let i = 0; i < n; i++) vals.push(await optText(items.nth(i).locator(`[data-control-name="${cssq(where.control)}"]`)));
        const hits = vals.map((v, i) => ({ v, i })).filter((x) => looseEquals(x.v, want));
        if (hits.length !== 1) throw new AppPackError(`${hits.length ? `${hits.length} items` : 'No item'} in gallery "${gallery}" where ${where.control} is "${want}" (${where.control}: ${vals.map((v) => `"${v}"`).join(', ') || 'no items'})`, hits.length ? 'PA_AMBIGUOUS' : 'PA_NOT_FOUND');
        idx = hits[0].i;
      }
      if (idx < 0 || idx >= n) throw new AppPackError(`Gallery "${gallery}" has ${n} items; there is no item ${idx + 1}`, 'PA_NOT_FOUND');
      await items.nth(idx).click({ timeout: t });
    },

    'pa.expectProperty': async (page, step, ctx) => {
      const name = S(step, ctx, 'control');
      const p = S(step, ctx, 'property');
      const want = S(step, ctx, 'value', true);
      const got = await poll(async () => {
        const v = prop(await props(page, timeout(step)), name, p);
        return looseEquals(show(v), want) ? v : undefined;
      }, Math.min(timeout(step), 3000));
      if (got === undefined) {
        const v = prop(await props(page, timeout(step)), name, p);
        throw new AppPackError(`Power Apps ${name}.${p} is "${show(v)}", expected "${want}"`, 'PA_ASSERT');
      }
    },

    'pa.expectState': async (page, step, ctx) => {
      const name = S(step, ctx, 'control');
      const want = S(step, ctx, 'state');
      const snap = await props(page, timeout(step));
      const c = snap.controls[name];
      const visible = !!c && c.props.Visible !== false;
      const actual = !visible ? 'hidden' : show(c.props.DisplayMode as FxValue) === 'Disabled' ? 'disabled' : show(c.props.DisplayMode as FxValue) === 'View' ? 'read-only' : 'visible';
      const ok = want === actual || (want === 'enabled' && actual === 'visible');
      if (!ok) throw new AppPackError(`Power Apps control "${name}" is ${actual} (Visible=${c ? String(c.props.Visible) : 'n/a'}, DisplayMode=${c ? show(c.props.DisplayMode as FxValue) : 'n/a'}), expected ${want}`, 'PA_ASSERT');
    },

    'pa.expectGallery': async (page, step, ctx) => {
      const gallery = S(step, ctx, 'gallery');
      const t = timeout(step);
      const count = step.args?.count;
      const value = argOpt(step, ctx, 'value');
      const check = async () => {
        const items = prop(await props(page, t), gallery, 'AllItems');
        const rows = Array.isArray(items) ? items : [];
        const texts = rows.map((r) => Object.values((r ?? {}) as Record<string, FxValue>).map((x) => (x && typeof x === 'object' && 'Text' in (x as object) ? String((x as { Text: unknown }).Text) : String(x ?? ''))).join(' '));
        return { rows, texts, ok: (typeof count !== 'number' || rows.length === count) && (value === undefined || texts.some((x) => x.toLowerCase().includes(value.toLowerCase()))) };
      };
      const r = (await poll(async () => {
        const x = await check();
        return x.ok ? x : undefined;
      }, Math.min(t, 3000))) ?? (await check());
      if (!r.ok) throw new AppPackError(`Power Apps gallery "${gallery}" has ${r.rows.length} items${value !== undefined ? ` and none contains "${value}"` : ''}${typeof count === 'number' ? `, expected ${count}` : ''}`, 'PA_ASSERT');
    },

    'pa.expectPowerFx': async (page, step, ctx) => {
      const expr = S(step, ctx, 'expression');
      const t = timeout(step);
      let last: FxValue;
      let snap: CanvasSnapshot | undefined;
      const ok = await poll(async () => {
        snap = await props(page, t);
        const scope = Object.fromEntries(Object.entries(snap.controls).map(([k, c]) => [k, c.props as Record<string, FxValue>]));
        last = evaluatePowerFx(expr, scope);
        return last === true ? true : undefined;
      }, Math.min(t, 3000));
      await ev.json(ctx, step, 'powerfx', { expression: expr, result: last, bridge: snap?.model });
      if (!ok) throw new AppPackError(`Power Fx ${expr} is ${JSON.stringify(last)}, expected true`, 'PA_ASSERT');
    },

    'pa.expectNotification': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const f = await ready(page, timeout(step));
      const got = await poll(async () => {
        const xs = await notifications(f);
        return xs.some((x) => x.toLowerCase().includes(text.toLowerCase())) ? xs : undefined;
      }, Math.min(timeout(step), 4000));
      if (!got) throw new AppPackError(`No Power Apps notification containing "${text}" (shown: ${(await notifications(f)).map((x) => `"${x}"`).join(', ') || 'none'})`, 'PA_ASSERT');
    },

    'pa.expectScreen': async (page, step, ctx) => {
      const want = S(step, ctx, 'screen');
      const got = await poll(async () => {
        const s = (await props(page, timeout(step))).activeScreen;
        return s && normalizeLabel(s) === normalizeLabel(want) ? s : undefined;
      }, Math.min(timeout(step), 3000));
      if (!got) throw new AppPackError(`The active Power Apps screen is "${(await props(page, timeout(step))).activeScreen}", expected "${want}"`, 'PA_ASSERT');
    },
  };
  return handlers;
}
