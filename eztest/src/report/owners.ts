/** Journey files and CODEOWNERS owners per test, for the report's suite tree, owner facet and failing-test owners. */
import { relative, sep } from 'node:path';
import type { Journey } from '../core/index.js';
import { loadCodeowners, ownersOf } from '../git/codeowners.js';
import { GitRepo } from '../git/repo.js';

export interface JourneyFilesAndOwners {
  /** journey id -> file path relative to the repository (or the project) root. */
  files: Record<string, string>;
  /** journey id -> CODEOWNERS owners ("@team", "alice@x"). */
  owners: Record<string, string[]>;
}

/** The file a journey was loaded from (its first step's source, or the code journey module). */
export function journeyFile(j: Journey): string | undefined {
  return j.steps.find((s) => s.source?.file)?.source?.file ?? j.code?.file;
}

export async function journeyFilesAndOwners(journeys: Journey[], cwd: string): Promise<JourneyFilesAndOwners> {
  let root = cwd;
  let repo = false;
  try {
    root = (await GitRepo.open(cwd)).root;
    repo = true;
  } catch {
    // not a git checkout: paths relative to the project
  }
  const co = repo ? await loadCodeowners(root).catch(() => undefined) : undefined;
  const files: Record<string, string> = {};
  const owners: Record<string, string[]> = {};
  for (const j of journeys) {
    const f = journeyFile(j);
    if (!f) continue;
    const rel = relative(root, f).split(sep).join('/');
    if (rel.startsWith('..')) continue;
    files[j.id] = rel;
    if (co?.rules.length) {
      const o = ownersOf(co, rel).map((x) => x.raw);
      if (o.length) owners[j.id] = o;
    }
  }
  return { files, owners };
}
