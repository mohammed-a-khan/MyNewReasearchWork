/**
 * Failure diagnosis: everything needed to understand a failed step from the
 * step result alone.
 *  - what was expected and what was found,
 *  - every locator candidate with how many elements it matched,
 *  - the nearest similar elements on the page ("did you mean"),
 *  - a screenshot with the matches (or the nearest element) outlined,
 *  - console errors and failed network calls during the step.
 * Read-only on the page except for a temporary outline drawn for the screenshot.
 */
import type { Locator, Page } from '../../browser/index.js';
import type { CandidateDiagnosis, Condition, ConditionResult, ElementFingerprint, FailureDiagnosis, SimilarElement, Step, Target } from '../../core/index.js';
import { poolSelector, robustCandidates, scanElements, scoreFingerprint, textSimilarity } from '../../heal/index.js';
import { describeCandidate, interpolateCandidate, rootFor, toLocator } from '../locate.js';
import type { StepContext } from '../types.js';


export interface DiagnoseInput {
  step: Step;
  ctx: StepContext;
  error: string;
  conditions: ConditionResult[];
  /** Console entries of the attempt (type, text, ISO time). */
  console: Array<{ type: string; text: string; at: string; ignored?: boolean }>;
  /** Network entries of the attempt (with the step id they happened in). */
  network: Array<{ method: string; url: string; status?: number; failure?: string; stepId?: string; resourceType?: string }>;
  /** When the step started (ms epoch). */
  since: number;
  /** Stored fingerprint of the target from the last good run. */
  fingerprint?: ElementFingerprint;
  /** Outline the matches / nearest element for the failure screenshot (default true). */
  outline?: boolean;
}

const MAX_SCAN = 400;

function condTarget(c: Condition): Target | undefined {
  return 'target' in c ? (c as { target: Target }).target : undefined;
}

function expectedOf(c: Condition): string {
  const o = c as Record<string, unknown>;
  const what = condTarget(c)?.description;
  const val = o.value ?? o.pattern ?? o.expected ?? o.equals ?? o.status ?? o.state;
  return `${c.type}${what ? ` of ${what}` : ''}${val !== undefined ? ` = ${JSON.stringify(val)}` : ''}`;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
}

/** Candidates of a target with their current match counts. */
export async function candidateCounts(page: Page, ctx: StepContext, target: Target): Promise<CandidateDiagnosis[]> {
  const root = rootFor(page, [...(ctx.session?.frames ?? []), ...(target.frames ?? [])]);
  const out: CandidateDiagnosis[] = [];
  for (const raw of target.locators) {
    const c = interpolateCandidate(raw, ctx.vars());
    try {
      out.push({ locator: describeCandidate(c), matches: await toLocator(root, c).count() });
    } catch (e) {
      out.push({ locator: describeCandidate(c), matches: -1, error: (e as Error).message.split('\n')[0] });
    }
  }
  return out;
}

function words(description: string): string {
  return description.replace(/^the\s+/i, '').replace(/["“”]/g, '').replace(/\b(?:button|link|field|input|box|dropdown|checkbox|tab|menu|item|icon)\b/gi, '').trim();
}

/** The nearest elements to a target on the page, best first. */
export async function similarElements(page: Page, ctx: StepContext, step: Step, target: Target, fingerprint?: ElementFingerprint, limit = 3): Promise<Array<SimilarElement & { index: number; pool: string }>> {
  const root = rootFor(page, [...(ctx.session?.frames ?? []), ...(target.frames ?? [])]);
  const role = fingerprint?.role ?? target.locators.find((c) => c.strategy === 'role')?.value;
  const pool = poolSelector({ role, action: step.action }) ?? 'a[href], button, input, select, textarea, [role], label, h1, h2, h3, [data-testid]';
  const loc = root.locator(pool);
  const scanned = (await scanElements(loc).catch(() => [])).slice(0, MAX_SCAN);
  const want = words(target.description);
  const names = target.locators.map((c) => c.name ?? c.value).filter((x) => x && !/^[/(#.[]/.test(x));
  const ranked = scanned
    .map((s, index) => {
      const fp = s.fingerprint;
      const texts = [fp.name, fp.label, fp.text, fp.placeholder, fp.testId, fp.id].filter((x): x is string => !!x);
      let score = Math.max(0, ...texts.map((t) => Math.max(textSimilarity(want, t), ...names.map((n) => textSimilarity(n, t)))));
      if (fingerprint) score = Math.max(score, scoreFingerprint(fingerprint, fp).score);
      if (!s.visible) score *= 0.5;
      return { s, index, score };
    })
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked.map(({ s, index, score }) => {
    const c = robustCandidates(s.fingerprint)[0];
    const fp = s.fingerprint;
    const label = fp.name ?? fp.label ?? fp.text ?? fp.placeholder ?? fp.testId ?? fp.id ?? fp.tag ?? 'element';
    return {
      locator: c ? describeCandidate(c) : `css=${JSON.stringify(fp.path ?? fp.tag ?? '')}`,
      description: `${fp.role ?? fp.tag ?? 'element'} "${label.slice(0, 60)}"${s.visible ? '' : ' (hidden)'}`,
      score: Math.round(score * 100) / 100,
      index,
      pool,
    };
  });
}

/**
 * Outline elements with temporary fixed boxes (red: the first, amber: others) so the
 * failure screenshot shows the target or the nearest match. removeOutlines() takes them away.
 */
async function drawOutlines(locs: Array<import('../../browser/index.js').Locator>): Promise<number> {
  let n = 0;
  for (const [i, l] of locs.entries()) {
    const ok = await l.evaluate((el, first) => {
      const r = el.getBoundingClientRect();
      const d = document.createElement('div');
      d.setAttribute('data-eztest-outline', '1');
      d.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;border:3px solid ${first ? '#d1242f' : '#bf8700'};left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width}px;height:${r.height}px;box-sizing:content-box`;
      document.documentElement.appendChild(d);
      return true;
    }, i === 0, { timeout: 500 }).catch(() => false);
    if (ok) n++;
  }
  return n;
}

/** Remove the outlines drawn for a failure screenshot (before the DOM and aria snapshots are taken). */
export async function removeOutlines(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('[data-eztest-outline]').forEach((n) => n.remove())).catch(() => undefined);
}


/** In the page: the invalid fields that can explain why clicking `target` did nothing (see nativeInvalidFields). */
function invalidFieldsIn(target: Element | null): string[] {
  // A link does not submit a form; a submit control is checked against its own form only.
  let scope: ParentNode = document;
  if (target) {
    const control = target.closest('button, input, select, textarea') as HTMLButtonElement | null;
    if (!control && target.closest('a[href]')) return [];
    const form = control?.form ?? target.closest('form');
    if (form) scope = form;
  }
  const out: string[] = [];
  for (const el of Array.from(scope.querySelectorAll('input:invalid, select:invalid, textarea:invalid'))) {
    const f = el as HTMLInputElement;
    const r = f.getBoundingClientRect();
    if (!r.width || !r.height || f.type === 'hidden') continue;
    // A form with novalidate submits anyway: its fields' native validity does not explain anything.
    if (f.form?.noValidate) continue;
    const label = (f.labels && f.labels[0] ? f.labels[0].textContent : '') || f.getAttribute('aria-label') || f.name || f.id || f.tagName.toLowerCase();
    out.push(`${label.trim()}: ${f.validationMessage || 'invalid'}`.slice(0, 200));
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Visible form controls the browser's constraint validation rejects, as "label: message" (at most 5). With the
 * element that was clicked: none for a link, else the fields of its form.
 */
export async function nativeInvalidFields(page: Page, clicked?: Locator): Promise<string[]> {
  return (clicked ? clicked.evaluate(invalidFieldsIn) : page.evaluate(invalidFieldsIn, null)).catch(() => []);
}

/** Build the diagnosis of a failed step. Never throws (a diagnosis must not hide the failure). */
export async function diagnoseFailure(d: DiagnoseInput): Promise<FailureDiagnosis | undefined> {
  const { step, ctx } = d;
  const page = ctx.page;
  try {
    const failedConds = d.conditions.filter((c) => !c.passed);
    const target = step.target ?? (failedConds.map((c) => condTarget(c.condition)).find(Boolean));
    let expected: string;
    let found: string;
    if (failedConds.length) {
      expected = failedConds.map((c) => expectedOf(c.condition)).join('; ');
      found = failedConds.map((c) => (c.actual !== undefined ? `${c.condition.type}: ${JSON.stringify(c.actual).slice(0, 200)}` : `${c.condition.type}: ${c.message ?? 'failed'}`)).join('; ');
    } else if (target) {
      expected = `exactly one element for ${target.description} to ${step.action}`;
      found = d.error.split('\n')[0].slice(0, 300);
    } else {
      expected = `${step.action} to succeed`;
      found = d.error.split('\n')[0].slice(0, 300);
    }
    const candidates = target ? await candidateCounts(page, ctx, target) : [];
    const resolvedNone = target ? !candidates.some((c) => c.matches === 1) : false;
    const similar = target && resolvedNone ? await similarElements(page, ctx, step, target, d.fingerprint) : [];
    const consoleErrors = d.console
      .filter((c) => !c.ignored && (c.type === 'error' || c.type === 'pageerror') && Date.parse(c.at) >= d.since - 1000)
      .map((c) => c.text.slice(0, 300))
      .slice(-10);
    // Failed calls during the step: the session's live request records (status as soon as the response
    // arrives, even when the page never reads the body) plus the finished-request log.
    const failedRequests = [...new Set([
      ...(ctx.session?.requests ?? [])
        .filter((r) => r.startedAt >= d.since - 50 && ((r.status ?? 0) >= 400 || r.failure))
        .map((r) => `${r.method} ${shortUrl(r.url)} -> ${r.failure ?? `HTTP ${r.status}`}`),
      ...d.network
        .filter((n) => n.stepId === step.id && ((n.status ?? 0) >= 400 || n.failure))
        .map((n) => `${n.method} ${shortUrl(n.url)} -> ${n.failure ?? `HTTP ${n.status}`}`),
    ])].slice(-10);
    let invalidFields: string[] = [];
    if (/^(?:click|dblclick|press|check|uncheck|submit)$/.test(step.action)) {
      // The element acted on, when exactly one matches: its own form (a link has none) explains the failure.
      let clicked: Locator | undefined;
      const root = step.target ? rootFor(page, [...(ctx.session?.frames ?? []), ...(step.target.frames ?? [])]) : undefined;
      for (const raw of root && step.target ? step.target.locators : []) {
        const l = toLocator(root!, interpolateCandidate(raw, ctx.vars()));
        if ((await l.count().catch(() => 0)) === 1) {
          clicked = l;
          break;
        }
      }
      invalidFields = await nativeInvalidFields(page, clicked);
    }
    let outlined = 0;
    if (d.outline !== false) {
      const root = target ? rootFor(page, [...(ctx.session?.frames ?? []), ...(target.frames ?? [])]) : undefined;
      const locs: Array<import('../../browser/index.js').Locator> = [];
      if (root && target) {
        // Outline what the candidates matched (ambiguous matches), else the nearest similar element.
        for (const raw of target.locators) {
          const l = toLocator(root, interpolateCandidate(raw, ctx.vars()));
          const n = await l.count().catch(() => 0);
          for (let i = 0; i < Math.min(n, 5); i++) locs.push(l.nth(i));
          if (locs.length) break;
        }
        if (!locs.length && similar[0]) locs.push(root.locator(similar[0].pool).nth(similar[0].index));
      }
      // Left on the page for the failure screenshot the runner takes next; removed before DOM/aria snapshots.
      outlined = await drawOutlines(locs);
    }
    return {
      expected, found, candidates,
      similar: similar.map(({ locator, description, score }) => ({ locator, description, score })),
      consoleErrors, failedRequests, url: page.url(), ...(outlined ? { outlined } : {}), ...(invalidFields.length ? { invalidFields } : {}),
    };
  } catch {
    return undefined;
  }
}

/** One line for the error message: "did you mean ...", console and network hints. */
export function diagnosisHint(d: FailureDiagnosis): string {
  const parts: string[] = [];
  try {
    const u = d.url ? new URL(d.url) : undefined;
    if (u && /log-?in|sign-?in|logon|auth/i.test(u.pathname)) parts.push(`the page is now ${u.pathname}${u.search ? ' (with a query)' : ''}: a sign-in page, the session may have expired`);
  } catch {
    /* not a URL */
  }
  if (d.invalidFields?.length) parts.push(`the browser's form validation rejects ${d.invalidFields.slice(0, 2).join('; ')} (the form was probably not submitted)`);
  if (d.similar.length) parts.push(`did you mean ${d.similar.map((s) => `${s.locator} (${s.score})`).join(' or ')}?`);
  if (d.failedRequests.length) parts.push(`failed calls: ${d.failedRequests.slice(0, 2).join(', ')}`);
  if (d.consoleErrors.length) parts.push(`console error: ${d.consoleErrors[d.consoleErrors.length - 1].slice(0, 120)}`);
  return parts.join('; ');
}
