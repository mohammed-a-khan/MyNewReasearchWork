'use strict';
/**
 * The EZTest pipeline task (Node 20 handler). No dependencies: inputs come
 * from INPUT_* variables, results go back through ##vso logging commands, and
 * every step is the eztest CLI spawned without a shell (argument arrays).
 *
 *   install -> run (sharded) | merge -> summary (results tab, build summary)
 *   -> pipeline test results + artifact -> evidence pack -> Azure Test Plans
 *   -> pull request status and comment -> readiness gate
 *
 * The readiness gate decides the step result: NO_GO fails it and
 * GO_WITH_RISKS makes it "succeeded with issues" (both configurable). Without
 * a readiness policy, failing journeys fail the step (configurable).
 */
const { spawn } = require('node:child_process');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

function input(env, name, def) {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? def : v;
}

function bool(env, name, def) {
  const v = input(env, name, undefined);
  return v === undefined ? def : /^(true|1|yes)$/i.test(String(v).trim());
}

/** Split a command line into argv without a shell (quotes group, backslash escapes inside double quotes). */
function splitArgv(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** Escape a ##vso message (the agent unescapes %AZP25, %0D and %0A). */
function vsoEscape(s) {
  return String(s).replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a ##vso property value (also ] and ;). */
function vsoProp(s) {
  return vsoEscape(s).replace(/]/g, '%5D').replace(/;/g, '%3B');
}

function createLogger(write) {
  return {
    out: (s) => write(`${s}\n`),
    cmd: (area, props, msg = '') => {
      const p = Object.entries(props).map(([k, v]) => `${k}=${vsoProp(v)};`).join('');
      write(`##vso[${area}${p ? ` ${p}` : ''}]${vsoEscape(msg)}\n`);
    },
  };
}

function run(argv, opts) {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (!opts.quiet) opts.write(d.toString('utf8'));
    });
    child.stderr.on('data', (d) => {
      if (!opts.quiet) opts.write(d.toString('utf8'));
      else stdout += d.toString('utf8');
    });
    child.on('error', (e) => res({ code: 127, stdout, error: e.message }));
    child.on('close', (code) => res({ code: code === null ? 1 : code, stdout }));
  });
}

/** Newest run directory (holding run.json) under the results directory. */
function newestRun(outDir) {
  if (!existsSync(outDir)) return undefined;
  let best;
  for (const name of readdirSync(outDir)) {
    const dir = join(outDir, name);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'run.json'))) continue;
      const t = statSync(join(dir, 'run.json')).mtimeMs;
      if (!best || t > best.t) best = { dir, t };
    } catch {
      // unreadable entry
    }
  }
  return best && best.dir;
}

function readiness(runDir) {
  try {
    const r = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
    return r.insights && r.insights.readiness;
  } catch {
    return undefined;
  }
}

function runSummary(runDir) {
  try {
    return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).summary;
  } catch {
    return undefined;
  }
}

/**
 * Run the task. Returns { result: 'Succeeded' | 'SucceededWithIssues' | 'Failed', message, runDir }.
 * `deps.exec` and `deps.write` are injectable for tests.
 */
async function main(env = process.env, deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const log = createLogger(write);
  const exec = deps.exec || ((argv, o) => run(argv, { ...o, write }));
  const command = input(env, 'command', 'all');
  const cwd = resolve(input(env, 'workingDirectory', env.SYSTEM_DEFAULTWORKINGDIRECTORY || process.cwd()));
  const outDir = resolve(cwd, input(env, 'outputDirectory', 'eztest-results'));
  const cli = splitArgv(input(env, 'eztestCommand', '')).length ? splitArgv(input(env, 'eztestCommand', '')) : ['npx', '--no-install', 'eztest'];
  const issues = [];
  let failed;

  // The job's OAuth token (no PAT needed): passed to EZTest as SYSTEM_ACCESSTOKEN and masked in the log.
  const childEnv = { ...env };
  const token = env.SYSTEM_ACCESSTOKEN || env.ENDPOINT_AUTH_PARAMETER_SYSTEMVSSCONNECTION_ACCESSTOKEN;
  if (token) {
    log.cmd('task.setsecret', {}, token);
    childEnv.SYSTEM_ACCESSTOKEN = token;
  }
  for (const k of Object.keys(childEnv)) if (k.startsWith('INPUT_') || k.startsWith('ENDPOINT_AUTH_')) delete childEnv[k];
  // The task completes itself; the CLI only logs issues.
  childEnv.EZTEST_TASK = '1';
  const eztest = (args) => exec([...cli, ...args], { cwd, env: childEnv });
  const configArgs = [...(input(env, 'environment') ? ['--env', input(env, 'environment')] : []), ...(input(env, 'project') ? ['--project', input(env, 'project')] : [])];

  // ---------------------------------------------------------------- install
  const install = input(env, 'install', 'auto');
  if (command === 'all' || command === 'run') {
    if (install === 'npmCi' || (install === 'auto' && existsSync(join(cwd, 'package-lock.json')))) {
      log.out('EZTest: npm ci');
      const r = await exec([process.platform === 'win32' ? 'npm.cmd' : 'npm', 'ci', '--no-audit', '--no-fund'], { cwd, env: childEnv });
      if (r.code !== 0) return finish(log, 'Failed', 'npm ci failed');
    } else if (install === 'package') {
      const v = input(env, 'eztestVersion', 'latest');
      if (!/^[\w.^~<>=*-]+$/.test(v)) return finish(log, 'Failed', `invalid eztestVersion ${v}`);
      const r = await exec([process.platform === 'win32' ? 'npm.cmd' : 'npm', 'install', '--no-save', '--no-audit', '--no-fund', `eztest@${v}`], { cwd, env: childEnv });
      if (r.code !== 0) return finish(log, 'Failed', `npm install eztest@${v} failed`);
    }
    const setup = splitArgv(input(env, 'setupCommand', ''));
    if (setup.length) {
      log.out(`EZTest: setup ${setup.join(' ')}`);
      const r = await exec(setup, { cwd, env: childEnv });
      if (r.code !== 0) return finish(log, 'Failed', `setup command exited ${r.code}`);
    }
  }

  // ---------------------------------------------------------------- run / merge
  let runDir = input(env, 'runDirectory') ? resolve(cwd, input(env, 'runDirectory')) : undefined;
  let runExit = 0;
  if (command === 'all' || command === 'run') {
    const args = ['run', ...splitArgv(input(env, 'journeys', '')), ...configArgs, '--reporter', 'html,json,junit'];
    if (input(env, 'tags')) args.push('--tags', input(env, 'tags'));
    let shard = input(env, 'shard', 'auto');
    if (shard === 'auto') {
      const i = Number(env.SYSTEM_JOBPOSITIONINPHASE);
      const n = Number(env.SYSTEM_TOTALJOBSINPHASE);
      shard = n > 1 && i >= 1 ? `${i}/${n}` : 'none';
    }
    if (shard !== 'none') {
      if (!/^\d+\/\d+$/.test(shard)) return finish(log, 'Failed', `shard must be auto, none or i/n (got ${shard})`);
      const help = await exec([...cli, 'run', '--help'], { cwd, env: childEnv, quiet: true });
      if (/--shard\b/.test(help.stdout)) args.push('--shard', shard);
      else {
        issues.push(`this EZTest version has no --shard; job ${shard} runs every journey`);
        log.cmd('task.logissue', { type: 'warning' }, issues[issues.length - 1]);
      }
    }
    args.push(...splitArgv(input(env, 'extraArgs', '')));
    log.out(`EZTest: ${args.join(' ')}`);
    const r = await eztest(args);
    runExit = r.code;
    const m = /^report json: (.+)$/m.exec(r.stdout);
    runDir = m ? resolve(cwd, m[1].trim(), '..') : newestRun(outDir);
    if (!runDir) return finish(log, 'Failed', `eztest run produced no run (exit ${r.code})`);
  } else if (command === 'merge') {
    const inputs = splitArgv(input(env, 'mergeInputs', ''));
    const r = await eztest(['merge', ...inputs, '--out', outDir]);
    if (r.code !== 0) {
      return finish(log, 'Failed', /unknown command/i.test(r.stdout) ? 'this EZTest version has no merge command (eztest merge)' : `eztest merge exited ${r.code}`);
    }
    runDir = newestRun(outDir);
  } else if (!runDir) runDir = newestRun(outDir);
  if (!runDir || !existsSync(join(runDir, 'run.json'))) return finish(log, 'Failed', `no EZTest run found in ${outDir}`);
  log.cmd('task.setvariable', { variable: 'EztestRunDir', isOutput: 'true' }, runDir);

  // ---------------------------------------------------------------- results tab, build summary, pipeline results, artifact
  if (command !== 'gate') {
    const s = await eztest(['ado', 'summary', runDir, '--journeys', splitArgv(input(env, 'journeys', '')).join(',') || 'journeys']);
    if (s.code === 0) {
      if (existsSync(join(runDir, 'eztest-tab.json'))) log.cmd('task.addattachment', { type: 'eztest.report', name: 'eztest-tab' }, join(runDir, 'eztest-tab.json'));
      if (existsSync(join(runDir, 'eztest-summary.md'))) log.cmd('task.uploadsummary', {}, join(runDir, 'eztest-summary.md'));
    } else issues.push('the run summary could not be written');
    if (bool(env, 'publishTestResults', true) && existsSync(join(runDir, 'junit.xml'))) {
      log.cmd('results.publish', { type: 'JUnit', mergeResults: 'true', runTitle: `EZTest ${input(env, 'environment', '')}`.trim(), resultFiles: join(runDir, 'junit.xml'), testRunSystem: 'EZTest' });
    }
    if (bool(env, 'evidencePack', false)) {
      const key = input(env, 'signingKey');
      if (!key) issues.push('evidencePack is on but no signingKey is set');
      else {
        const r = await eztest(['evidence', 'pack', runDir, '--key', key, '--signer', input(env, 'signer', env.BUILD_REQUESTEDFOR || 'pipeline')]);
        if (r.code !== 0) issues.push('the evidence pack could not be created');
      }
    }
    if (bool(env, 'publishArtifact', true)) {
      const job = (env.SYSTEM_JOBNAME || env.AGENT_JOBNAME || 'job').replace(/[^\w.-]+/g, '_');
      log.cmd('artifact.upload', { containerfolder: 'eztest', artifactname: `eztest-${input(env, 'environment', 'run')}-${job}` }, runDir);
    }

    // ---------------------------------------------------------------- Azure Test Plans
    if (bool(env, 'publishTestPlans', false)) {
      const args = ['ado', 'publish', runDir, ...configArgs];
      if (input(env, 'testPlanId')) args.push('--plan', input(env, 'testPlanId'));
      if (input(env, 'testSuiteId')) args.push('--suite', input(env, 'testSuiteId'));
      if (input(env, 'configuration')) args.push('--configuration', input(env, 'configuration'));
      if (bool(env, 'createBugs', false)) args.push('--create-bugs');
      if (bool(env, 'markFlaky', false)) args.push('--flaky');
      if (bool(env, 'commentRequirements', false)) args.push('--comment-requirements');
      if (existsSync(join(runDir, 'evidence-pack.zip'))) args.push('--evidence-pack', join(runDir, 'evidence-pack.zip'));
      args.push('--trace');
      const r = await eztest(args);
      if (r.code !== 0) {
        issues.push('publishing to Azure Test Plans failed');
        log.cmd('task.logissue', { type: 'warning' }, 'publishing to Azure Test Plans failed (see the log above)');
      }
    }

    // ---------------------------------------------------------------- pull request
    if (bool(env, 'prReport', true) && (env.SYSTEM_PULLREQUEST_PULLREQUESTID || env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER)) {
      const r = await eztest(['pr', 'report', runDir, ...configArgs, '--context', 'EZTest', '--on-risks', input(env, 'onRisks', 'warn') === 'fail' ? 'failure' : 'success']);
      if (r.code !== 0) issues.push('the pull request status and comment were not posted');
    }
  }

  // ---------------------------------------------------------------- readiness gate
  const rd = readiness(runDir);
  if (rd) log.cmd('task.setvariable', { variable: 'EztestDecision', isOutput: 'true' }, rd.decision);
  const onNoGo = input(env, 'onNoGo', 'fail');
  const onRisks = input(env, 'onRisks', 'warn');
  if (rd) {
    const g = await eztest(['ado', 'gate', runDir, '--on-no-go', onNoGo, '--on-risks', onRisks, '--on-missing', 'pass']);
    if (g.code !== 0) failed = `EZTest readiness is ${rd.decision} (score ${rd.score})`;
    else if ((rd.decision === 'NO_GO' && onNoGo === 'warn') || (rd.decision === 'GO_WITH_RISKS' && onRisks === 'warn')) issues.push(`EZTest readiness is ${rd.decision}`);
  } else {
    const s = runSummary(runDir);
    const bad = s ? s.failed + s.errors : runExit !== 0 ? 1 : 0;
    if (bad && bool(env, 'failOnTestFailure', true)) failed = `${bad} journey(s) failed`;
    else if (bad) issues.push(`${bad} journey(s) failed`);
  }
  if (failed) return finish(log, 'Failed', failed, runDir);
  return finish(log, issues.length ? 'SucceededWithIssues' : 'Succeeded', issues.join('; ') || 'EZTest passed', runDir);
}

function finish(log, result, message, runDir) {
  log.cmd('task.complete', { result }, message);
  return { result, message, runDir };
}

module.exports = { main, splitArgv, input, vsoEscape, newestRun };

if (require.main === module) {
  main().then(
    (r) => {
      process.exitCode = r.result === 'Failed' ? 1 : 0;
    },
    (e) => {
      process.stdout.write(`##vso[task.complete result=Failed;]${vsoEscape(e && e.message ? e.message : String(e))}\n`);
      process.exitCode = 1;
    },
  );
}
