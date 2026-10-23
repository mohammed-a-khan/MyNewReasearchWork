/**
 * Validate the extension: task.json against the official Azure Pipelines task
 * schema (schemas/tasks.schema.json, from microsoft/azure-pipelines-task-lib,
 * MIT) and vss-extension.json against schemas/vss-extension.schema.json; check
 * that every file and contribution the manifest names exists and that the
 * results tab declares the task it supports.
 * Usage: node scripts/validate.mjs   (exit 1 on problems)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
// ajv comes from the eztest package next to this directory.
const require = createRequire(join(here, '..', '..', 'package.json'));
const Ajv = require('ajv').default;

export function validateExtension(dir = here) {
  const problems = [];
  const read = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const taskSchema = read('schemas/tasks.schema.json');
  delete taskSchema.$schema;
  delete taskSchema.id;
  const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
  const manifest = read('vss-extension.json');
  const vExt = ajv.compile(read('schemas/vss-extension.schema.json'));
  if (!vExt(manifest)) for (const e of vExt.errors) problems.push(`vss-extension.json${e.instancePath}: ${e.message}`);
  const vTask = ajv.compile(taskSchema);
  const tasks = manifest.contributions.filter((c) => c.type === 'ms.vss-distributed-task.task');
  const taskIds = [];
  for (const t of tasks) {
    const p = join(t.properties.name, 'task.json');
    if (!existsSync(join(dir, p))) {
      problems.push(`${p} is missing`);
      continue;
    }
    const task = read(p);
    if (!vTask(task)) for (const e of vTask.errors) problems.push(`${p}${e.instancePath}: ${e.message}`);
    taskIds.push(task.id);
    for (const h of Object.values(task.execution ?? {})) if (!existsSync(join(dir, t.properties.name, h.target))) problems.push(`${t.properties.name}/${h.target} (execution target) is missing`);
    const names = new Set(task.inputs.map((i) => i.name));
    for (const i of task.inputs) {
      const rule = i.visibleRule && /^(\w+)\s*[=!]/.exec(i.visibleRule);
      if (rule && !names.has(rule[1])) problems.push(`${p}: input ${i.name} visibleRule names unknown input ${rule[1]}`);
      if (i.groupName && !(task.groups ?? []).some((g) => g.name === i.groupName)) problems.push(`${p}: input ${i.name} is in unknown group ${i.groupName}`);
    }
  }
  for (const f of manifest.files) if (!existsSync(join(dir, f.path))) problems.push(`files: ${f.path} does not exist`);
  if (manifest.icons?.default && !existsSync(join(dir, manifest.icons.default))) problems.push(`icon ${manifest.icons.default} does not exist`);
  if (manifest.content?.details?.path && !existsSync(join(dir, manifest.content.details.path))) problems.push(`${manifest.content.details.path} does not exist`);
  for (const c of manifest.contributions.filter((x) => x.type === 'ms.vss-build-web.build-results-tab')) {
    if (!existsSync(join(dir, c.properties.uri))) problems.push(`${c.id}: ${c.properties.uri} does not exist`);
    for (const id of c.properties.supportsTasks ?? []) if (!taskIds.includes(id)) problems.push(`${c.id}: supportsTasks names ${id}, which is not a task of this extension`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = validateExtension();
  for (const x of p) console.error(`invalid: ${x}`);
  console.log(p.length ? `${p.length} problem(s)` : 'extension manifest and task are valid');
  process.exitCode = p.length ? 1 : 0;
}
