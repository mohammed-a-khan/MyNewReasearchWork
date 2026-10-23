/**
 * Field extraction: label anchors ("Invoice No:" -> value to the right or
 * below) and regex specs, producing typed DocFields with provenance.
 */
import type { CanonicalDocument, DocField, DocFinding, DocValue, Line, Segment, ValueType } from './model.js';
import { unionBBox } from './model.js';
import { escapeRe, foldText, normalizeValue, similarity, type NumberLocale } from './normalize.js';
import { compileUserRegex, FieldSpecSchema, type FieldSpec, type FieldSpecInput } from './template.js';

export interface FieldContext {
  locale?: NumberLocale;
  dateFormats?: string[];
}

interface Candidate {
  raw: string;
  page: number;
  bbox: DocValue['bbox'];
  confidence: number;
  label?: string;
}

/** True when a normalized value has the shape a declared type expects. */
export function typeMatches(type: ValueType, kind: string): boolean {
  if (type === 'text') return true;
  if (type === 'date') return kind === 'date';
  return kind === 'number';
}

export function makeValue(
  raw: string,
  type: ValueType,
  page: number,
  bbox: DocValue['bbox'],
  confidence: number,
  ctx: FieldContext,
  dateFormats?: string[],
): DocValue {
  const normalized = normalizeValue(raw, { type, locale: ctx.locale, dateFormats: dateFormats ?? ctx.dateFormats });
  const ok = normalized.kind === 'null' || typeMatches(type, normalized.kind);
  return {
    raw,
    normalized,
    page,
    bbox,
    method: 'text-layer',
    confidence: Math.round((ok ? confidence : confidence * 0.4) * 100) / 100,
  };
}

function labelsOf(spec: FieldSpec): string[] {
  const l = spec.label;
  if (l === undefined) return [];
  return (Array.isArray(l) ? l : [l]).map((s) => s.replace(/\s*[:#]\s*$/, ''));
}

function lineBelow(lines: Line[], line: Line, anchor: Segment): Segment | undefined {
  const maxDist = anchor.fontSize * 3.5;
  for (const cand of lines) {
    if (cand.page !== line.page || cand.index <= line.index) continue;
    if (cand.bbox.y - (anchor.bbox.y + anchor.bbox.height) > maxDist) break;
    const a0 = anchor.bbox.x - anchor.fontSize;
    const a1 = anchor.bbox.x + Math.max(anchor.bbox.width, anchor.fontSize * 2);
    const hit = cand.segments.find((s) => s.bbox.x < a1 && s.bbox.x + s.bbox.width > a0);
    if (hit) return hit;
  }
  return undefined;
}

function findLabelCandidates(lines: Line[], spec: FieldSpec, fuzzyPass: boolean): Candidate[] {
  const out: Candidate[] = [];
  const labels = labelsOf(spec);
  for (const line of lines) {
    if (spec.page !== undefined && line.page !== spec.page) continue;
    line.segments.forEach((seg, si) => {
      const text = foldText(seg.text, { caseFold: false });
      for (const label of labels) {
        let labelOnly = false;
        let inline: string | undefined;
        let conf = 0.95;
        if (!fuzzyPass) {
          const m = new RegExp(`^${escapeRe(foldText(label, { caseFold: false })).replace(/ /g, '\\s+')}(\\s*[:#])?(\\s+|$)(.*)$`, 'i').exec(text);
          if (!m) continue;
          const rest = m[3].trim();
          if (!rest) labelOnly = true;
          else if (m[1] || spec.type !== 'text') inline = rest;
          else continue;
        } else {
          const bare = text.replace(/\s*[:#]\s*$/, '');
          const sim = similarity(bare, label);
          if (sim < spec.fuzzy) continue;
          labelOnly = true;
          conf = 0.8 * sim;
        }
        if (inline !== undefined) {
          // "Label: value" printed as one run; value bbox approximated by the segment.
          if (!m3TypeOk(inline, spec)) continue;
          out.push({ raw: inline, page: line.page, bbox: seg.bbox, confidence: conf - 0.05, label });
          continue;
        }
        if (labelOnly) {
          const right = line.segments[si + 1];
          if ((spec.readFrom === 'right' || spec.readFrom === 'auto') && right) {
            out.push({ raw: right.text, page: line.page, bbox: right.bbox, confidence: conf, label });
            continue;
          }
          if (spec.readFrom === 'below' || spec.readFrom === 'auto') {
            const below = lineBelow(lines, line, seg);
            if (below) out.push({ raw: below.text, page: line.page, bbox: below.bbox, confidence: conf - 0.1, label });
          }
        }
      }
    });
  }
  return out;
}

function m3TypeOk(raw: string, spec: FieldSpec): boolean {
  if (spec.type === 'text') return true;
  const n = normalizeValue(raw, { type: spec.type, dateFormats: spec.dateFormats });
  return typeMatches(spec.type, n.kind);
}

function findRegexCandidates(lines: Line[], spec: FieldSpec): Candidate[] {
  const re = compileUserRegex(spec.regex!, spec.flags ?? '', `field ${spec.name}`);
  const out: Candidate[] = [];
  for (const line of lines) {
    if (spec.page !== undefined && line.page !== spec.page) continue;
    const m = re.exec(line.text);
    if (!m) continue;
    const raw = (m.groups?.value ?? m[1] ?? m[0]).trim();
    if (!raw) continue;
    // Narrow the bbox to the segments that contain the value when possible.
    const segs = line.segments.filter((s) => raw.includes(s.text) || s.text.includes(raw));
    out.push({ raw, page: line.page, bbox: segs.length ? unionBBox(segs.map((s) => s.bbox)) : line.bbox, confidence: 0.85 });
  }
  return out;
}

/** Extract fields by label anchor or regex. Required fields that are not found produce error findings. */
export function extractFields(
  doc: CanonicalDocument,
  specsIn: Array<FieldSpec | FieldSpecInput>,
  ctx: FieldContext = {},
): { fields: DocField[]; findings: DocFinding[] } {
  const specs = specsIn.map((s) => FieldSpecSchema.parse(s));
  const lines = doc.pages.flatMap((p) => p.lines);
  const fields: DocField[] = [];
  const findings: DocFinding[] = [];
  for (const spec of specs) {
    let cands = spec.regex ? findRegexCandidates(lines, spec) : findLabelCandidates(lines, spec, false);
    if (!cands.length && !spec.regex) cands = findLabelCandidates(lines, spec, true);
    if (!cands.length) {
      if (spec.required) {
        findings.push({
          code: 'FIELD_NOT_FOUND',
          severity: 'error',
          message: `Field "${spec.name}" not found (${spec.regex ? `regex /${spec.regex}/` : `label ${JSON.stringify(labelsOf(spec))}`}).`,
          ref: spec.name,
        });
      }
      continue;
    }
    const c = spec.occurrence === 'last' ? cands[cands.length - 1] : cands[0];
    const value = makeValue(c.raw, spec.type, c.page, c.bbox, c.confidence, ctx, spec.dateFormats);
    if (value.normalized.kind !== 'null' && !typeMatches(spec.type, value.normalized.kind)) {
      findings.push({
        code: 'FIELD_TYPE_MISMATCH',
        severity: 'warning',
        message: `Field "${spec.name}" was read but is not a valid ${spec.type}.`,
        page: c.page,
        ref: spec.name,
      });
    }
    fields.push({ name: spec.name, label: c.label, type: spec.type, value });
  }
  return { fields, findings };
}

/**
 * Template-free field discovery: a segment ending with ":" followed by another
 * segment on the same line becomes a field named after the label. Used by the
 * PDF diff so field-level changes are reported without a template.
 */
export function autoFields(doc: CanonicalDocument, ctx: FieldContext = {}): DocField[] {
  const out: DocField[] = [];
  const seen = new Map<string, number>();
  for (const line of doc.pages.flatMap((p) => p.lines)) {
    line.segments.forEach((seg, si) => {
      const m = /^(.{1,40}?)\s*:$/.exec(seg.text);
      const next = line.segments[si + 1];
      if (!m || !next || /:$/.test(next.text)) return;
      const base = m[1].trim();
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const name = n === 1 ? base : `${base} #${n}`;
      const value = makeValue(next.text, 'text', line.page, next.bbox, 0.75, ctx);
      // Type is auto-detected so "1,200.00" and "1200.00" compare as the same number.
      value.normalized = normalizeValue(next.text, { locale: ctx.locale, dateFormats: ctx.dateFormats });
      out.push({ name, label: base, type: 'text', value });
    });
  }
  return out;
}

/** Lookup helper: a field by name (exact, then case-insensitive). */
export function getField(doc: CanonicalDocument, name: string): DocField | undefined {
  return doc.fields.find((f) => f.name === name) ?? doc.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
}
