/** Routing JSON/YAML files to the OpenAPI and Postman importers (used by importFiles). */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { importOpenApi, looksLikeOpenApi, specRefFrom } from './openapi.js';
import { importPostman, looksLikePostman } from './postman.js';
import type { ImportKind, ImportReport } from './types.js';

export function isApiSpecPath(path: string): boolean {
  return ['.json', '.yaml', '.yml'].includes(extname(path).toLowerCase());
}

export function detectApiKind(text: string): 'openapi' | 'postman' | undefined {
  if (looksLikePostman(text)) return 'postman';
  if (looksLikeOpenApi(text)) return 'openapi';
  return undefined;
}

export async function importApiFile(
  path: string,
  text: string,
  o: { file: string; ids: Set<string>; cwd: string; kind?: ImportKind; explicit: boolean; tags?: string[]; role?: string; environment?: string },
): Promise<ImportReport | undefined> {
  const kind = o.kind === 'openapi' || o.kind === 'postman' ? o.kind : detectApiKind(text);
  if (!kind) {
    if (!o.explicit) return undefined;
    return { journeys: [], converted: [], todo: [], warnings: [`${o.file}: not an OpenAPI/Swagger document or Postman collection; skipped`], coverage: { sourceSteps: 0, convertedSteps: 0, assertions: 0, convertedAssertions: 0 }, files: [o.file] };
  }
  if (kind === 'openapi') return importOpenApi(text, { file: o.file, ids: o.ids, ...(o.tags ? { tags: o.tags } : {}), ...(o.role ? { role: o.role } : {}), specRef: specRefFrom(path, undefined, o.cwd), absPath: resolve(path) });
  const environment = o.environment ? (JSON.parse(await readFile(resolve(o.cwd, o.environment), 'utf8')) as unknown) : undefined;
  return importPostman(text, { file: o.file, ids: o.ids, ...(o.tags ? { tags: o.tags } : {}), ...(environment ? { environment } : {}) });
}
