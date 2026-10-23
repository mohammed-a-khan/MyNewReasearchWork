#!/usr/bin/env node
/**
 * EZTest testkit runner: runs EZTest's own test files (dev-only, not shipped).
 *
 *   node tools/testkit/cli.mjs [path filters...] [options]      (npm test -- ...)
 *
 * Options:
 *   -t, --grep <regex>       run only tests whose full name ("suite name test name") matches
 *   -w, --workers <n>        test files in parallel (default: CPUs - 1; TESTKIT_WORKERS)
 *   --reporter <name>        default | verbose | dot | junit (repeatable; junit writes a file)
 *   --output-file <path>     JUnit file (default eztest-results/testkit-junit.xml)
 *   --timeout <ms>           default per-test timeout (config testTimeout)
 *   --hook-timeout <ms>      default per-hook timeout (config hookTimeout)
 *   --retry <n>              retry failed tests n times
 *   --bail <n>               stop after n failed tests
 *   --allow-only             allow .only when CI is set
 *   --silent                 do not print the tests' console output
 *   --handles                list every file that left resources open
 *   --list                   print the selected test files and exit
 *   --config <path>          config file (default testkit.config.mjs)
 *   --browser <name>         sets EZTEST_BROWSER (e.g. firefox) for the config and the tests
 *   --no-color / --color
 *
 * Each test file runs in its own worker process (fresh module graph). Exit code 0 when
 * every selected test passed, 1 on any failure, file error or when no test ran, 2 on bad usage,
 * 130 when interrupted.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- arguments ----------

function usage(msg) {
  process.stderr.write(`testkit: ${msg}\nRun with --help for the options.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { filters: [], reporters: [], color: undefined };
  const need = (i, name) => {
    if (i >= argv.length) usage(`${name} needs a value`);
    return argv[i];
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) usage(`${name} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inlineValue;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) {
      inlineValue = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const val = (name) => inlineValue ?? need(++i, name);
    switch (a) {
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '-t':
      case '--grep':
      case '--testNamePattern':
        o.grep = val(a);
        break;
      case '-w':
      case '--workers':
      case '--maxWorkers':
        o.workers = num(val(a), a);
        break;
      case '--reporter':
        o.reporters.push(val(a));
        break;
      case '--output-file':
      case '--outputFile':
        o.outputFile = val(a);
        break;
      case '--timeout':
      case '--testTimeout':
        o.testTimeout = num(val(a), a);
        break;
      case '--hook-timeout':
      case '--hookTimeout':
        o.hookTimeout = num(val(a), a);
        break;
      case '--retry':
        o.retry = num(val(a), a);
        break;
      case '--bail':
        o.bail = num(val(a), a);
        break;
      case '--allow-only':
        o.allowOnly = true;
        break;
      case '--silent':
        o.silent = true;
        break;
      case '--handles':
        o.handles = true;
        break;
      case '--list':
        o.list = true;
        break;
      case '--config':
        o.config = val(a);
        break;
      case '--browser':
        o.browser = val(a);
        break;
      case '--color':
        o.color = true;
        break;
      case '--no-color':
        o.color = false;
        break;
      case 'run':
        // `testkit run ...` reads like the old command; nothing to do.
        if (i === 0) break;
      // falls through
      default:
        if (a.startsWith('-')) usage(`unknown option ${a}`);
        o.filters.push(a);
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
// Before the config is read: it picks the module swaps from EZTEST_BROWSER.
if (args.browser) process.env.EZTEST_BROWSER = args.browser;
if (args.help) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  process.stdout.write(`${/\/\*\*([\s\S]*?)\*\//.exec(text)[1].replace(/^ \* ?/gm, '').trim()}\n`);
  process.exit(0);
}

// ---------- config ----------

const ROOT = process.cwd();
const configPath = resolve(ROOT, args.config ?? 'testkit.config.mjs');
const config = existsSync(configPath) ? ((await import(pathToFileURL(configPath).href)).default ?? {}) : {};
if (args.config && !existsSync(configPath)) usage(`config ${args.config} not found`);

const useColor = args.color ?? (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !process.env.NO_COLOR && !!process.stdout.isTTY);
const paint = (code, close = 39) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[${close}m` : s);
const c = { red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), gray: paint(90), bold: paint(1, 22), dim: paint(2, 22), inverseRed: (s) => (useColor ? `\x1b[41m\x1b[97m${s}\x1b[39m\x1b[49m` : s) };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const reporters = new Set(args.reporters.length ? args.reporters : ['default']);
for (const r of reporters) if (!['default', 'verbose', 'dot', 'junit'].includes(r)) usage(`unknown reporter "${r}" (default, verbose, dot, junit)`);
const consoleReporter = reporters.has('verbose') ? 'verbose' : reporters.has('dot') ? 'dot' : 'default';

const options = {
  root: ROOT,
  testTimeout: args.testTimeout ?? config.testTimeout ?? 5000,
  hookTimeout: args.hookTimeout ?? config.hookTimeout ?? 10_000,
  retry: args.retry ?? config.retry ?? 0,
  grep: args.grep,
  allowOnly: args.allowOnly ?? false,
  color: useColor,
};
/** Extra time a worker gets past a test's or hook's own timeout before it counts as stuck and is killed. */
const WATCHDOG_GRACE_MS = Number(process.env.TESTKIT_WATCHDOG_MS ?? 30_000);
const workers = Math.max(1, Math.floor(args.workers || Number(process.env.TESTKIT_WORKERS) || config.workers || Math.max(availableParallelism() - 1, 1)));

// ---------- discovery ----------

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    if (d.name === 'node_modules' || d.name === '.git') continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.isFile()) out.push(p);
  }
  return out;
}

const relPath = (p) => relative(ROOT, p).split(sep).join('/');
const include = (config.include ?? ['test/**/*.test.ts']).map(globToRegExp);
const exclude = (config.exclude ?? ['**/node_modules/**']).map(globToRegExp);
const roots = [...new Set((config.include ?? ['test/**/*.test.ts']).map((g) => g.split('/').filter((s) => !/[*?{]/.test(s)).slice(0, -1).join('/') || '.'))];
let files = [...new Set(roots.flatMap((r) => walk(resolve(ROOT, r))))]
  .map(relPath)
  .filter((f) => include.some((re) => re.test(f)) && !exclude.some((re) => re.test(f)));
if (args.filters.length) {
  const wanted = args.filters.map((f) => {
    const abs = isAbsolute(f) ? f : resolve(ROOT, f);
    return existsSync(abs) && statSync(abs).isFile() ? { exact: relPath(abs) } : { part: f.replace(/\\/g, '/').replace(/^\.\//, '') };
  });
  files = files.filter((f) => wanted.some((w) => (w.exact ? f === w.exact : f.includes(w.part))));
}
files.sort();

if (args.list) {
  for (const f of files) process.stdout.write(`${f}\n`);
  process.exit(0);
}
if (!files.length) {
  process.stderr.write(`${c.red('No test files found')}${args.filters.length ? ` matching ${args.filters.join(' ')}` : ''} (include: ${(config.include ?? []).join(', ')})\n`);
  process.exit(1);
}

// Longest files first (durations of the previous run), then the biggest.
const cacheRoot = join(tmpdir(), `eztest-testkit-${process.getuid?.() ?? 0}`);
const projectKey = createHash('sha1').update(ROOT).digest('hex').slice(0, 12);
const durationsFile = join(cacheRoot, `durations-${projectKey}.json`);
let durations = {};
try {
  durations = JSON.parse(readFileSync(durationsFile, 'utf8'));
} catch {
  durations = {};
}
const weight = (f) => durations[f] ?? statSync(join(ROOT, f)).size;
const queue = [...files].sort((a, b) => weight(b) - weight(a));

// ---------- global setup ----------

const startedAt = new Date();
const t0 = performance.now();
let globalTeardown;
try {
  if (typeof config.globalSetup === 'function') globalTeardown = await config.globalSetup();
} catch (e) {
  process.stderr.write(`${c.red('globalSetup failed:')} ${e?.stack ?? e}\n`);
  process.exit(1);
}
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
Object.assign(process.env, config.env ?? {});

const loaderData = JSON.stringify({ root: ROOT, cacheDir: join(cacheRoot, 'transform'), swaps: config.swaps ?? [] });

process.stdout.write(`\n ${c.inverseRed(' EZTest testkit ')} ${c.cyan(`${files.length} test file${files.length === 1 ? '' : 's'}`)} ${c.gray(`on ${workers} worker${workers === 1 ? '' : 's'}`)}${process.env.EZTEST_BROWSER ? c.gray(` (EZTEST_BROWSER=${process.env.EZTEST_BROWSER})`) : ''} ${c.gray(ROOT)}\n\n`);

// ---------- running ----------

/** @type {Map<string, {file:string, tests:any[], errors:any[], durationMs:number, output:string, handles?:string[]}>} */
const results = new Map();
const running = new Map();
let failedTests = 0;
let bailed = false;
let interrupted = false;
let dotColumn = 0;

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const testName = (t) => t.path.join(' > ');

function printFile(r) {
  const out = [];
  if (r.output && !args.silent) {
    out.push(c.gray(`stdout | ${r.file}`));
    out.push(r.output.replace(/\s+$/, ''));
    out.push('');
  }
  const failed = r.tests.filter((t) => t.state === 'fail');
  const skipped = r.tests.filter((t) => t.state === 'skip' || t.state === 'todo');
  const bad = failed.length || r.errors.length;
  if (consoleReporter === 'dot') {
    let line = '';
    for (const t of r.tests) {
      line += t.state === 'pass' ? c.green('·') : t.state === 'fail' ? c.red('x') : c.yellow('-');
      if (++dotColumn % 80 === 0) line += '\n';
    }
    if (r.errors.length) line += c.red('E');
    if (out.length) process.stdout.write(`${dotColumn % 80 ? '\n' : ''}${out.join('\n')}\n`);
    process.stdout.write(line);
    return;
  }
  const counts = [`${r.tests.length} test${r.tests.length === 1 ? '' : 's'}`];
  if (failed.length) counts.push(c.red(`${failed.length} failed`));
  if (skipped.length && skipped.length !== r.tests.length) counts.push(c.yellow(`${skipped.length} skipped`));
  const icon = bad ? c.red('❯') : skipped.length === r.tests.length && r.tests.length ? c.yellow('↓') : c.green('✓');
  out.push(` ${icon} ${r.file} ${c.gray(`(${counts.join(c.gray(' | '))}${c.gray(')')}`)} ${c.gray(fmtMs(r.durationMs))}`);
  for (const t of r.tests) {
    const slow = t.durationMs > 300 ? ` ${c.yellow(fmtMs(t.durationMs))}` : '';
    const retried = t.retries ? c.yellow(` (retry x${t.retries})`) : '';
    if (t.state === 'fail') {
      out.push(`   ${c.red('×')} ${testName(t)} ${c.gray(fmtMs(t.durationMs))}${retried}`);
      const first = t.errors[0];
      if (first) out.push(`     ${c.red('→')} ${c.red(first.message.split('\n')[0].slice(0, 300))}`);
    } else if (consoleReporter === 'verbose') {
      if (t.state === 'pass') out.push(`   ${c.green('✓')} ${testName(t)}${slow}${retried}`);
      else out.push(`   ${c.yellow('↓')} ${testName(t)} ${c.gray(t.state === 'todo' ? '[todo]' : `[skipped${t.note ? `: ${t.note}` : ''}]`)}`);
    }
  }
  for (const e of r.errors) out.push(`   ${c.red('×')} ${c.red(`[${e.where}]`)} ${c.red(e.message.split('\n')[0].slice(0, 300))}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

function runOne(file) {
  return new Promise((done) => {
    const record = { file, tests: [], errors: [], durationMs: 0, output: '', handles: undefined };
    const started = performance.now();
    let finished = false;
    let killed = false;
    let current;
    let watchdog;
    const child = fork(join(HERE, 'worker.mjs'), [], {
      cwd: ROOT,
      execArgv: ['--enable-source-maps', '--import', pathToFileURL(join(HERE, 'register.mjs')).href, ...(config.execArgv ?? [])],
      env: { ...process.env, TESTKIT_LOADER_OPTIONS: loaderData, TESTKIT_JOB: JSON.stringify({ file: join(ROOT, file), options }) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    running.set(file, child);
    const collect = (chunk) => {
      record.output += chunk;
      if (record.output.length > 4_000_000) record.output = `${record.output.slice(0, 2_000_000)}\n... (output truncated) ...\n${record.output.slice(-1_000_000)}`;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const arm = (ms, what) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        record.errors.push({ name: 'Error', message: `The worker stopped responding during ${what} (no progress for ${fmtMs(ms)}); it was killed.`, where: 'testkit watchdog' });
        if (current?.kind === 'test') record.tests.push({ path: current.path, state: 'fail', durationMs: performance.now() - current.at, retries: 0, errors: [{ name: 'Error', message: 'The test never finished (its worker was killed by the watchdog).' }] });
        killed = true;
        child.kill('SIGKILL');
      }, ms);
    };
    // Collection (imports) gets 5 minutes; a test or hook its timeout plus the watchdog grace (30 s).
    arm(300_000, 'collection');
    child.on('message', (m) => {
      switch (m.type) {
        case 'test-start':
          current = { kind: 'test', path: m.path, at: performance.now() };
          arm(m.timeoutMs + WATCHDOG_GRACE_MS, `"${m.path.join(' > ')}"`);
          break;
        case 'test-end':
          current = undefined;
          record.tests.push(m.result);
          if (m.result.state === 'fail') {
            failedTests++;
            if (args.bail && failedTests >= args.bail) bail();
          }
          arm(300_000, 'the file, between tests');
          break;
        case 'hook-start':
          if (current?.kind !== 'test') current = { kind: 'hook', path: [m.kind], at: performance.now() };
          arm(m.timeoutMs + WATCHDOG_GRACE_MS, `a ${m.kind} hook${current?.kind === 'test' ? ` of "${current.path.join(' > ')}"` : ''}`);
          break;
        case 'hook-end':
          if (current?.kind === 'hook') current = undefined;
          arm(300_000, 'the file, between hooks');
          break;
        case 'done': {
          finished = true;
          const r = m.result;
          // Tests were already streamed; keep the streamed copies (they include watchdog-free results).
          record.errors.push(...r.errors);
          record.durationMs = r.durationMs;
          // The worker exits by itself after a grace period; make sure it does.
          arm(15_000, 'teardown');
          break;
        }
        case 'handles':
          record.handles = m.handles;
          break;
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      running.delete(file);
      if (!finished && !killed && !bailed && !interrupted) {
        const tail = record.output.trim().split('\n').slice(-15).join('\n');
        record.errors.push({ name: 'Error', message: `The worker exited before the file finished (${signal ? `signal ${signal}` : `exit code ${code}`}).${tail ? `\nLast output:\n${tail}` : ''}`, where: 'testkit worker' });
      }
      if (!record.durationMs) record.durationMs = performance.now() - started;
      if (!bailed && !interrupted) {
        results.set(file, record);
        printFile(record);
      }
      done();
    });
  });
}

function bail() {
  if (bailed) return;
  bailed = true;
  queue.length = 0;
  for (const child of running.values()) child.kill('SIGKILL');
}

process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  queue.length = 0;
  for (const child of running.values()) child.kill('SIGKILL');
});
process.on('SIGTERM', () => {
  for (const child of running.values()) child.kill('SIGKILL');
  process.exit(143);
});

async function lane() {
  while (queue.length) {
    const f = queue.shift();
    await runOne(f);
  }
}
await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, lane));
if (consoleReporter === 'dot') process.stdout.write('\n');

try {
  if (typeof globalTeardown === 'function') await globalTeardown();
} catch (e) {
  process.stderr.write(`${c.red('globalTeardown failed:')} ${e?.stack ?? e}\n`);
}

// ---------- summary ----------

const all = [...results.values()].sort((a, b) => a.file.localeCompare(b.file));
const tests = all.flatMap((r) => r.tests.map((t) => ({ ...t, file: r.file })));
const n = { pass: 0, fail: 0, skip: 0, todo: 0 };
for (const t of tests) n[t.state]++;
const fileState = (r) => (r.errors.length || r.tests.some((t) => t.state === 'fail') ? 'fail' : r.tests.length && r.tests.every((t) => t.state === 'skip' || t.state === 'todo') ? 'skip' : 'pass');
const fileCounts = { pass: 0, fail: 0, skip: 0 };
for (const r of all) fileCounts[fileState(r)]++;
const wallMs = performance.now() - t0;

function printError(e) {
  const lines = [c.red(`${c.bold(`${e.name}:`)} ${e.message}`)];
  if (e.diff) lines.push('', e.diff);
  if (e.location) lines.push('', ` ${c.cyan('❯')} ${e.location}`);
  if (e.frame) lines.push(e.frame.split('\n').map((l) => `    ${l}`).join('\n'));
  else if (e.stack) lines.push(c.gray(e.stack.split('\n').map((l) => `  ${l.trim()}`).join('\n')));
  return lines.join('\n');
}

const sep80 = (title) => c.red(`${'⎯'.repeat(7)} ${title} ${'⎯'.repeat(Math.max(3, 60 - title.length))}`);
const fileErrors = all.flatMap((r) => r.errors.map((e) => ({ ...e, file: r.file })));
const suiteErrors = fileErrors.filter((e) => !/^(Unhandled Rejection|Uncaught Exception)$/.test(e.where));
const unhandledErrors = fileErrors.filter((e) => /^(Unhandled Rejection|Uncaught Exception)$/.test(e.where));
const failures = tests.filter((t) => t.state === 'fail');
const report = [];
if (suiteErrors.length) {
  report.push('', sep80(`Failed Suites ${suiteErrors.length}`), '');
  suiteErrors.forEach((e, i) => {
    report.push(`${c.inverseRed(' FAIL ')} ${e.file} ${c.gray(`[ ${e.where} ]`)}`, printError(e), c.gray(`${'⎯'.repeat(3)}[${i + 1}/${suiteErrors.length}]⎯`), '');
  });
}
if (failures.length) {
  report.push('', sep80(`Failed Tests ${failures.length}`), '');
  failures.forEach((t, i) => {
    report.push(`${c.inverseRed(' FAIL ')} ${t.file} > ${testName(t)}`);
    t.errors.forEach((e, j) => report.push(t.errors.length > 1 ? c.gray(`(error ${j + 1} of ${t.errors.length})`) : '', printError(e)));
    report.push(c.gray(`${'⎯'.repeat(3)}[${i + 1}/${failures.length}]⎯`), '');
  });
}
if (unhandledErrors.length) {
  report.push('', sep80(`Unhandled Errors ${unhandledErrors.length}`), '', c.red('Errors thrown outside the tests (they fail the run, as they may hide real failures):'), '');
  for (const e of unhandledErrors) report.push(`${c.inverseRed(` ${e.where.toUpperCase()} `)} ${e.file}`, printError(e), '');
}
const withHandles = all.filter((r) => r.handles?.length);
if (withHandles.length) {
  report.push('', c.yellow(`Open handles: ${withHandles.length} file${withHandles.length === 1 ? '' : 's'} kept the worker alive after the tests (timers, sockets, servers, child processes); the workers were stopped.${args.handles ? '' : ' --handles lists them.'}`));
  if (args.handles) for (const r of withHandles) report.push(c.yellow(`  ${r.file}: ${r.handles.join(', ')}`));
}
const part = (count, label, color) => (count ? color(`${count} ${label}`) : '');
const join3 = (...xs) => xs.filter(Boolean).join(c.gray(' | '));
const time = (d) => d.toTimeString().slice(0, 8);
report.push(
  '',
  ` ${c.dim('Test Files')}  ${join3(part(fileCounts.fail, 'failed', (s) => c.bold(c.red(s))), part(fileCounts.pass, 'passed', (s) => c.bold(c.green(s))), part(fileCounts.skip, 'skipped', c.yellow))} ${c.gray(`(${all.length})`)}`,
  `      ${c.dim('Tests')}  ${join3(part(n.fail, 'failed', (s) => c.bold(c.red(s))), part(n.pass, 'passed', (s) => c.bold(c.green(s))), part(n.skip, 'skipped', c.yellow), part(n.todo, 'todo', c.gray))} ${c.gray(`(${tests.length})`)}`,
);
if (unhandledErrors.length) report.push(`     ${c.dim('Errors')}  ${c.bold(c.red(`${unhandledErrors.length} error${unhandledErrors.length === 1 ? '' : 's'}`))}`);
report.push(`   ${c.dim('Start at')}  ${time(startedAt)}`, `   ${c.dim('Duration')}  ${(wallMs / 1000).toFixed(2)}s ${c.gray(`(${workers} worker${workers === 1 ? '' : 's'})`)}`);
if (bailed) report.push('', c.yellow(`Bailed out after ${failedTests} failed test${failedTests === 1 ? '' : 's'} (--bail ${args.bail}); remaining files were not run.`));
if (interrupted) report.push('', c.yellow('Interrupted; the summary covers the files that finished.'));
process.stdout.write(`${report.join('\n')}\n\n`);

// ---------- JUnit ----------

if (reporters.has('junit')) {
  const xml = (s) =>
    stripAnsi(String(s))
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const errText = (e) => [`${e.name}: ${e.message}`, e.diff, e.location && `at ${e.location}`, e.stack].filter(Boolean).join('\n\n');
  const secs = (ms) => (ms / 1000).toFixed(3);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const totalErrors = fileErrors.length;
  lines.push(`<testsuites name="eztest-testkit" tests="${tests.length + totalErrors}" failures="${n.fail}" errors="${totalErrors}" skipped="${n.skip + n.todo}" time="${secs(wallMs)}" timestamp="${startedAt.toISOString()}">`);
  for (const r of all) {
    const f = r.tests.filter((t) => t.state === 'fail').length;
    const s = r.tests.filter((t) => t.state === 'skip' || t.state === 'todo').length;
    lines.push(`  <testsuite name="${xml(r.file)}" tests="${r.tests.length + r.errors.length}" failures="${f}" errors="${r.errors.length}" skipped="${s}" time="${secs(r.durationMs)}" timestamp="${startedAt.toISOString()}" hostname="${xml(hostname())}">`);
    for (const t of r.tests) {
      const open = `    <testcase classname="${xml(r.file)}" name="${xml(testName(t))}" time="${secs(t.durationMs)}" file="${xml(r.file)}"`;
      if (t.state === 'pass') lines.push(`${open}/>`);
      else if (t.state === 'fail') {
        lines.push(`${open}>`);
        for (const e of t.errors) lines.push(`      <failure message="${xml(e.message.split('\n')[0].slice(0, 500))}" type="${xml(e.name)}">${xml(errText(e))}</failure>`);
        lines.push('    </testcase>');
      } else lines.push(`${open}><skipped${t.note ? ` message="${xml(t.note)}"` : ''}/></testcase>`);
    }
    for (const e of r.errors) {
      lines.push(`    <testcase classname="${xml(r.file)}" name="${xml(`[${e.where}]`)}" time="0" file="${xml(r.file)}">`);
      lines.push(`      <error message="${xml(e.message.split('\n')[0].slice(0, 500))}" type="${xml(e.name)}">${xml(errText(e))}</error>`);
      lines.push('    </testcase>');
    }
    if (r.output) lines.push(`    <system-out>${xml(r.output.slice(-200_000))}</system-out>`);
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  const out = resolve(ROOT, args.outputFile ?? join('eztest-results', 'testkit-junit.xml'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  process.stdout.write(`${c.gray(`JUnit report: ${relPath(out)}`)}\n`);
}

// Durations for the next run's ordering.
if (!args.grep && !interrupted && !bailed) {
  try {
    mkdirSync(cacheRoot, { recursive: true });
    for (const r of all) durations[r.file] = Math.round(r.durationMs);
    writeFileSync(durationsFile, JSON.stringify(durations));
  } catch {
    // best-effort
  }
}

const ok = !interrupted && !bailed && n.fail === 0 && fileErrors.length === 0 && tests.length > 0;
process.exit(interrupted ? 130 : ok ? 0 : 1);
