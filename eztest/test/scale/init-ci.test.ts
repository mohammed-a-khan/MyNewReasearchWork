/**
 * `eztest init --ci <system>`: every system gets a PR smoke job, a scheduled
 * nightly regression in parallel shards merged into one run, an on-deploy job
 * per environment, JUnit results in the system's test view, the HTML report as
 * an artifact and the readiness gate. Each file is validated offline as far as
 * possible (YAML parse with unique keys and resolved anchors; a structural
 * check of the Jenkinsfile and the Kotlin DSL) and compared with a snapshot
 * (EZTEST_UPDATE_SNAPSHOTS=1 rewrites them).
 */
import { describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument } from 'yaml';
import { CI_SYSTEMS, initProject } from '../../src/cli/init.js';
import { CI_TEMPLATES } from '../../src/cli/ci-templates.js';
import { loadConfig } from '../../src/config/index.js';
import { tempDir } from '../runner/fixtures.js';

const SNAPSHOTS = fileURLToPath(new URL('./__snapshots__/ci/', import.meta.url));

async function snapshot(system: string, rel: string, content: string): Promise<void> {
  const file = join(SNAPSHOTS, system, rel.replace(/^\./, '_'));
  if (process.env.EZTEST_UPDATE_SNAPSHOTS === '1' || !existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  expect(content).toBe(await readFile(file, 'utf8'));
}

function yamlOf(text: string): any {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('\n'));
  return parse(text, { maxAliasCount: 100 });
}

/** Braces, brackets and parentheses balance outside strings and comments (Groovy / Kotlin). */
function balanced(src: string): void {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (c === '\n') line++;
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i = src.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (three === "'''" || three === '"""') {
      const end = src.indexOf(three, i + 3);
      if (end < 0) throw new Error(`unterminated ${three} at line ${line}`);
      line += src.slice(i, end).split('\n').length - 1;
      i = end + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') throw new Error(`unterminated string at line ${line}`);
        j++;
      }
      i = j + 1;
      continue;
    }
    if ('([{'.includes(c)) stack.push(c);
    else if (')]}'.includes(c)) {
      if (stack.pop() !== pairs[c]) throw new Error(`unbalanced "${c}" at line ${line}`);
    }
    i++;
  }
  if (stack.length) throw new Error(`unclosed ${stack.join('')}`);
}

const pipelinesIn = (text: string) => [...new Set([...text.matchAll(/--pipeline (?:<< parameters\.environment >>)?([\w-]+(?:<< parameters\.environment >>)?)/g)].map((m) => m[1]))];

describe('eztest init --ci', () => {
  it('writes a pipelines: block the CI files rely on, and the config loads', async () => {
    const dir = await tempDir('init-pipelines');
    await initProject(dir, {});
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    expect(loaded.config.configVersion).toBe(1);
    expect(Object.keys(loaded.config.pipelines)).toEqual(['pr', 'nightly', 'deploy-sit', 'deploy-uat']);
    expect(loaded.config.pipelines['deploy-uat'].requires).toEqual(['deploy-sit']);
    for (const s of CI_SYSTEMS) {
      for (const [, text] of CI_TEMPLATES[s]) {
        for (const p of pipelinesIn(text)) {
          const name = p.includes('<<') ? null : p;
          if (name) expect(Object.keys(loaded.config.pipelines)).toContain(name);
        }
      }
    }
  });

  it('GitHub Actions: PR smoke, scheduled duration-balanced shards merged and gated, deploy jobs per environment', async () => {
    const dir = await tempDir('init-gh');
    await initProject(dir, { ci: 'github' });
    const text = await readFile(join(dir, '.github/workflows/eztest.yml'), 'utf8');
    await snapshot('github', '.github/workflows/eztest.yml', text);
    const wf = yamlOf(text);
    expect(Object.keys(wf.jobs)).toEqual(['smoke', 'plan', 'test', 'merge', 'deploy-sit', 'deploy-uat']);
    expect(wf.on.schedule).toEqual([{ cron: '0 2 * * *' }]);
    expect(text).toMatch(/Schedules run in UTC on GitHub/);
    expect(Object.keys(wf.on)).toEqual(['pull_request', 'schedule', 'workflow_dispatch', 'workflow_call']);
    const steps = (job: string) => wf.jobs[job].steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(wf.jobs.smoke.if).toBe("github.event_name == 'pull_request'");
    expect(steps('smoke')).toMatch(/eztest run --reporter html,json,junit --pipeline pr/);
    expect(steps('smoke')).toMatch(/eztest ci summary .* >> "\$GITHUB_STEP_SUMMARY"/);
    expect(steps('plan')).toMatch(/eztest ci matrix --shards auto/);
    expect(wf.jobs.test.strategy.matrix).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    expect(steps('test')).toMatch(/eztest run --pipeline nightly --shard \$\{\{ matrix.shard \}\}/);
    expect(steps('merge')).toMatch(/eztest merge shards -o eztest-results\/merged --reporter html,json,junit/);
    expect(steps('merge')).toMatch(/eztest evidence verify/);
    expect(steps('merge')).toMatch(/eztest publish eztest-results\/merged/);
    expect(steps('merge')).toMatch(/eztest gate eztest-results\/merged --on-no-go fail/);
    expect(wf.jobs['deploy-sit'].environment).toBe('sit');
    expect(steps('deploy-sit')).toMatch(/--pipeline deploy-sit/);
    expect(wf.jobs['deploy-uat'].environment).toBe('uat');
    expect(JSON.stringify(wf.jobs.merge.steps)).toMatch(/upload-artifact/);
  });

  it('Azure Pipelines: schedules, a PR smoke stage, the regression stage with an output-variable matrix, deployment jobs per environment', async () => {
    const dir = await tempDir('init-az');
    await initProject(dir, { ci: 'azure' });
    const text = await readFile(join(dir, 'azure-pipelines.yml'), 'utf8');
    await snapshot('azure', 'azure-pipelines.yml', text);
    const p = yamlOf(text);
    expect(p.schedules).toEqual([{ cron: '0 2 * * *', displayName: 'Nightly regression (02:00 UTC)', branches: { include: ['main'] }, always: true }]);
    expect(p.stages.map((s: { stage: string }) => s.stage)).toEqual(['Smoke', 'Regression', 'DeploySIT', 'TestSIT', 'DeployUAT', 'TestUAT']);
    const reg = p.stages[1];
    expect(reg.jobs.map((j: { job: string }) => j.job)).toEqual(['plan', 'test', 'merge']);
    expect(reg.jobs[1].strategy.matrix).toBe("$[ dependencies.plan.outputs['m.matrix'] ]");
    expect(JSON.stringify(reg.jobs[2].steps)).toMatch(/eztest merge shards.*eztest publish.*PublishTestResults@2.*eztest gate eztest-results\/merged --on-no-go fail/);
    const testSit = p.stages[3];
    expect(testSit.dependsOn).toBe('DeploySIT');
    expect(testSit.jobs[0]).toMatchObject({ deployment: 'eztest', environment: 'sit' });
    const sitSteps = testSit.jobs[0].strategy.runOnce.deploy.steps;
    expect(sitSteps.find((s: { name?: string }) => s.name === 'eztest').script).toMatch(/--pipeline deploy-sit/);
    expect(JSON.stringify(sitSteps)).toMatch(/PublishTestResults@2.*PublishPipelineArtifact@1/);
    expect(p.stages[0].condition).toBe("eq(variables['Build.Reason'], 'PullRequest')");
  });

  it('GitLab CI/CD: merge request smoke, scheduled parallel shards and merge, environments with verify jobs', async () => {
    const dir = await tempDir('init-gl');
    await initProject(dir, { ci: 'gitlab' });
    const text = await readFile(join(dir, '.gitlab-ci.yml'), 'utf8');
    await snapshot('gitlab', '.gitlab-ci.yml', text);
    const g = yamlOf(text);
    expect(g.stages).toEqual(['test', 'merge', 'deploy-sit', 'test-sit', 'deploy-uat', 'test-uat']);
    expect(g['eztest:smoke'].rules[0].if).toBe('$CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(g['eztest:regression']).toMatchObject({ parallel: 4, rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }] });
    expect(g['eztest:merge'].needs).toEqual(['eztest:regression']);
    expect(g['eztest:merge'].script.join('\n')).toMatch(/eztest gate eztest-results\/merged --on-no-go fail/);
    expect(g['eztest:merge'].artifacts.reports.junit).toBe('eztest-results/**/junit.xml');
    expect(g['eztest:sit']).toMatchObject({ needs: ['deploy:sit'], environment: { name: 'sit', action: 'verify' } });
    expect(g['eztest:uat'].script.join('\n')).toMatch(/--pipeline deploy-uat/);
    expect(text).toMatch(/pick the time zone/);
  });

  it('Jenkins: a declarative pipeline with a cron trigger (time zone), parallel shards, junit, archive and the gate', async () => {
    const dir = await tempDir('init-jk');
    await initProject(dir, { ci: 'jenkins' });
    const text = await readFile(join(dir, 'Jenkinsfile'), 'utf8');
    await snapshot('jenkins', 'Jenkinsfile', text);
    balanced(text);
    expect(text).toMatch(/^pipeline \{$/m);
    for (const section of ['agent', 'options', 'triggers', 'environment', 'stages']) expect(text).toMatch(new RegExp(`^  ${section} `, 'm'));
    expect(text).toMatch(/cron\('''TZ=UTC\nH 2 \* \* \*'''\)/);
    const stages = [...text.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(stages).toEqual(['Smoke', 'Regression', 'Shards', 'Shard 1/4', 'Shard 2/4', 'Shard 3/4', 'Shard 4/4', 'Merge', 'Deploy SIT', 'Test SIT', 'Deploy UAT', 'Test UAT']);
    expect(text).toMatch(/when \{ changeRequest\(\) \}/);
    expect(text).toMatch(/when \{ triggeredBy 'TimerTrigger' \}/);
    expect(text).toMatch(/parallel \{/);
    expect(text.match(/junit allowEmptyResults: true/g)!.length).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/archiveArtifacts/);
    expect(text).toMatch(/npx eztest gate eztest-results\/merged --on-no-go fail/);
    expect(text).toMatch(/--pipeline deploy-sit/);
    expect(() => balanced('pipeline { stage("x") { ')).toThrow(/unclosed/);
  });

  it('TeamCity: Kotlin DSL with a scheduled trigger (time zone), shard configurations, JUnit report processing and deployments', async () => {
    const dir = await tempDir('init-tc');
    await initProject(dir, { ci: 'teamcity' });
    const text = await readFile(join(dir, '.teamcity/settings.kts'), 'utf8');
    await snapshot('teamcity', '.teamcity/settings.kts', text);
    balanced(text);
    expect(text).toMatch(/^import jetbrains\.buildServer\.configs\.kotlin\.\*$/m);
    expect(text).toMatch(/^version = "\d{4}\.\d{2}"$/m);
    const used = [...text.matchAll(/buildType\((\w+)\)/g)].map((m) => m[1]).filter((u) => u !== 'it');
    for (const u of used) expect(text).toMatch(new RegExp(`^object ${u} : BuildType\\(\\{`, 'm'));
    expect(text.indexOf('val shards')).toBeLessThan(text.indexOf('project {'));
    expect(text).toMatch(/schedulingPolicy = daily \{\s+hour = 2\s+timezone = "UTC"/);
    expect(text).toMatch(/reportType = XmlReport\.XmlReportType\.JUNIT/);
    expect(text).toMatch(/type = BuildTypeSettings\.Type\.DEPLOYMENT/);
    expect(text).toMatch(/--shard \$i\/4/);
    expect(text).toMatch(/eztest gate eztest-results\/merged --on-no-go fail/);
    for (const imp of [...text.matchAll(/^import (.+)$/gm)].map((m) => m[1].split('.').pop()!)) if (imp !== '*') expect(text.split(imp).length).toBeGreaterThan(2);
  });

  it('Bitbucket Pipelines: pull requests, a custom nightly with parallel steps, deployments with test-results', async () => {
    const dir = await tempDir('init-bb');
    await initProject(dir, { ci: 'bitbucket' });
    const text = await readFile(join(dir, 'bitbucket-pipelines.yml'), 'utf8');
    await snapshot('bitbucket', 'bitbucket-pipelines.yml', text);
    const b = yamlOf(text);
    expect(Object.keys(b.pipelines)).toEqual(['pull-requests', 'custom', 'branches']);
    expect(b.pipelines.custom.nightly[0].parallel).toHaveLength(4);
    expect(b.pipelines.custom.nightly[0].parallel[0].step.name).toBe('EZTest shard');
    expect(b.pipelines.custom.nightly[1].step.script.join('\n')).toMatch(/eztest merge shards.*\n.*\n.*test-results.*\n.*eztest gate/);
    expect(b.pipelines.branches.main.map((s: { step: { deployment?: string } }) => s.step.deployment).filter(Boolean)).toEqual(['sit', 'uat']);
    expect(text).toMatch(/Schedules: Daily, 02:00/);
  });

  it('CircleCI: a PR workflow, a nightly scheduled trigger with parallelism, deploy workflow with approval', async () => {
    const dir = await tempDir('init-cc');
    await initProject(dir, { ci: 'circleci' });
    const text = await readFile(join(dir, '.circleci/config.yml'), 'utf8');
    await snapshot('circleci', '.circleci/config.yml', text);
    const c = yamlOf(text);
    expect(c.version).toBe(2.1);
    expect(c.jobs.shard.parallelism).toBe(4);
    expect(c.workflows.nightly.triggers[0].schedule.cron).toBe('0 2 * * *');
    expect(c.workflows.deploy.jobs.map((j: Record<string, { name?: string }>) => Object.values(j)[0].name ?? Object.keys(j)[0])).toEqual(['deploy-sit', 'eztest-sit', 'approve-uat', 'deploy-uat', 'eztest-uat']);
    expect(JSON.stringify(c.commands.results)).toMatch(/store_test_results.*store_artifacts/);
    expect(c.jobs.merge.steps.map((s: unknown) => JSON.stringify(s)).join('\n')).toMatch(/eztest gate eztest-results\/merged --on-no-go fail/);
    // EZTest splits the shards itself: no CircleCI test splitting command.
    expect(text).not.toMatch(/^\s*(?:- )?(?:run|command):.*circleci tests split/m);
  });

  it('never overwrites an existing pipeline file', async () => {
    const dir = await tempDir('init-keep');
    await writeFile(join(dir, 'Jenkinsfile'), 'mine');
    const r = await initProject(dir, { ci: 'jenkins' });
    expect(r.skipped).toContain('Jenkinsfile');
    expect(await readFile(join(dir, 'Jenkinsfile'), 'utf8')).toBe('mine');
  });
});
