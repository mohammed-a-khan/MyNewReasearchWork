/**
 * Document templates (YAML or JSON): which fields to read by label/regex and
 * which tables to find by their header row. Templates are pure data; regular
 * expressions are compiled with RegExp, never evaluated as code.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import type { CanonicalDocument } from './model.js';
import type { NumberLocale } from './normalize.js';
import { extractFields } from './fields.js';
import { extractTables } from './tables.js';

export const ValueTypeSchema = z.enum(['text', 'number', 'currency', 'date', 'percent']);

export const FieldSpecSchema = z
  .object({
    name: z.string().min(1),
    /** Printed label (or aliases) that anchors the value, e.g. "Invoice No". A trailing colon is optional. */
    label: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Alternative to label: a regex run on each line; the named group "value" (or group 1) is the value. */
    regex: z.string().min(1).optional(),
    flags: z.string().regex(/^[imsu]*$/).optional(),
    readFrom: z.enum(['right', 'below', 'auto']).default('auto'),
    type: ValueTypeSchema.default('text'),
    required: z.boolean().default(true),
    page: z.number().int().positive().optional(),
    occurrence: z.enum(['first', 'last']).default('first'),
    /** Minimum label similarity (0..1) for a fuzzy label match when no exact match exists. */
    fuzzy: z.number().min(0).max(1).default(0.85),
    dateFormats: z.array(z.string()).optional(),
  })
  .refine((f) => f.label !== undefined || f.regex !== undefined, { message: 'a field needs "label" or "regex"' });
export type FieldSpec = z.infer<typeof FieldSpecSchema>;
export type FieldSpecInput = z.input<typeof FieldSpecSchema>;

export const TableColumnSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    /** Header text (or aliases) as printed; defaults to name. */
    header: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    type: ValueTypeSchema.default('text'),
    required: z.boolean().default(true),
  }),
]);
export type TableColumnInput = z.input<typeof TableColumnSchema>;

export const TableSpecSchema = z.object({
  name: z.string().min(1),
  columns: z.array(TableColumnSchema).min(1),
  /** Key column(s); also the "anchor" columns used to tell a new row from a wrapped continuation line. */
  key: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  /** Regex on the line text that ends the table (e.g. "^Notes"). */
  terminator: z.string().optional(),
  totalPattern: z.string().default('^(grand\\s+)?total\\b'),
  subtotalPattern: z.string().default('^sub-?\\s?total\\b'),
  /** A grand-total row ends the table unless this is set. */
  continueAfterTotal: z.boolean().default(false),
  /** Header fuzzy match threshold 0..1 (case-insensitive). */
  headerThreshold: z.number().min(0).max(1).default(0.8),
  /** Minimum header columns that must match; default = all required columns. */
  minHeaderColumns: z.number().int().positive().optional(),
  stitchWrapped: z.boolean().default(true),
  /** A vertical gap larger than this (in font-size units) ends the table on the current page. */
  maxRowGapEm: z.number().positive().default(3.5),
  continueAcrossPages: z.boolean().default(true),
  required: z.boolean().default(true),
});
export type TableSpec = z.infer<typeof TableSpecSchema>;
export type TableSpecInput = z.input<typeof TableSpecSchema>;

export const DocTemplateSchema = z.object({
  name: z.string().optional(),
  locale: z.enum(['en', 'de', 'fr', 'auto']).optional(),
  dateFormats: z.array(z.string()).optional(),
  fields: z.array(FieldSpecSchema).default([]),
  tables: z.array(TableSpecSchema).default([]),
});
export type DocTemplate = z.infer<typeof DocTemplateSchema>;
export type DocTemplateInput = z.input<typeof DocTemplateSchema>;

/** Parse and validate a template given as YAML/JSON text or as an object. */
export function parseTemplate(input: string | DocTemplateInput): DocTemplate {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = parseYaml(input);
    } catch (e) {
      throw new EzTestError(`Template is not valid YAML/JSON: ${(e as Error).message}`, 'TEMPLATE_INVALID');
    }
  }
  const r = DocTemplateSchema.safeParse(data);
  if (!r.success) {
    throw new EzTestError(
      `Invalid document template: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      'TEMPLATE_INVALID',
    );
  }
  for (const f of r.data.fields) {
    if (f.regex) compileUserRegex(f.regex, f.flags ?? '', `field ${f.name}`);
  }
  for (const t of r.data.tables) {
    if (t.terminator) compileUserRegex(t.terminator, 'i', `table ${t.name} terminator`);
    compileUserRegex(t.totalPattern, 'i', `table ${t.name} totalPattern`);
    compileUserRegex(t.subtotalPattern, 'i', `table ${t.name} subtotalPattern`);
  }
  return r.data;
}

export function compileUserRegex(src: string, flags: string, what: string): RegExp {
  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw new EzTestError(`Invalid regex for ${what}: ${(e as Error).message}`, 'TEMPLATE_INVALID');
  }
}

/** Run a template's field and table specs on a document; results and findings are stored on the document. */
export function applyTemplate(
  doc: CanonicalDocument,
  template: DocTemplate | DocTemplateInput,
  ctx: { locale?: NumberLocale; dateFormats?: string[] } = {},
): CanonicalDocument {
  const tpl = parseTemplate(template as DocTemplateInput);
  const locale = ctx.locale ?? tpl.locale ?? 'auto';
  const dateFormats = ctx.dateFormats ?? tpl.dateFormats;
  if (tpl.fields.length === 0 && tpl.tables.length === 0) {
    doc.findings.push({ code: 'TEMPLATE_EMPTY', severity: 'error', message: 'Template defines no fields and no tables.' });
    return doc;
  }
  const f = extractFields(doc, tpl.fields, { locale, dateFormats });
  const t = extractTables(doc, tpl.tables, { locale, dateFormats });
  doc.fields = f.fields;
  doc.tables = t.tables;
  doc.findings.push(...f.findings, ...t.findings);
  return doc;
}
