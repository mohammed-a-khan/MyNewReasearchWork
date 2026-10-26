/**
 * Failure categories for the report: every failing (and flaky) test is put in
 * one category - a product defect, a test (automation) issue, the environment,
 * test data, flaky, or "needs review" - with the rule that decided and a
 * suggested next step.
 *
 * The triage verdict decides when it is confident (or names a category the
 * error text cannot); otherwise the error text, the failing step and the
 * test's state decide through the rules below. The rules are deliberately
 * plain: each reads one recognisable symptom and says what to do about it.
 */

export type FailureCategory = 'product' | 'test' | 'environment' | 'data' | 'flaky' | 'unknown';
export const FAILURE_CATEGORIES: FailureCategory[] = ['product', 'test', 'environment', 'data', 'flaky', 'unknown'];
export const CATEGORY_LABEL: Record<FailureCategory, string> = {
  product: 'Product defect',
  test: 'Test issue',
  environment: 'Environment',
  data: 'Test data',
  flaky: 'Flaky',
  unknown: 'Needs review',
};

/** What the report says about one failure. */
export interface CategoryVerdict {
  /** The category. */
  c: FailureCategory;
  /** triage: the triage verdict decided; rule: a report rule on the error text decided. */
  src: 'triage' | 'rule';
  /** The rule (or triage) that decided, in a few words. */
  why: string;
  /** Suggested next step. */
  fix: string;
}

const TRIAGE: Record<string, FailureCategory> = { 'product-bug': 'product', 'test-issue': 'test', environment: 'environment', data: 'data', flaky: 'flaky' };

interface Rule {
  c: FailureCategory;
  re: RegExp;
  why: string;
  fix: string;
}

/** Ordered: the first rule whose pattern matches the error text decides. */
const RULES: Rule[] = [
  {
    c: 'test',
    re: /not on an http\(s\) URL|about:blank/i,
    why: 'a page check ran on a step without a web page',
    fix: 'A browser lens ran after a step that has no page open (an API or database step). Run that lens only on UI journeys, or set it to :warn, so API-only journeys are not failed by it.',
  },
  {
    c: 'environment',
    re: /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up|getaddrinfo)\b|net::ERR_|\b(502|503|504)\b.*(gateway|unavailable|timeout)|service unavailable|bad gateway|certificate|self[- ]signed|SSL|TLS handshake/i,
    why: 'the application or a service it needs could not be reached',
    fix: 'Check that the application and its services are up and reachable from the test machine (base URL, DNS, VPN, certificates), then run the failed tests again (eztest run --only-failed <runDir>). A preflight check (health.preflight) stops a run early when the environment is down.',
  },
  {
    c: 'environment',
    re: /browser (has )?(crashed|closed|disconnected)|target (page, context or browser )?(has been )?closed|page crashed|out of memory|ENOSPC|no space left|EACCES|EMFILE|too many open files/i,
    why: 'the browser or the machine failed during the test',
    fix: 'The machine running the tests ran out of a resource or the browser died. Check memory, disk and open files on the agent, lower the number of workers, and run the failed tests again.',
  },
  {
    c: 'data',
    re: /duplicate key|unique constraint|already exists|violates (foreign key|not-null|check) constraint|deadlock|no rows? (returned|found)|returned no rows|row not found|record not found|data (row|source) .*(missing|empty|not found)|REPLACE_WITH_/i,
    why: 'the test data was missing, stale or already used',
    fix: 'Reset or regenerate the data the test uses (seed scripts, shared data store, unique values with gen: generators), then run the test again. If several tests share the same record, give each its own.',
  },
  {
    c: 'test',
    re: /no locator candidate matched|matched (\d+|several|multiple) elements|resolved to \d+ elements|element is not attached|detached from the DOM|stale element|not (an? )?(input|select|checkbox)|unknown step|undefined step|ambiguous step|no step definition|cannot parse|SyntaxError|ReferenceError|TypeError|is not a function|is not defined/i,
    why: 'the test could not find or drive the element, or the test code is wrong',
    fix: 'Open the failing screenshot and the DOM snapshot: if the element is there under a new name or position, update the locator (or accept a heal proposal with eztest heal); if it is genuinely gone, the product changed - file a bug or update the journey.',
  },
  {
    c: 'test',
    re: /timeout \d+ ?ms exceeded[\s\S]*(waiting for|locator|selector|element)|waiting for (locator|selector|element|get[A-Z]\w*\()|element is not (visible|enabled|stable)|covered by another element|is covered by|\(an overlay\)|not clickable/i,
    why: 'the element did not become ready in time',
    fix: 'The element existed but was hidden, disabled, covered or still moving. Wait for the state the step needs (an explicit "Expect ... to be visible" before it) or close the overlay that covers it; if the page is genuinely slower, raise the step timeout.',
  },
  {
    c: 'environment',
    re: /navigation timeout|timeout \d+ ?ms exceeded[\s\S]*(navigat|goto|load)|page did not load|net::ERR_TIMED_OUT/i,
    why: 'the page did not load in time',
    fix: 'The page took too long to load: check the application\'s health and the agent\'s network; if it is consistently slow, raise the navigation timeout and raise it as a performance issue.',
  },
  {
    c: 'product',
    re: /lens (a11y|accessibility) failed|accessibility (violation|finding)|wcag/i,
    why: 'an accessibility rule failed',
    fix: 'Fix the accessibility violation on the page (the step lists the rule, the element and how to fix it), or set the lens to a11y:warn to record findings without failing.',
  },
  {
    c: 'product',
    re: /lens security failed|security (finding|header)|content-security-policy|x-frame-options|cookie .* (secure|httponly)/i,
    why: 'a security check failed',
    fix: 'Add the missing protection the finding names (headers, cookie flags, CSP), or set the lens to security:warn while it is being fixed.',
  },
  {
    c: 'product',
    re: /visual (difference|comparison|mismatch)|pixels? differ|screenshot (does not match|differs)/i,
    why: 'the page looks different from its baseline',
    fix: 'Compare the baseline, the actual and the diff image: if the change is intended, accept it (eztest run --update-baselines); otherwise it is a visual regression.',
  },
  {
    c: 'product',
    re: /\bstatus (code )?(was |is |of )?5\d\d\b|returned (HTTP )?5\d\d|internal server error/i,
    why: 'the server answered with an error',
    fix: 'The application returned a server error: open the API exchange of the step for the response body and the server logs for the request; file a bug with the request and response.',
  },
  {
    c: 'product',
    re: /post-condition failed|expected .* (to|but)|does not contain|did not contain|to (equal|be|contain|match|have)|assert|mismatch|not equal|differs? from|reconcil/i,
    why: 'the step ran but the application did not show what the test expects',
    fix: 'Compare "Expected" and "Found" in the failing step: if the application changed on purpose, update the expectation in the journey; otherwise it is a product defect - use "Copy for bug" to file it with the evidence.',
  },
];

const FLAKY_FIX = 'It passed only on a retry. Compare the attempts in the test detail; the usual causes are timing (wait for the state, not for time), shared data and order dependence. Quarantine it while it is fixed so it does not block releases.';
const UNKNOWN_FIX = 'No rule recognised this failure. Open the failing step, its screenshot and the console: decide whether the application or the test is wrong and record the decision (Studio triage) so similar failures are classified next time.';

/** The next step for a category when no rule of that category matched the error (the triage decided). */
const CATEGORY_FIX: Record<Exclude<FailureCategory, 'flaky' | 'unknown'>, string> = {
  product: 'The application did not behave as the test expects: compare "Expected" and "Found" in the failing step; if the change is intended, update the journey, otherwise use "Copy for bug" to file it with the evidence.',
  test: 'The test could not drive the page as written: open the failing step, its screenshot and DOM snapshot, then fix the locator, the wait or the step (or accept a heal proposal with eztest heal).',
  environment: 'Check that the application and the services it needs are up and reachable from the test machine, then run the failed tests again (eztest run --only-failed <runDir>).',
  data: 'Reset or regenerate the data the test uses (seed scripts, shared data store, unique values with gen: generators), then run the test again.',
};

/** Categorise one failing or flaky test. */
export function categoriseFailure(t: {
  state: string;
  error?: { message: string; stack?: string; name?: string };
  failedStep?: string;
  triage?: { category: string; confidence: number };
  flakeReason?: string;
}): CategoryVerdict | undefined {
  if (t.state === 'flaky') return { c: 'flaky', src: t.triage?.category === 'flaky' ? 'triage' : 'rule', why: t.flakeReason ? `passed on retry: ${t.flakeReason}` : 'passed only on retry', fix: FLAKY_FIX };
  if (t.state !== 'failed' && t.state !== 'error') return undefined;
  const fromTriage = t.triage ? TRIAGE[t.triage.category] : undefined;
  const text = `${t.error?.name ?? ''} ${t.error?.message ?? ''}\n${(t.error?.stack ?? '').split('\n').slice(0, 6).join('\n')}`;
  const rule = RULES.find((r) => r.re.test(text));
  if (fromTriage && (t.triage!.confidence >= 0.5 || !rule)) {
    const fix = rule && rule.c === fromTriage ? rule.fix : fromTriage === 'flaky' ? FLAKY_FIX : CATEGORY_FIX[fromTriage as keyof typeof CATEGORY_FIX] ?? UNKNOWN_FIX;
    return { c: fromTriage, src: 'triage', why: `triage: ${t.triage!.category} (${Math.round(t.triage!.confidence * 100)}%)`, fix };
  }
  if (rule) return { c: rule.c, src: 'rule', why: rule.why, fix: rule.fix };
  return { c: 'unknown', src: 'rule', why: 'no rule recognised the error', fix: UNKNOWN_FIX };
}
