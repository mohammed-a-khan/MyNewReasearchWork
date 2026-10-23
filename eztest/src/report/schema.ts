/**
 * JSON Schema (2020-12) of report.json version 2. `run` and `insights` are
 * described loosely (they are the RunResult and the insight types); the
 * report model is described field by field. docs/reports.md documents it.
 */
const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const strs = { type: 'array', items: str } as const;
const link = { type: 'object', required: ['id'], properties: { id: {}, url: str } } as const;
const state = { enum: ['passed', 'healed', 'flaky', 'failed', 'error', 'skipped'] } as const;
const kpis = {
  type: 'object',
  required: ['total', 'passed', 'failed', 'errors', 'flaky', 'healed', 'skipped', 'passRate', 'durationMs'],
  properties: { total: int, passed: int, failed: int, errors: int, flaky: int, healed: int, skipped: int, passRate: { type: 'number', minimum: 0, maximum: 1 }, durationMs: num },
} as const;

const step: Record<string, unknown> = {
  $id: 'step',
  type: 'object',
  required: ['n', 's', 'd', 't'],
  description: 'A step. n intent, s status code (P passed, H passed-healed, F failed, S skipped, B blocked), d duration ms, t start ms after the test started, e evidence ids, x error, h heal, c post-conditions [text, held, actual], l locator, a actor, i iteration, b branch, so soft, w warnings, dg diagnosis, db query rows, api exchanges, im locator suggestion, m manual verdict, ch child steps.',
  properties: {
    n: str, s: { enum: ['P', 'H', 'F', 'S', 'B'] }, d: num, t: num, e: strs,
    x: { type: 'object', required: ['message'], properties: { name: str, message: str, stack: str } },
    h: { type: 'object', required: ['tier', 'from', 'to', 'confidence', 'verified'], properties: { tier: str, from: strs, to: str, confidence: num, verified: bool, reason: str, evidence: strs, element: str } },
    c: { type: 'array', items: { type: 'array', prefixItems: [str, bool, str] } },
    l: str, a: str, i: int, b: str, so: { const: 1 }, w: strs,
    dg: { type: 'object' }, db: { type: 'object', required: ['key', 'columns', 'rows', 'total'] },
    api: { type: 'array', items: { type: 'object', required: ['method', 'url', 'status'] } },
    im: { type: 'object' }, m: { type: 'object' },
    ch: { type: 'array', items: { $ref: 'step' } },
  },
};

const test = {
  type: 'object',
  required: ['id', 'name', 'state', 'status', 'durationMs', 'startMs', 'tags', 'requirements', 'risk', 'attempt', 'owners', 'suite', 'heals', 'bugs', 'requirementLinks', 'actors', 'steps'],
  properties: {
    id: str, name: str, state, status: str, durationMs: num, startMs: num, tags: strs, requirements: strs, risk: num, attempt: int, browser: str, owners: strs, file: str,
    suite: { ...strs, description: 'Suite path, outermost first (BDD feature/rule, else folders and file).' },
    error: { type: 'object', required: ['message'] }, failedStep: str, signature: str, cluster: str,
    failure: { type: 'object', required: ['known', 'tags'], properties: { known: bool, firstSeenRun: str, firstSeenAt: str, tags: strs, streak: int } },
    triage: { type: 'object', required: ['category', 'confidence', 'status', 'reasons', 'evidence'] },
    history: { type: 'object', required: ['state', 'sequence', 'failRate', 'samples'] },
    flake: { type: 'object' }, heals: int,
    ado: { type: 'object', required: ['testCases', 'results'], properties: { testCases: { type: 'array', items: link }, plan: link, suite: link, results: { type: 'array', items: { type: 'object', required: ['testCaseId'] } } } },
    bugs: { type: 'array', items: { type: 'object', required: ['system', 'id', 'action'], properties: { system: { enum: ['ado', 'jira'] }, id: str, url: str, action: str } } },
    requirementLinks: { type: 'array', items: link },
    row: { type: 'object', additionalProperties: str }, actors: strs,
    video: { type: 'object', required: ['src'] }, trace: { type: 'object' },
    attempts: { type: 'array', items: { type: 'object', required: ['attempt', 'status', 'durationMs', 'steps'] } },
    network: { type: 'array' }, console: strs, manual: { type: 'object' },
    steps: { type: 'array', items: { $ref: 'step' } },
  },
} as const;

const model = {
  type: 'object',
  required: ['format', 'version', 'generatedAt', 'title', 'brand', 'runId', 'startedAt', 'finishedAt', 'durationMs', 'kpis', 'verdict', 'trend', 'slowest', 'failureGroups', 'clusters', 'coverage', 'integrations', 'healProposals', 'evidenceKinds', 'evidence', 'tests', 'linkConfig', 'warnings'],
  properties: {
    format: { const: 'eztest-report-model' },
    version: { const: 2 },
    generatedAt: str, title: str,
    brand: { type: 'object', required: ['name'], properties: { name: str, logo: str } },
    runId: str, startedAt: str, finishedAt: str, durationMs: num,
    context: { type: 'object', required: ['browsers', 'devices', 'eztestVersion', 'node', 'machine', 'startedAt', 'finishedAt', 'timeZone', 'extra'] },
    kpis,
    previous: { type: 'object', required: ['runId', 'startedAt', 'kpis'], properties: { runId: str, startedAt: str, kpis } },
    verdict: {
      type: 'object', required: ['decision', 'source', 'reasons', 'gates', 'exceptions'],
      properties: { decision: { enum: ['GO', 'GO_WITH_RISKS', 'NO_GO'] }, score: num, source: { enum: ['policy', 'built-in'] }, reasons: { type: 'array', items: { type: 'object', required: ['kind', 'text', 'tests', 'requirements', 'evidence'] } }, gates: { type: 'array' }, exceptions: { type: 'array' }, browsers: { type: 'object' } },
    },
    trend: { type: 'array', items: { type: 'object', required: ['runId', 'startedAt', 'passRate', 'durationMs', 'total', 'failed'] } },
    slowest: { type: 'array', items: { type: 'object', required: ['id', 'name', 'durationMs', 'state'] } },
    failureGroups: { type: 'array', items: { type: 'object', required: ['signature', 'message', 'tests', 'known'] } },
    clusters: { type: 'array', items: { type: 'object', required: ['id', 'size', 'message', 'tests', 'cohesion'] } },
    coverage: { type: 'object', properties: { risk: { type: 'object' }, requirements: { type: 'object' }, api: { type: 'array' }, ui: { type: 'object' } } },
    comparison: { type: 'object', required: ['baselineRunId', 'newlyFailing', 'fixed', 'stillFailing', 'slower', 'faster', 'added', 'removed', 'kpis'] },
    integrations: { type: 'object', required: ['notifications', 'publishers'], properties: { ado: { type: 'object', required: ['configured', 'bugs', 'requirementsCommented'] }, pullRequest: { type: 'object' }, jira: { type: 'object' }, notifications: { type: 'array' }, resultsServer: { type: 'object' }, publishers: { type: 'array' }, git: { type: 'object' } } },
    healProposals: { type: 'array' },
    browsers: { type: 'object' },
    evidenceKinds: strs,
    evidence: { type: 'object', description: 'Evidence id -> [kind index into evidenceKinds, relative URL or null, description?].', additionalProperties: { type: 'array', minItems: 2, maxItems: 3 } },
    evidenceHead: str,
    health: { type: 'object' },
    tests: { type: 'array', items: test },
    extraHtml: strs,
    linkConfig: { type: 'object' },
    warnings: strs,
  },
} as const;

export const REPORT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'eztest:report/2',
  title: 'EZTest report.json (version 2)',
  type: 'object',
  required: ['format', 'version', 'generatedAt', 'run', 'insights'],
  properties: {
    format: { const: 'eztest-report' },
    version: { enum: [1, 2] },
    $schema: str,
    generatedAt: str,
    run: { type: 'object', required: ['runId', 'startedAt', 'finishedAt', 'durationMs', 'journeys', 'summary', 'environment'] },
    insights: { type: 'object', required: ['healProposals'] },
    model,
  },
  $defs: { step },
} as const;
