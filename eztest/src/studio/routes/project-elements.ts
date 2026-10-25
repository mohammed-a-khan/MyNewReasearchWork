/**
 * Project › Elements: the shared element repository (elements/*.yaml and
 * configured TypeScript screens) with every element's locators, where it is
 * defined, and its usages across journeys (by @reference or by description) and code (screen model entries and
 * @references in code journeys, step definitions and screens),
 * plus unused elements, references to unknown elements, likely duplicates and
 * problems found while loading.
 */
import { loadJourneys } from '../../cli/journeys.js';
import { duplicateElements, elementUsages } from '../../elements/bind.js';
import { mergeUsages, projectCodeUsages } from '../../elements/code-usages.js';
import { describeCandidate } from '../../runner/locate.js';
import { studioElements } from '../quality/heals.js';
import { sendJson } from '../http.js';
import type { StudioRoute } from './route.js';

export const elementRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/elements',
    summary: 'Shared element repository: elements, locators, usages per element, unused, unknown references, duplicates',
    async handler({ res, app }) {
      const cfg = (await app.config()).config;
      const repo = await studioElements(app);
      const { journeys, errors } = await loadJourneys([cfg.journeysDir], app.cwd).catch((e: Error) => ({ journeys: [], errors: [{ file: cfg.journeysDir, message: e.message }] }));
      const usages = mergeUsages(elementUsages(journeys, repo), await projectCodeUsages(app.cwd, cfg, repo));
      const elements = repo.list().map((e) => ({
        id: e.id, screen: e.screen, key: e.key, description: e.description, aliases: e.aliases, file: e.file, line: e.line, source: e.source,
        locators: e.locators.map(describeCandidate), hasFingerprint: !!e.fingerprint,
        usages: usages.get(e.id) ?? [],
      }));
      sendJson(res, 200, {
        dir: cfg.elements?.dir ?? 'elements',
        elements,
        unused: elements.filter((e) => !e.usages.length).map((e) => e.id),
        unknown: [...usages.keys()].filter((id) => !repo.get(id)).sort().map((id) => ({ id, usages: usages.get(id) })),
        duplicates: duplicateElements(repo),
        problems: [...repo.problems, ...errors],
      });
    },
  },
];
