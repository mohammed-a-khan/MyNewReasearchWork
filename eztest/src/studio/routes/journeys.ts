/**
 * Journey authoring routes: list, read, save, create, rename and delete
 * journey files; validate, convert, format; grammar, hover explanations,
 * the autocomplete vocabulary, the visual step model and the problems index.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { convertText, formatOf, grammar, journeyTemplate, listJourneys, validateText } from '../authoring.js';
import { HttpError, fmt, sendError, sendJson, str } from '../http.js';
import { explainLine, formatText, vocabulary } from '../language.js';
import { applySteps, journeyModel, type StepEdit } from '../model.js';
import { validateCode } from '../code.js';
import type { StudioRoute } from './route.js';

function formatParam(body: Record<string, unknown>): ReturnType<typeof fmt> {
  return body.format !== undefined ? fmt(body.format, 'format') : typeof body.path === 'string' ? formatOf(body.path) : 'ez';
}

export const journeyRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/journeys',
    summary: 'Journey files with metadata',
    async handler({ res, app }) {
      const journeysDir = await app.journeysDir();
      sendJson(res, 200, { journeysDir, journeys: await listJourneys(app.cwd, journeysDir) });
    },
  },
  {
    method: 'GET',
    path: '/api/file',
    summary: 'Read a journey file',
    async handler({ res, app, query }) {
      const abs = await app.journeyPath(query.get('path'));
      if (!existsSync(abs)) return sendError(res, 404, 'File not found');
      sendJson(res, 200, { path: app.rel(abs), format: formatOf(abs), content: await readFile(abs, 'utf8') });
    },
  },
  {
    method: 'PUT',
    path: '/api/file',
    summary: 'Save a journey file (create: true refuses to overwrite)',
    async handler({ res, app, body }) {
      const abs = await app.journeyPath(body.path);
      const content = str(body.content, 'content');
      if (body.create === true && existsSync(abs)) return sendError(res, 409, 'A file with this name already exists');
      await mkdir(dirname(abs), { recursive: true });
      app.confine(relative(app.cwd, abs)); // re-check after creating directories
      await writeFile(abs, content);
      const v = formatOf(abs) === 'ts' ? await validateCode(content, abs) : validateText(content, formatOf(abs));
      sendJson(res, 200, { saved: app.rel(abs), validation: v });
    },
  },
  {
    method: 'DELETE',
    path: '/api/file',
    summary: 'Delete a journey file',
    async handler({ res, app, body }) {
      const abs = await app.journeyPath(body.path);
      if (!existsSync(abs)) return sendError(res, 404, 'File not found');
      await rm(abs);
      sendJson(res, 200, { deleted: app.rel(abs) });
    },
  },
  {
    method: 'POST',
    path: '/api/file/rename',
    summary: 'Rename or move a journey file',
    async handler({ res, app, body }) {
      const from = await app.journeyPath(body.from);
      const to = await app.journeyPath(body.to);
      if (!existsSync(from)) return sendError(res, 404, 'File not found');
      if (existsSync(to)) return sendError(res, 409, 'A file with this name already exists');
      await mkdir(dirname(to), { recursive: true });
      app.confine(relative(app.cwd, to));
      await rename(from, to);
      sendJson(res, 200, { from: app.rel(from), to: app.rel(to) });
    },
  },
  {
    method: 'POST',
    path: '/api/journeys',
    summary: 'Create a journey from the template',
    async handler({ res, app, body }) {
      const abs = await app.journeyPath(body.path);
      if (existsSync(abs)) return sendError(res, 409, 'A file with this name already exists');
      const content = journeyTemplate(typeof body.name === 'string' ? body.name : 'New journey', formatOf(abs));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      sendJson(res, 201, { path: app.rel(abs), content });
    },
  },
  {
    method: 'POST',
    path: '/api/validate',
    summary: 'Validate journey text (every bad line, with suggestions)',
    async handler({ res, body }) {
      const format = formatParam(body);
      const content = str(body.content, 'content');
      sendJson(res, 200, format === 'ts' ? await validateCode(content, typeof body.path === 'string' ? body.path : 'file.ts') : validateText(content, format));
    },
  },
  {
    method: 'POST',
    path: '/api/convert',
    summary: 'Convert journey text between ez, yaml and json',
    handler({ res, body }) {
      const content = str(body.content, 'content');
      const from = fmt(body.from, 'from');
      const to = fmt(body.to, 'to');
      try {
        sendJson(res, 200, { content: convertText(content, from, to) });
      } catch (e) {
        sendError(res, 422, `Cannot convert: ${(e as Error).message}`);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/format',
    summary: 'Tidy journey text (comments are kept)',
    handler({ res, body }) {
      try {
        sendJson(res, 200, { content: formatText(str(body.content, 'content'), formatParam(body)) });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        sendError(res, 422, `Cannot format: ${(e as Error).message}`);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/grammar',
    summary: 'Phrasings grouped by category',
    handler({ res }) {
      sendJson(res, 200, { groups: grammar() });
    },
  },
  {
    method: 'POST',
    path: '/api/explain',
    summary: 'Explain one .ez line (hover docs)',
    handler({ res, body }) {
      sendJson(res, 200, explainLine(str(body.line, 'line')));
    },
  },
  {
    method: 'GET',
    path: '/api/vocabulary',
    summary: 'Roles, connections, documents, entities, tags and variables for autocomplete',
    async handler({ res, app }) {
      let config: Record<string, unknown> | undefined;
      try {
        config = (await app.config()).config as unknown as Record<string, unknown>;
      } catch {
        config = undefined;
      }
      sendJson(res, 200, await vocabulary(app.cwd, await app.journeysDir(), config));
    },
  },
  {
    method: 'POST',
    path: '/api/model',
    summary: 'Structured step cards for the visual step view',
    handler({ res, body }) {
      sendJson(res, 200, journeyModel(str(body.content, 'content'), formatParam(body)));
    },
  },
  {
    method: 'POST',
    path: '/api/model/apply',
    summary: 'Apply an edited step list and return the new file text',
    handler({ res, body }) {
      const steps = body.steps as StepEdit[];
      sendJson(res, 200, applySteps(str(body.content, 'content'), formatParam(body), steps));
    },
  },
  {
    method: 'GET',
    path: '/api/problems',
    summary: 'Validation problems across all journeys (kept live by the file watcher)',
    async handler({ res, app }) {
      sendJson(res, 200, { files: await app.problems() });
    },
  },
];
