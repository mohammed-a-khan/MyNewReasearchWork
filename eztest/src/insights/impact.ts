/**
 * Impact analysis: changed file paths -> impacted journeys, via a mapping
 * config (globs -> tags / journey ids / requirements). Changed files that no
 * mapping covers, or whose mapping selects no journey, are reported as
 * uncovered changed areas.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { globMatch, globToRegExp } from './glob.js';

export const ImpactMappingSchema = z.strictObject({
  mappings: z
    .array(
      z.strictObject({
        name: z.string().optional(),
        paths: z.array(z.string().min(1)).min(1),
        tags: z.array(z.string()).default([]),
        journeys: z.array(z.string()).default([]),
        requirements: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  /** Globs for files that never impact tests (docs, lockfiles...). */
  ignore: z.array(z.string()).default([]),
});
export type ImpactMapping = z.infer<typeof ImpactMappingSchema>;

export function parseImpactMapping(input: string | unknown): ImpactMapping {
  const raw = typeof input === 'string' ? parseYaml(input) : input;
  const r = ImpactMappingSchema.safeParse(raw);
  if (!r.success) {
    throw new EzTestError(`Invalid impact mapping: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'MAPPING_INVALID');
  }
  for (const m of r.data.mappings) for (const p of m.paths) globToRegExp(p); // validate early
  return r.data;
}

export async function loadImpactMapping(path: string): Promise<ImpactMapping> {
  return parseImpactMapping(await readFile(path, 'utf8'));
}

export interface ImpactJourney {
  id: string;
  name?: string;
  tags: string[];
  requirements: string[];
  risk: number;
}

export interface ImpactedJourney {
  journeyId: string;
  name?: string;
  score: number;
  risk: number;
  /** How the journey was selected. */
  via: Array<{ file: string; mapping: string; match: 'journey' | 'tag' | 'requirement'; value: string }>;
}

export interface ImpactResult {
  changedFiles: string[];
  ignoredFiles: string[];
  impacted: ImpactedJourney[];
  /** Changed files no mapping covers, or whose mappings select no journey. */
  uncovered: Array<{ file: string; reason: 'no-mapping' | 'mapping-selects-no-journey'; mappings?: string[] }>;
}

const MATCH_WEIGHT = { journey: 3, tag: 2, requirement: 1 } as const;

export function analyzeImpact(changedFiles: string[], journeys: ImpactJourney[], mappingIn: ImpactMapping | string): ImpactResult {
  const mapping = parseImpactMapping(mappingIn);
  const files = [...new Set(changedFiles.map((f) => f.trim().split('\\').join('/')).filter(Boolean))];
  if (files.length === 0) throw new EzTestError('analyzeImpact: no changed files given', 'INVALID_INPUT');
  if (journeys.length === 0) throw new EzTestError('analyzeImpact: no journeys given', 'INVALID_INPUT');
  const ignoredFiles = files.filter((f) => mapping.ignore.some((g) => globMatch(g, f)));
  const relevant = files.filter((f) => !ignoredFiles.includes(f));
  const byId = new Map(journeys.map((j) => [j.id, j]));
  const acc = new Map<string, ImpactedJourney>();
  const uncovered: ImpactResult['uncovered'] = [];

  const hit = (j: ImpactJourney, via: ImpactedJourney['via'][number]) => {
    const cur = acc.get(j.id) ?? { journeyId: j.id, name: j.name, score: 0, risk: j.risk, via: [] };
    if (!cur.via.some((v) => v.file === via.file && v.match === via.match && v.value === via.value)) {
      cur.via.push(via);
      cur.score += MATCH_WEIGHT[via.match] * j.risk;
    }
    acc.set(j.id, cur);
  };

  for (const file of relevant) {
    const ms = mapping.mappings.filter((m) => m.paths.some((p) => globMatch(p, file)));
    if (ms.length === 0) {
      uncovered.push({ file, reason: 'no-mapping' });
      continue;
    }
    let selected = 0;
    for (const m of ms) {
      const label = m.name ?? `mapping#${mapping.mappings.indexOf(m)}`;
      for (const id of m.journeys) {
        const j = byId.get(id);
        if (j) {
          hit(j, { file, mapping: label, match: 'journey', value: id });
          selected++;
        }
      }
      for (const tag of m.tags) {
        for (const j of journeys) {
          if (j.tags.includes(tag)) {
            hit(j, { file, mapping: label, match: 'tag', value: tag });
            selected++;
          }
        }
      }
      for (const req of m.requirements) {
        for (const j of journeys) {
          if (j.requirements.includes(req)) {
            hit(j, { file, mapping: label, match: 'requirement', value: req });
            selected++;
          }
        }
      }
    }
    if (selected === 0) uncovered.push({ file, reason: 'mapping-selects-no-journey', mappings: ms.map((m) => m.name ?? m.paths.join(',')) });
  }

  const impacted = [...acc.values()].sort((a, b) => b.score - a.score || b.risk - a.risk || a.journeyId.localeCompare(b.journeyId));
  return { changedFiles: files, ignoredFiles, impacted, uncovered };
}

const SAFE_REF = /^[A-Za-z0-9._\/@{}^~-]+$/;

/** `git diff --name-only <base>...<head>` via spawn with an args array (never a shell string). */
export function changedFilesFromGit(opts: { cwd: string; base: string; head?: string; timeoutMs?: number }): Promise<string[]> {
  const head = opts.head ?? 'HEAD';
  for (const ref of [opts.base, head]) {
    if (!ref || ref.startsWith('-') || !SAFE_REF.test(ref)) throw new EzTestError(`Unsafe git ref: ${ref}`, 'INVALID_INPUT');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--name-only', '--no-renames', `${opts.base}...${head}`, '--'], {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new EzTestError(`git failed to start: ${e.message}`, 'GIT_FAILED'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new EzTestError(`git diff exited ${code}: ${err.trim().slice(0, 300)}`, 'GIT_FAILED'));
      else resolve(out.split('\n').map((l) => l.trim()).filter(Boolean));
    });
  });
}
