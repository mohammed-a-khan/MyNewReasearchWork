/** Write elements as an `elements/<Screen>.yaml` file (used by `eztest elements import-screens`). */
import YAML from 'yaml';
import { locatorToString } from './heal.js';
import type { RepoElement } from './repository.js';

export function renderElementFile(screen: string, elements: RepoElement[], header?: string): string {
  const doc = new YAML.Document({
    screen,
    elements: Object.fromEntries(elements.map((e) => [e.key, {
      description: e.description,
      locators: e.locators.map((l) => locatorToString(l) ?? { ...l }),
      ...(e.aliases.length ? { aliases: e.aliases } : {}),
      ...(e.frames?.length ? { frames: e.frames } : {}),
    }])),
  });
  if (header) doc.commentBefore = ` ${header}`;
  return doc.toString();
}
