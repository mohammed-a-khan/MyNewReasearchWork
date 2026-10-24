/**
 * XML Schema (XSD 1.0) validation for the subset of the language SOAP
 * services use, written from W3C XML Schema Part 1 (Structures) and Part 2
 * (Datatypes). Supported:
 *  - schema documents: targetNamespace, elementFormDefault/attributeFormDefault,
 *    xs:import and xs:include (with chameleon includes), several schemas per set;
 *  - global and local element declarations, element refs, minOccurs/maxOccurs,
 *    nillable (xsi:nil), default/fixed values, xsi:type to a named type;
 *  - complex types: sequence, choice, all (nested), model groups (xs:group),
 *    xs:any (namespace constraint; strict/lax/skip), mixed content, empty content,
 *    simpleContent and complexContent by extension or restriction, attributes,
 *    attribute groups, attribute use required/optional/prohibited, xs:anyAttribute;
 *  - simple types: restriction (enumeration, pattern, length, minLength,
 *    maxLength, minInclusive/maxInclusive/minExclusive/maxExclusive,
 *    totalDigits, fractionDigits, whiteSpace), list and union; the built-in
 *    primitive and derived types (strings, numbers, booleans, dates and times,
 *    durations, binary, URIs, QNames, names).
 * Not supported (documented, never silently "valid"): substitution groups,
 * identity constraints (key/keyref/unique), xs:redefine/xs:override, XSD 1.1
 * assertions, notations. Encountering an unsupported construct in a schema is
 * reported when the schema is loaded.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { EzTestError } from '../core/index.js';
import { childElements, getAttr, lookupNamespace, parseXml, type XElement } from './xml-dom.js';

export const XS_NS = 'http://www.w3.org/2001/XMLSchema';
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

const qn = (ns: string, local: string) => `{${ns}}${local}`;

export interface Facets {
  enumeration?: string[];
  pattern?: string[][];
  length?: number;
  minLength?: number;
  maxLength?: number;
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
  whiteSpace?: 'preserve' | 'replace' | 'collapse';
}

export interface SimpleTypeDef {
  kind: 'simple';
  name?: string;
  ns?: string;
  variety: 'atomic' | 'list' | 'union';
  /** Base type: a QName (resolved lazily) or an anonymous type. */
  base?: string | SimpleTypeDef;
  facets: Facets;
  itemType?: string | SimpleTypeDef;
  memberTypes?: Array<string | SimpleTypeDef>;
  /** Built-in primitive name for built-ins. */
  builtin?: string;
}

export interface AttributeUse {
  name: string;
  ns: string;
  type?: string | SimpleTypeDef;
  use: 'required' | 'optional' | 'prohibited';
  default?: string;
  fixed?: string;
}

export interface Wildcard {
  /** '##any', '##other' or a list of namespaces ('' for unqualified). */
  namespaces: '##any' | '##other' | string[];
  process: 'strict' | 'lax' | 'skip';
  targetNs: string;
}

export type Particle =
  | { kind: 'element'; decl: ElementDecl; min: number; max: number }
  | { kind: 'elementRef'; ref: string; min: number; max: number }
  | { kind: 'sequence' | 'choice' | 'all'; items: Particle[]; min: number; max: number }
  | { kind: 'groupRef'; ref: string; min: number; max: number }
  | { kind: 'any'; wildcard: Wildcard; min: number; max: number };

export interface ComplexTypeDef {
  kind: 'complex';
  name?: string;
  ns?: string;
  mixed: boolean;
  /** Own content (for derived types: what the derivation adds or restricts to). */
  particle?: Particle;
  attributes: Array<AttributeUse | { ref: string } | { groupRef: string }>;
  anyAttribute?: Wildcard;
  /** simpleContent: the simple type of the text. */
  simpleContent?: string | SimpleTypeDef;
  base?: string;
  derivation?: 'extension' | 'restriction';
  contentKind: 'elements' | 'simple' | 'empty';
  abstract?: boolean;
}

export type TypeDef = SimpleTypeDef | ComplexTypeDef;

export interface ElementDecl {
  name: string;
  ns: string;
  type?: string | TypeDef;
  nillable: boolean;
  default?: string;
  fixed?: string;
  abstract?: boolean;
}

export interface XsdIssue {
  /** Path of the instance node (/Envelope/Body/GetPolicy/PolicyId). */
  path: string;
  message: string;
}

export interface XsdResult {
  valid: boolean;
  errors: XsdIssue[];
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

// ------------------------------------------------------------------ built-in datatypes

const BUILTIN_BASE: Record<string, string> = {
  normalizedString: 'string', token: 'normalizedString', language: 'token', Name: 'token', NCName: 'Name', ID: 'NCName', IDREF: 'NCName', ENTITY: 'NCName', NMTOKEN: 'token',
  integer: 'decimal', long: 'integer', int: 'long', short: 'int', byte: 'short', nonNegativeInteger: 'integer', positiveInteger: 'nonNegativeInteger',
  unsignedLong: 'nonNegativeInteger', unsignedInt: 'unsignedLong', unsignedShort: 'unsignedInt', unsignedByte: 'unsignedShort', nonPositiveInteger: 'integer', negativeInteger: 'nonPositiveInteger',
};
const PRIMITIVES = new Set(['string', 'boolean', 'decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date', 'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION', 'anySimpleType']);
const LIST_BUILTINS: Record<string, string> = { NMTOKENS: 'NMTOKEN', IDREFS: 'IDREF', ENTITIES: 'ENTITY' };
const INT_RANGES: Record<string, [bigint, bigint]> = {
  long: [-(2n ** 63n), 2n ** 63n - 1n], int: [-(2n ** 31n), 2n ** 31n - 1n], short: [-32768n, 32767n], byte: [-128n, 127n],
  unsignedLong: [0n, 2n ** 64n - 1n], unsignedInt: [0n, 2n ** 32n - 1n], unsignedShort: [0n, 65535n], unsignedByte: [0n, 255n],
};
const TZ = '(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))?';
const LEXICAL: Record<string, RegExp> = {
  boolean: /^(?:true|false|1|0)$/,
  decimal: /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/,
  integer: /^[+-]?\d+$/,
  float: /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/,
  double: /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/,
  duration: /^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/,
  dateTime: new RegExp(`^-?\\d{4,}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?${TZ}$`),
  time: new RegExp(`^(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?${TZ}$`),
  date: new RegExp(`^-?\\d{4,}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])${TZ}$`),
  gYearMonth: new RegExp(`^-?\\d{4,}-(?:0[1-9]|1[0-2])${TZ}$`),
  gYear: new RegExp(`^-?\\d{4,}${TZ}$`),
  gMonthDay: new RegExp(`^--(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])${TZ}$`),
  gDay: new RegExp(`^---(?:0[1-9]|[12]\\d|3[01])${TZ}$`),
  gMonth: new RegExp(`^--(?:0[1-9]|1[0-2])${TZ}$`),
  hexBinary: /^(?:[0-9a-fA-F]{2})*$/,
  base64Binary: /^(?:[A-Za-z0-9+/] ?){0,}(?:[A-Za-z0-9+/] ?[A-Za-z0-9+/] ?[AEIMQUYcgkosw048] ?=|[A-Za-z0-9+/] ?[AQgw] ?= ?=)?$/,
  language: /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/,
  Name: /^[A-Za-z_:À-￿][\w.:\-·À-￿]*$/,
  NCName: /^[A-Za-z_À-￿][\w.\-·À-￿]*$/,
  NMTOKEN: /^[\w.:\-·À-￿]+$/,
  QName: /^(?:[A-Za-z_À-￿][\w.\-·À-￿]*:)?[A-Za-z_À-￿][\w.\-·À-￿]*$/,
};

function builtinChain(name: string): string[] {
  const out = [name];
  let n = name;
  while (BUILTIN_BASE[n]) {
    n = BUILTIN_BASE[n];
    out.push(n);
  }
  return out;
}

function isBuiltin(local: string): boolean {
  return PRIMITIVES.has(local) || local in BUILTIN_BASE || local in LIST_BUILTINS || local === 'anyType';
}

function whitespaceOf(builtin: string): 'preserve' | 'replace' | 'collapse' {
  const chain = builtinChain(builtin);
  if (chain[0] === 'string') return 'preserve';
  if (chain[0] === 'normalizedString') return 'replace';
  return 'collapse';
}

function applyWhitespace(v: string, ws: 'preserve' | 'replace' | 'collapse'): string {
  if (ws === 'preserve') return v;
  const r = v.replace(/[\t\n\r]/g, ' ');
  return ws === 'replace' ? r : r.replace(/ +/g, ' ').trim();
}

/** Lexical and value-space check of a built-in type; returns a problem or undefined. */
function checkBuiltin(name: string, v: string): string | undefined {
  if (name === 'anySimpleType' || name === 'string' || name === 'normalizedString' || name === 'token' || name === 'anyURI' || name === 'NOTATION') {
    if ((name === 'normalizedString') && /[\t\n\r]/.test(v)) return 'contains tabs or line breaks';
    if (name === 'token' && (/[\t\n\r]|^ | $| {2}/.test(v))) return 'is not a token (leading, trailing or double spaces)';
    return undefined;
  }
  const chain = builtinChain(name);
  for (const n of chain) {
    const re = LEXICAL[n];
    if (re && !re.test(v)) return `is not a valid ${name}`;
  }
  if (chain.includes('integer')) {
    const b = BigInt(v.replace(/^\+/, ''));
    const range = INT_RANGES[name];
    if (range && (b < range[0] || b > range[1])) return `is out of range for ${name}`;
    if (chain.includes('nonNegativeInteger') && b < 0n) return `must not be negative (${name})`;
    if (name === 'positiveInteger' && b < 1n) return 'must be positive';
    if (chain.includes('nonPositiveInteger') && b > 0n) return `must not be positive (${name})`;
    if (name === 'negativeInteger' && b > -1n) return 'must be negative';
  }
  if (name === 'date' || name === 'dateTime') {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})/.exec(v)!;
    const days = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    if (Number(m[3]) > days) return `is not a real date (${name})`;
  }
  if (name === 'base64Binary' && v.replace(/ /g, '').length % 4 !== 0) return 'is not valid base64';
  return undefined;
}

function compareValues(builtin: string, a: string, b: string): number {
  const chain = builtinChain(builtin);
  if (chain.includes('decimal') || builtin === 'float' || builtin === 'double') return Number(a) - Number(b);
  if (['date', 'dateTime', 'time', 'gYear', 'gYearMonth'].includes(builtin)) {
    const p = (s: string) => Date.parse(builtin === 'time' ? `1970-01-01T${s}` : builtin === 'gYear' ? `${s}-01-01` : builtin === 'gYearMonth' ? `${s}-01` : s);
    return p(a) - p(b);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** XSD regular expression to a JavaScript one (whole-value match). */
function xsdRegex(p: string): RegExp {
  // XSD-only escapes: \i (name start), \c (name char) and their negations.
  const src = p
    .replace(/\\i/g, '[A-Za-z_:\\u00C0-\\uFFFF]').replace(/\\I/g, '[^A-Za-z_:\\u00C0-\\uFFFF]')
    .replace(/\\c/g, '[\\w.:\\-\\u00B7\\u00C0-\\uFFFF]').replace(/\\C/g, '[^\\w.:\\-\\u00B7\\u00C0-\\uFFFF]');
  return new RegExp(`^(?:${src})$`, 'u');
}

// ------------------------------------------------------------------ schema loading

export type SchemaLoader = (location: string, base?: string) => Promise<{ text: string; location: string }>;

/** Default loader: files relative to the referring document (http(s) locations are fetched). */
export const fileSchemaLoader: SchemaLoader = async (location, base) => {
  if (/^https?:\/\//i.test(location)) {
    const r = await fetch(location);
    if (!r.ok) throw new EzTestError(`Cannot fetch schema ${location}: HTTP ${r.status}`, 'XSD_LOAD');
    return { text: await r.text(), location };
  }
  if (base && /^https?:\/\//i.test(base)) {
    const url = new URL(location, base).toString();
    return fileSchemaLoader(url);
  }
  const p = isAbsolute(location) || !base ? location : resolvePath(dirname(base), location);
  return { text: await readFile(p, 'utf8'), location: p };
};

interface SchemaCtx {
  tns: string;
  qualifiedElements: boolean;
  qualifiedAttributes: boolean;
  el: XElement;
}

const UNSUPPORTED = new Set(['redefine', 'override', 'key', 'keyref', 'unique', 'assert', 'assertion', 'notation']);

export class XsdSchemaSet {
  readonly elements = new Map<string, ElementDecl>();
  readonly types = new Map<string, TypeDef>();
  readonly groups = new Map<string, Particle>();
  readonly attributeGroups = new Map<string, ComplexTypeDef['attributes']>();
  readonly attributes = new Map<string, AttributeUse>();
  /** Schema features found that this validator does not enforce. */
  readonly unsupported: string[] = [];
  private readonly loaded = new Set<string>();
  private allChoices = false;

  constructor(private readonly loader: SchemaLoader = fileSchemaLoader) {}

  /** Load schema files (and everything they import or include). */
  static async load(locations: string[], loader?: SchemaLoader): Promise<XsdSchemaSet> {
    const set = new XsdSchemaSet(loader);
    for (const l of locations) {
      const r = await set.loader(l);
      await set.addSchemaText(r.text, r.location);
    }
    return set;
  }

  /** Add a schema document (text). */
  async addSchemaText(text: string, location?: string): Promise<void> {
    await this.addSchema(parseXml(text).root, location);
  }

  /** Add an xs:schema element (e.g. one embedded in a WSDL types section), loading its imports and includes. */
  async addSchema(schema: XElement, location?: string, chameleonNs?: string): Promise<void> {
    if (schema.local !== 'schema' || schema.ns !== XS_NS) throw new EzTestError(`Not an XML Schema document (root <${schema.name}>)`, 'XSD_LOAD');
    const key = `${location ?? ''}#${chameleonNs ?? ''}#${getAttr(schema, 'targetNamespace') ?? ''}`;
    if (location && this.loaded.has(key)) return;
    if (location) this.loaded.add(key);
    const tns = getAttr(schema, 'targetNamespace') ?? chameleonNs ?? '';
    const ctx: SchemaCtx = { tns, qualifiedElements: getAttr(schema, 'elementFormDefault') === 'qualified', qualifiedAttributes: getAttr(schema, 'attributeFormDefault') === 'qualified', el: schema };
    for (const c of childElements(schema, undefined, XS_NS)) {
      const name = getAttr(c, 'name') ?? '';
      switch (c.local) {
        case 'import':
        case 'include': {
          const loc = getAttr(c, 'schemaLocation');
          if (!loc) break; // an import without a location names a namespace loaded elsewhere (e.g. another inline schema)
          const r = await this.loader(loc, location);
          await this.addSchema(parseXml(r.text).root, r.location, c.local === 'include' && !getAttr(parseXml(r.text).root, 'targetNamespace') ? tns : undefined);
          break;
        }
        case 'element': this.elements.set(qn(tns, name), this.elementDecl(c, ctx, true)); break;
        case 'complexType': this.types.set(qn(tns, name), this.complexType(c, ctx, name)); break;
        case 'simpleType': this.types.set(qn(tns, name), this.simpleType(c, ctx, name)); break;
        case 'group': {
          const inner = childElements(c, undefined, XS_NS).find((x) => ['sequence', 'choice', 'all'].includes(x.local));
          if (inner) this.groups.set(qn(tns, name), this.particle(inner, ctx)!);
          break;
        }
        case 'attributeGroup': this.attributeGroups.set(qn(tns, name), this.attributeList(c, ctx).list); break;
        case 'attribute': this.attributes.set(qn(tns, name), this.attribute(c, ctx, true)); break;
        case 'annotation': break;
        default: this.note(c.local);
      }
    }
    this.scanUnsupported(schema);
  }

  private note(what: string) {
    if (!this.unsupported.includes(what)) this.unsupported.push(what);
  }

  private scanUnsupported(el: XElement) {
    for (const c of childElements(el, undefined, XS_NS)) {
      if (UNSUPPORTED.has(c.local)) this.note(c.local);
      if (c.local === 'element' && getAttr(c, 'substitutionGroup')) this.note('substitutionGroup');
      if (c.local !== 'annotation') this.scanUnsupported(c);
    }
  }

  private qname(ctxEl: XElement, v: string): string {
    const i = v.indexOf(':');
    const prefix = i < 0 ? '' : v.slice(0, i);
    const local = i < 0 ? v : v.slice(i + 1);
    const ns = lookupNamespace(ctxEl, prefix);
    if (ns === undefined) throw new EzTestError(`Undeclared prefix "${prefix}" in schema reference "${v}"`, 'XSD_LOAD');
    return qn(ns, local);
  }

  private occurs(el: XElement): { min: number; max: number } {
    const min = Number(getAttr(el, 'minOccurs') ?? '1');
    const maxRaw = getAttr(el, 'maxOccurs') ?? '1';
    return { min, max: maxRaw === 'unbounded' ? UNBOUNDED : Number(maxRaw) };
  }

  private elementDecl(el: XElement, ctx: SchemaCtx, global: boolean): ElementDecl {
    const name = getAttr(el, 'name') ?? '';
    const form = getAttr(el, 'form');
    const ns = global || form === 'qualified' || (form !== 'unqualified' && ctx.qualifiedElements) ? ctx.tns : '';
    const t = getAttr(el, 'type');
    const inlineC = childElements(el, 'complexType', XS_NS)[0];
    const inlineS = childElements(el, 'simpleType', XS_NS)[0];
    return {
      name, ns,
      type: t ? this.qname(el, t) : inlineC ? this.complexType(inlineC, ctx) : inlineS ? this.simpleType(inlineS, ctx) : undefined,
      nillable: getAttr(el, 'nillable') === 'true',
      ...(getAttr(el, 'default') !== undefined ? { default: getAttr(el, 'default') } : {}),
      ...(getAttr(el, 'fixed') !== undefined ? { fixed: getAttr(el, 'fixed') } : {}),
      ...(getAttr(el, 'abstract') === 'true' ? { abstract: true } : {}),
    };
  }

  private wildcard(el: XElement, ctx: SchemaCtx): Wildcard {
    const raw = (getAttr(el, 'namespace') ?? '##any').trim();
    const namespaces = raw === '##any' || raw === '##other' ? raw : raw.split(/\s+/).map((n) => (n === '##targetNamespace' ? ctx.tns : n === '##local' ? '' : n));
    return { namespaces, process: (getAttr(el, 'processContents') as Wildcard['process']) ?? 'strict', targetNs: ctx.tns };
  }

  private particle(el: XElement, ctx: SchemaCtx): Particle | undefined {
    const o = this.occurs(el);
    switch (el.local) {
      case 'element': {
        const ref = getAttr(el, 'ref');
        if (ref) return { kind: 'elementRef', ref: this.qname(el, ref), ...o };
        return { kind: 'element', decl: this.elementDecl(el, ctx, false), ...o };
      }
      case 'sequence':
      case 'choice':
      case 'all':
        return { kind: el.local, items: childElements(el, undefined, XS_NS).map((c) => this.particle(c, ctx)).filter((p): p is Particle => !!p), ...o };
      case 'group': return { kind: 'groupRef', ref: this.qname(el, getAttr(el, 'ref') ?? ''), ...o };
      case 'any': return { kind: 'any', wildcard: this.wildcard(el, ctx), ...o };
      default: return undefined;
    }
  }

  private attribute(el: XElement, ctx: SchemaCtx, global: boolean): AttributeUse {
    const name = getAttr(el, 'name') ?? '';
    const form = getAttr(el, 'form');
    const ns = global || form === 'qualified' || (form !== 'unqualified' && ctx.qualifiedAttributes) ? ctx.tns : '';
    const t = getAttr(el, 'type');
    const inline = childElements(el, 'simpleType', XS_NS)[0];
    return {
      name, ns, use: (getAttr(el, 'use') as AttributeUse['use']) ?? 'optional',
      ...(t ? { type: this.qname(el, t) } : inline ? { type: this.simpleType(inline, ctx) } : {}),
      ...(getAttr(el, 'default') !== undefined ? { default: getAttr(el, 'default') } : {}),
      ...(getAttr(el, 'fixed') !== undefined ? { fixed: getAttr(el, 'fixed') } : {}),
    };
  }

  private attributeList(parent: XElement, ctx: SchemaCtx): { list: ComplexTypeDef['attributes']; any?: Wildcard } {
    const list: ComplexTypeDef['attributes'] = [];
    let any: Wildcard | undefined;
    for (const c of childElements(parent, undefined, XS_NS)) {
      if (c.local === 'attribute') {
        const ref = getAttr(c, 'ref');
        if (ref) {
          const q = this.qname(c, ref);
          list.push(getAttr(c, 'use') === 'required' ? ({ ref: q, required: true } as never) : { ref: q });
        } else list.push(this.attribute(c, ctx, false));
      } else if (c.local === 'attributeGroup') list.push({ groupRef: this.qname(c, getAttr(c, 'ref') ?? '') });
      else if (c.local === 'anyAttribute') any = this.wildcard(c, ctx);
    }
    return { list, any };
  }

  private complexType(el: XElement, ctx: SchemaCtx, name?: string): ComplexTypeDef {
    const def: ComplexTypeDef = { kind: 'complex', ...(name ? { name, ns: ctx.tns } : {}), mixed: getAttr(el, 'mixed') === 'true', attributes: [], contentKind: 'empty', ...(getAttr(el, 'abstract') === 'true' ? { abstract: true } : {}) };
    const sc = childElements(el, 'simpleContent', XS_NS)[0];
    const cc = childElements(el, 'complexContent', XS_NS)[0];
    if (sc || cc) {
      const der = childElements(sc ?? cc, undefined, XS_NS).find((c) => c.local === 'extension' || c.local === 'restriction');
      if (!der) throw new EzTestError(`complexType ${name ?? '(anonymous)'}: content without extension or restriction`, 'XSD_LOAD');
      def.base = this.qname(der, getAttr(der, 'base') ?? '');
      def.derivation = der.local as 'extension' | 'restriction';
      if (cc && getAttr(cc, 'mixed') === 'true') def.mixed = true;
      const a = this.attributeList(der, ctx);
      def.attributes = a.list;
      def.anyAttribute = a.any;
      if (sc) {
        def.contentKind = 'simple';
        if (def.derivation === 'restriction') {
          const inline = childElements(der, 'simpleType', XS_NS)[0];
          def.simpleContent = { kind: 'simple', variety: 'atomic', base: inline ? this.simpleType(inline, ctx) : def.base, facets: this.facets(der) };
        }
      } else {
        const p = childElements(der, undefined, XS_NS).map((c) => this.particle(c, ctx)).find((x) => x);
        if (p) def.particle = p;
        def.contentKind = 'elements';
      }
      return def;
    }
    const p = childElements(el, undefined, XS_NS).map((c) => this.particle(c, ctx)).find((x) => x);
    if (p) {
      def.particle = p;
      def.contentKind = 'elements';
    }
    const a = this.attributeList(el, ctx);
    def.attributes = a.list;
    def.anyAttribute = a.any;
    return def;
  }

  private facets(der: XElement): Facets {
    const f: Facets = {};
    for (const c of childElements(der, undefined, XS_NS)) {
      const v = getAttr(c, 'value') ?? '';
      switch (c.local) {
        case 'enumeration': (f.enumeration ??= []).push(v); break;
        case 'pattern': (f.pattern ??= [[]])[0].push(v); break;
        case 'length': case 'minLength': case 'maxLength': case 'totalDigits': case 'fractionDigits': f[c.local] = Number(v); break;
        case 'minInclusive': case 'maxInclusive': case 'minExclusive': case 'maxExclusive': f[c.local] = v; break;
        case 'whiteSpace': f.whiteSpace = v as Facets['whiteSpace']; break;
        default: break;
      }
    }
    return f;
  }

  private simpleType(el: XElement, ctx: SchemaCtx, name?: string): SimpleTypeDef {
    const named = name ? { name, ns: ctx.tns } : {};
    const r = childElements(el, 'restriction', XS_NS)[0];
    if (r) {
      const b = getAttr(r, 'base');
      const inline = childElements(r, 'simpleType', XS_NS)[0];
      return { kind: 'simple', ...named, variety: 'atomic', base: b ? this.qname(r, b) : inline ? this.simpleType(inline, ctx) : qn(XS_NS, 'anySimpleType'), facets: this.facets(r) };
    }
    const l = childElements(el, 'list', XS_NS)[0];
    if (l) {
      const it = getAttr(l, 'itemType');
      const inline = childElements(l, 'simpleType', XS_NS)[0];
      return { kind: 'simple', ...named, variety: 'list', itemType: it ? this.qname(l, it) : inline ? this.simpleType(inline, ctx) : qn(XS_NS, 'string'), facets: {} };
    }
    const u = childElements(el, 'union', XS_NS)[0];
    if (u) {
      const members: Array<string | SimpleTypeDef> = (getAttr(u, 'memberTypes') ?? '').trim().split(/\s+/).filter(Boolean).map((m) => this.qname(u, m));
      for (const s of childElements(u, 'simpleType', XS_NS)) members.push(this.simpleType(s, ctx));
      return { kind: 'simple', ...named, variety: 'union', memberTypes: members, facets: {} };
    }
    throw new EzTestError(`simpleType ${name ?? '(anonymous)'} has no restriction, list or union`, 'XSD_LOAD');
  }

  // ---------------------------------------------------------------- resolution

  resolveType(t: string | TypeDef | undefined): TypeDef | undefined {
    if (t === undefined) return undefined;
    if (typeof t !== 'string') return t;
    const m = /^\{(.*)\}(.*)$/.exec(t)!;
    if (m[1] === XS_NS && isBuiltin(m[2])) {
      if (m[2] === 'anyType') return { kind: 'complex', name: 'anyType', ns: XS_NS, mixed: true, attributes: [], anyAttribute: { namespaces: '##any', process: 'skip', targetNs: '' }, particle: { kind: 'any', wildcard: { namespaces: '##any', process: 'skip', targetNs: '' }, min: 0, max: UNBOUNDED }, contentKind: 'elements' };
      if (m[2] in LIST_BUILTINS) return { kind: 'simple', name: m[2], ns: XS_NS, variety: 'list', itemType: qn(XS_NS, LIST_BUILTINS[m[2]]), facets: { minLength: 1 } };
      return { kind: 'simple', name: m[2], ns: XS_NS, variety: 'atomic', builtin: m[2], facets: {} };
    }
    const def = this.types.get(t);
    if (!def) throw new EzTestError(`Type ${t} is not defined in the loaded schemas`, 'XSD_UNKNOWN_TYPE');
    return def;
  }

  /** The built-in primitive a simple type derives from (atomic types). */
  private builtinOf(t: SimpleTypeDef): string {
    let cur: TypeDef | undefined = t;
    for (let i = 0; i < 50 && cur; i++) {
      if (cur.kind !== 'simple') return 'string';
      if (cur.builtin) return cur.builtin;
      if (cur.variety !== 'atomic') return 'string';
      cur = this.resolveType(cur.base);
    }
    return 'string';
  }

  /** Effective content particle and attribute uses of a complex type (derivations applied). */
  private effective(t: ComplexTypeDef, depth = 0): { particle?: Particle; attributes: AttributeUse[]; anyAttribute?: Wildcard; simple?: SimpleTypeDef | 'any'; mixed: boolean; empty: boolean } {
    if (depth > 30) throw new EzTestError('Type derivation is circular', 'XSD_LOAD');
    let particle = t.particle;
    let attrs = this.attributeUses(t.attributes);
    let anyAttribute = t.anyAttribute;
    let simple: SimpleTypeDef | 'any' | undefined;
    if (t.base) {
      const base = this.resolveType(t.base)!;
      if (base.kind === 'complex') {
        const b = this.effective(base, depth + 1);
        if (t.derivation === 'extension') {
          particle = b.particle && particle ? { kind: 'sequence', items: [b.particle, particle], min: 1, max: 1 } : b.particle ?? particle;
          attrs = [...b.attributes.filter((x) => !attrs.some((y) => y.name === x.name && y.ns === x.ns)), ...attrs];
          anyAttribute ??= b.anyAttribute;
          simple = b.simple;
        } else {
          // Restriction: own content; attributes not mentioned are inherited.
          attrs = [...b.attributes.filter((x) => !attrs.some((y) => y.name === x.name && y.ns === x.ns)), ...attrs].filter((x) => x.use !== 'prohibited');
          simple = t.contentKind === 'simple' ? (t.simpleContent as SimpleTypeDef) : undefined;
          if (t.contentKind === 'simple' && t.simpleContent && typeof t.simpleContent !== 'string' && b.simple && b.simple !== 'any' && !t.simpleContent.base) t.simpleContent.base = b.simple;
        }
      } else {
        simple = base;
      }
      if (t.contentKind === 'simple' && t.derivation === 'restriction' && t.simpleContent) simple = this.resolveType(t.simpleContent) as SimpleTypeDef;
    }
    return { particle, attributes: attrs.filter((x) => x.use !== 'prohibited'), anyAttribute, simple, mixed: t.mixed, empty: t.contentKind === 'empty' && !particle && !simple };
  }

  private attributeUses(list: ComplexTypeDef['attributes'], depth = 0): AttributeUse[] {
    const out: AttributeUse[] = [];
    for (const a of list) {
      if ('groupRef' in a) {
        const g = this.attributeGroups.get(a.groupRef);
        if (!g) throw new EzTestError(`attributeGroup ${a.groupRef} is not defined`, 'XSD_UNKNOWN_TYPE');
        if (depth < 20) out.push(...this.attributeUses(g, depth + 1));
      } else if ('ref' in a) {
        const g = this.attributes.get(a.ref);
        if (!g) throw new EzTestError(`attribute ${a.ref} is not defined`, 'XSD_UNKNOWN_TYPE');
        out.push({ ...g, use: (a as { required?: boolean }).required ? 'required' : g.use });
      } else out.push(a);
    }
    return out;
  }

  // ---------------------------------------------------------------- validation

  /** Validate an instance element against its global element declaration. */
  validate(el: XElement, path?: string): XsdResult {
    const errors: XsdIssue[] = [];
    const decl = this.elements.get(qn(el.ns, el.local));
    const here = path ?? `/${el.local}`;
    if (!decl) errors.push({ path: here, message: `No global element {${el.ns}}${el.local} is declared in the schemas` });
    else this.validateElement(el, decl, here, errors);
    return { valid: errors.length === 0, errors };
  }

  /** Validate an element against a named type ({ns}local). */
  validateAgainstType(el: XElement, type: string, path?: string): XsdResult {
    const errors: XsdIssue[] = [];
    this.validateElement(el, { name: el.local, ns: el.ns, type, nillable: false }, path ?? `/${el.local}`, errors);
    return { valid: errors.length === 0, errors };
  }

  hasElement(ns: string, local: string): boolean {
    return this.elements.has(qn(ns, local));
  }

  private validateElement(el: XElement, decl: ElementDecl, path: string, errors: XsdIssue[]) {
    if (decl.abstract) errors.push({ path, message: `Element ${decl.name} is abstract and cannot appear` });
    let type = this.resolveType(decl.type) ?? this.resolveType(qn(XS_NS, 'anyType'))!;
    const xsiType = getAttr(el, 'type', XSI_NS);
    if (xsiType) {
      try {
        const i = xsiType.indexOf(':');
        const ns = lookupNamespace(el, i < 0 ? '' : xsiType.slice(0, i)) ?? '';
        type = this.resolveType(qn(ns, i < 0 ? xsiType : xsiType.slice(i + 1)))!;
      } catch (e) {
        errors.push({ path, message: `xsi:type="${xsiType}": ${(e as Error).message}` });
        return;
      }
    }
    if (getAttr(el, 'nil', XSI_NS) === 'true') {
      if (!decl.nillable) errors.push({ path, message: `Element ${el.local} is not nillable but has xsi:nil="true"` });
      else if (el.children.some((c) => c.type === 'element' || (c.type === 'text' && c.value.trim()))) errors.push({ path, message: 'An element with xsi:nil="true" must be empty' });
      return;
    }
    if (type.kind === 'simple') {
      for (const a of el.attrs) if (a.ns !== XSI_NS) errors.push({ path: `${path}/@${a.name}`, message: `Attribute ${a.name} is not allowed (simple-typed element)` });
      if (el.children.some((c) => c.type === 'element')) {
        errors.push({ path, message: 'Element has a simple type and must not contain child elements' });
        return;
      }
      const raw = text(el);
      const v = raw === '' && decl.default !== undefined ? decl.default : raw;
      this.checkSimple(v, type, path, errors);
      if (decl.fixed !== undefined && this.norm(v, type) !== this.norm(decl.fixed, type)) errors.push({ path, message: `Value "${v}" differs from the fixed value "${decl.fixed}"` });
      return;
    }
    if (type.abstract && !xsiType) errors.push({ path, message: `Type ${type.name} is abstract: use xsi:type to name a concrete type` });
    const eff = this.effective(type);
    this.checkAttributes(el, eff.attributes, eff.anyAttribute, path, errors);
    const kids = el.children.filter((c): c is XElement => c.type === 'element');
    if (eff.simple) {
      if (kids.length) errors.push({ path, message: 'Element has simple content and must not contain child elements' });
      else if (eff.simple !== 'any') this.checkSimple(text(el), eff.simple, path, errors);
      return;
    }
    if (!eff.mixed && el.children.some((c) => c.type === 'text' && c.value.trim())) errors.push({ path, message: `Text is not allowed in element ${el.local} (element-only content)` });
    if (eff.empty || !eff.particle) {
      if (kids.length) errors.push({ path, message: `Element ${el.local} must be empty, found <${kids[0].local}>` });
      return;
    }
    let assigned: Array<{ child: XElement; decl?: ElementDecl; wildcard?: Wildcard }> = [];
    const end = this.matchParticle(eff.particle, kids, 0, assigned, 0);
    if (end === undefined || end < kids.length) {
      const d = this.diagnose(eff.particle, kids, end);
      // Children matched before the problem are still checked.
      if (end === undefined) assigned = d.assigned;
      const firstBad = kids[d.at];
      const expected = d.expected;
      if (firstBad) errors.push({ path: `${path}/${firstBad.local}`, message: `Unexpected element <${firstBad.local}>${expected.length ? ` (expected ${expected.join(' or ')})` : ''}` });
      else errors.push({ path, message: `Element ${el.local} is incomplete: missing ${expected.length ? expected.join(' or ') : 'required content'}` });
    }
    const counts = new Map<string, number>();
    for (const a of assigned) {
      const n = (counts.get(a.child.local) ?? 0) + 1;
      counts.set(a.child.local, n);
      const childPath = `${path}/${a.child.local}${kids.filter((k) => k.local === a.child.local).length > 1 ? `[${n}]` : ''}`;
      if (a.decl) this.validateElement(a.child, a.decl, childPath, errors);
      else if (a.wildcard && a.wildcard.process !== 'skip') {
        const g = this.elements.get(qn(a.child.ns, a.child.local));
        if (g) this.validateElement(a.child, g, childPath, errors);
        else if (a.wildcard.process === 'strict') errors.push({ path: childPath, message: `No declaration for {${a.child.ns}}${a.child.local} (xs:any processContents="strict")` });
      }
    }
  }

  private norm(v: string, t: SimpleTypeDef): string {
    return applyWhitespace(v, t.facets.whiteSpace ?? whitespaceOf(this.builtinOf(t)));
  }

  private checkAttributes(el: XElement, uses: AttributeUse[], any: Wildcard | undefined, path: string, errors: XsdIssue[]) {
    for (const u of uses) {
      const a = el.attrs.find((x) => x.local === u.name && x.ns === u.ns);
      if (!a) {
        if (u.use === 'required') errors.push({ path, message: `Missing required attribute ${u.name}` });
        continue;
      }
      const t = this.resolveType(u.type ?? qn(XS_NS, 'anySimpleType'));
      if (t && t.kind === 'simple') this.checkSimple(a.value, t, `${path}/@${a.name}`, errors);
      if (u.fixed !== undefined && a.value !== u.fixed) errors.push({ path: `${path}/@${a.name}`, message: `Attribute value "${a.value}" differs from the fixed value "${u.fixed}"` });
    }
    for (const a of el.attrs) {
      if (a.ns === XSI_NS || a.ns === 'http://www.w3.org/XML/1998/namespace') continue;
      if (uses.some((u) => u.name === a.local && u.ns === a.ns)) continue;
      if (any && nsAllowed(any, a.ns)) continue;
      errors.push({ path: `${path}/@${a.name}`, message: `Attribute ${a.name} is not allowed here` });
    }
  }

  /** Check a simple value; pushes problems. */
  checkSimple(raw: string, t: SimpleTypeDef, path: string, errors: XsdIssue[], depth = 0): boolean {
    if (depth > 40) return true;
    const before = errors.length;
    if (t.variety === 'list') {
      const item = this.resolveType(t.itemType) as SimpleTypeDef;
      const items = applyWhitespace(raw, 'collapse').split(' ').filter(Boolean);
      for (const it of items) this.checkSimple(it, item, path, errors, depth + 1);
      this.checkFacets(items.join(' '), t, path, errors, items.length);
      return errors.length === before;
    }
    if (t.variety === 'union') {
      for (const m of t.memberTypes ?? []) {
        const tmp: XsdIssue[] = [];
        if (this.checkSimple(raw, this.resolveType(m) as SimpleTypeDef, path, tmp, depth + 1)) return this.checkFacets(raw, t, path, errors) && errors.length === before;
      }
      errors.push({ path, message: `Value "${raw}" matches none of the union's member types` });
      return false;
    }
    const builtin = this.builtinOf(t);
    const v = this.norm(raw, t);
    if (t.builtin) {
      const p = checkBuiltin(t.builtin, v);
      if (p) errors.push({ path, message: `Value "${raw}" ${p}` });
      return errors.length === before;
    }
    const base = this.resolveType(t.base);
    if (base && base.kind === 'simple') this.checkSimple(v, base, path, errors, depth + 1);
    if (errors.length === before) this.checkFacets(v, t, path, errors, undefined, builtin);
    return errors.length === before;
  }

  private checkFacets(v: string, t: SimpleTypeDef, path: string, errors: XsdIssue[], listLength?: number, builtin = 'string'): boolean {
    const f = t.facets;
    const before = errors.length;
    const len = listLength ?? (builtin === 'hexBinary' ? v.length / 2 : builtin === 'base64Binary' ? Math.floor((v.replace(/[\s=]/g, '').length * 3) / 4) : [...v].length);
    if (f.enumeration && !f.enumeration.some((e) => (isNumeric(builtin) ? Number(e) === Number(v) : this.norm(e, t) === v))) errors.push({ path, message: `Value "${v}" is not one of ${f.enumeration.map((e) => `"${e}"`).join(', ')}` });
    for (const group of f.pattern ?? []) {
      if (!group.some((p) => xsdRegex(p).test(v))) errors.push({ path, message: `Value "${v}" does not match the pattern ${group.join(' | ')}` });
    }
    if (f.length !== undefined && len !== f.length) errors.push({ path, message: `Length ${len} of "${v}" is not ${f.length}` });
    if (f.minLength !== undefined && len < f.minLength) errors.push({ path, message: `Value "${v}" is shorter than ${f.minLength}` });
    if (f.maxLength !== undefined && len > f.maxLength) errors.push({ path, message: `Value "${v}" is longer than ${f.maxLength}` });
    if (f.minInclusive !== undefined && compareValues(builtin, v, f.minInclusive) < 0) errors.push({ path, message: `Value ${v} is less than the minimum ${f.minInclusive}` });
    if (f.maxInclusive !== undefined && compareValues(builtin, v, f.maxInclusive) > 0) errors.push({ path, message: `Value ${v} is greater than the maximum ${f.maxInclusive}` });
    if (f.minExclusive !== undefined && compareValues(builtin, v, f.minExclusive) <= 0) errors.push({ path, message: `Value ${v} must be greater than ${f.minExclusive}` });
    if (f.maxExclusive !== undefined && compareValues(builtin, v, f.maxExclusive) >= 0) errors.push({ path, message: `Value ${v} must be less than ${f.maxExclusive}` });
    if (f.totalDigits !== undefined || f.fractionDigits !== undefined) {
      const m = /^[+-]?0*(\d*?)(?:\.(\d*?)0*)?$/.exec(v);
      if (m) {
        const intDigits = m[1].length;
        const frac = (m[2] ?? '').length;
        if (f.totalDigits !== undefined && Math.max(1, intDigits + frac) > f.totalDigits) errors.push({ path, message: `Value ${v} has more than ${f.totalDigits} digits` });
        if (f.fractionDigits !== undefined && frac > f.fractionDigits) errors.push({ path, message: `Value ${v} has more than ${f.fractionDigits} fraction digits` });
      }
    }
    return errors.length === before;
  }

  // Content-model matching. Schemas must satisfy Unique Particle Attribution, so a greedy match is deterministic.
  private matchParticle(p: Particle, kids: XElement[], pos: number, out: Array<{ child: XElement; decl?: ElementDecl; wildcard?: Wildcard }>, depth: number): number | undefined {
    if (depth > 60) return undefined;
    let count = 0;
    let at = pos;
    while (count < p.max) {
      const mark = out.length;
      const next = this.matchOnce(p, kids, at, out, depth);
      if (next === undefined || (next === at && count >= p.min)) {
        out.length = mark;
        break;
      }
      count++;
      if (next === at) break; // matched empty: further repetitions add nothing
      at = next;
    }
    return count >= p.min || (count === 0 && p.min === 0) ? at : undefined;
  }

  private matchOnce(p: Particle, kids: XElement[], pos: number, out: Array<{ child: XElement; decl?: ElementDecl; wildcard?: Wildcard }>, depth: number): number | undefined {
    switch (p.kind) {
      case 'element':
      case 'elementRef': {
        const decl = p.kind === 'element' ? p.decl : this.elements.get(p.ref);
        if (!decl) throw new EzTestError(`Element ref ${(p as { ref: string }).ref} is not declared`, 'XSD_UNKNOWN_TYPE');
        const k = kids[pos];
        if (!k || k.local !== decl.name || k.ns !== decl.ns) return undefined;
        out.push({ child: k, decl });
        return pos + 1;
      }
      case 'any': {
        const k = kids[pos];
        if (!k || !nsAllowed(p.wildcard, k.ns)) return undefined;
        out.push({ child: k, wildcard: p.wildcard });
        return pos + 1;
      }
      case 'groupRef': {
        const g = this.groups.get(p.ref);
        if (!g) throw new EzTestError(`Group ${p.ref} is not defined`, 'XSD_UNKNOWN_TYPE');
        return this.matchParticle({ ...g, min: 1, max: 1 }, kids, pos, out, depth + 1);
      }
      case 'sequence': {
        let at = pos;
        for (const item of p.items) {
          const next = this.matchParticle(item, kids, at, out, depth + 1);
          if (next === undefined) return undefined;
          at = next;
        }
        return at;
      }
      case 'choice': {
        let best: { end: number; assigned: typeof out } | undefined;
        for (const item of p.items) {
          const tmp: typeof out = [];
          const end = this.matchParticle(item, kids, pos, tmp, depth + 1);
          if (end !== undefined && (!best || end > best.end)) best = { end, assigned: tmp };
        }
        if (!best) return undefined;
        out.push(...best.assigned);
        return best.end;
      }
      case 'all': {
        let at = pos;
        const used = new Set<Particle>();
        for (;;) {
          const k = kids[at];
          if (!k) break;
          const item = p.items.find((it) => !used.has(it) && this.matchOnce(it, [k], 0, [], depth + 1) !== undefined);
          if (!item) break;
          used.add(item);
          this.matchOnce(item, kids, at, out, depth + 1);
          at++;
        }
        for (const it of p.items) if (!used.has(it) && it.min > 0) return undefined;
        return at;
      }
    }
  }

  /** Where matching stopped, what could have come there, and the children matched before it. */
  private diagnose(p: Particle, kids: XElement[], end: number | undefined): { at: number; expected: string[]; assigned: Array<{ child: XElement; decl?: ElementDecl; wildcard?: Wildcard }> } {
    const names = new Set<string>();
    const first = (q: Particle, d: number): void => {
      if (d > 20) return;
      if (q.kind === 'element') names.add(`<${q.decl.name}>`);
      else if (q.kind === 'elementRef') names.add(`<${q.ref.replace(/^\{.*\}/, '')}>`);
      else if (q.kind === 'any') names.add('any element');
      else if (q.kind === 'groupRef') {
        const g = this.groups.get(q.ref);
        if (g) first(g, d + 1);
      } else if (q.kind === 'choice' || q.kind === 'all') q.items.forEach((i) => first(i, d + 1));
      else for (const i of q.items) {
        first(i, d + 1);
        if (i.min > 0) break;
      }
    };
    const assigned: Array<{ child: XElement; decl?: ElementDecl; wildcard?: Wildcard }> = [];
    if (p.kind === 'all') {
      // xs:all: the required members nobody supplied (any order is fine).
      const present = new Set(kids.map((k) => `{${k.ns}}${k.local}`));
      for (const it of p.items) {
        const d = it.kind === 'element' ? it.decl : it.kind === 'elementRef' ? this.elements.get(it.ref) : undefined;
        if (d && it.min > 0 && !present.has(`{${d.ns}}${d.name}`)) names.add(`<${d.name}>`);
      }
      if (names.size) return { at: kids.length, expected: [...names], assigned };
    }
    if (p.kind === 'sequence' && p.max === 1) {
      let at = 0;
      for (const item of p.items) {
        const tmp: typeof assigned = [];
        const e = this.matchParticle(item, kids, at, tmp, 0);
        if (e === undefined) {
          first(item, 0);
          return { at, expected: [...names], assigned };
        }
        assigned.push(...tmp);
        at = e;
      }
      return { at, expected: [], assigned };
    }
    first(p, 0);
    return { at: end ?? 0, expected: [...names], assigned };
  }

  // ---------------------------------------------------------------- skeletons

  /**
   * A sample instance of a global element: required content with typed sample values, optional
   * elements marked with an "optional" comment, the first option of a choice (others named in a
   * comment). Used to generate SOAP request skeletons from a WSDL.
   */
  skeleton(ns: string, local: string, o: { prefix?: string; maxDepth?: number; allChoices?: boolean } = {}): string {
    this.allChoices = o.allChoices ?? false;
    const decl = this.elements.get(qn(ns, local));
    if (!decl) throw new EzTestError(`No global element {${ns}}${local}`, 'XSD_UNKNOWN_TYPE');
    const prefix = o.prefix ?? 'tns';
    const nsDecls = new Map<string, string>([[ns, prefix]]);
    const body = this.sampleElement(decl, nsDecls, 0, o.maxDepth ?? 12, true, '');
    const decls = [...nsDecls.entries()].map(([u, p]) => (u ? ` xmlns:${p}="${u}"` : '')).join('');
    return body.replace(/^<([^\s>/]+)/, `<$1${decls}`);
  }

  private sampleElement(decl: ElementDecl, nsDecls: Map<string, string>, depth: number, maxDepth: number, top: boolean, indent: string): string {
    if (decl.ns && !nsDecls.has(decl.ns)) nsDecls.set(decl.ns, `ns${nsDecls.size}`);
    const name = decl.ns ? `${nsDecls.get(decl.ns)}:${decl.name}` : decl.name;
    const type = this.resolveType(decl.type) ?? this.resolveType(qn(XS_NS, 'string'))!;
    if (depth > maxDepth) return `${indent}<${name}/><!-- recursion cut -->`;
    if (type.kind === 'simple') return `${indent}<${name}>${escapeSample(decl.fixed ?? decl.default ?? this.sampleValue(type))}</${name}>`;
    const eff = this.effective(type);
    const attrs = eff.attributes.filter((a) => a.use === 'required').map((a) => {
      const t = this.resolveType(a.type ?? qn(XS_NS, 'string')) as SimpleTypeDef;
      return ` ${a.ns ? `${nsDecls.get(a.ns) ?? 'tns'}:` : ''}${a.name}="${escapeSample(a.fixed ?? a.default ?? this.sampleValue(t))}"`;
    }).join('');
    if (eff.simple) return `${indent}<${name}${attrs}>${eff.simple === 'any' ? '?' : escapeSample(this.sampleValue(eff.simple))}</${name}>`;
    if (!eff.particle) return `${indent}<${name}${attrs}/>`;
    const inner = this.sampleParticle(eff.particle, nsDecls, depth + 1, maxDepth, `${indent}  `, false);
    void top;
    return inner.trim() ? `${indent}<${name}${attrs}>\n${inner}\n${indent}</${name}>` : `${indent}<${name}${attrs}/>`;
  }

  private sampleParticle(p: Particle, nsDecls: Map<string, string>, depth: number, maxDepth: number, indent: string, optional: boolean): string {
    const opt = optional || p.min === 0;
    const mark = (s: string) => (p.min === 0 ? `${indent}<!-- optional -->\n${s}` : s);
    switch (p.kind) {
      case 'element':
      case 'elementRef': {
        const decl = p.kind === 'element' ? p.decl : this.elements.get(p.ref);
        if (!decl) return '';
        return mark(this.sampleElement(decl, nsDecls, depth, maxDepth, false, indent));
      }
      case 'any': return `${indent}<!-- any element -->`;
      case 'groupRef': {
        const g = this.groups.get(p.ref);
        return g ? mark(this.sampleParticle(g, nsDecls, depth, maxDepth, indent, opt)) : '';
      }
      case 'choice': {
        const names = p.items.map((i) => (i.kind === 'element' ? i.decl.name : i.kind === 'elementRef' ? i.ref.replace(/^\{.*\}/, '') : i.kind)).join(' | ');
        const firstItem = p.items[0];
        // For filling: every option, each optional (the one given a value is kept).
        if (this.allChoices) return p.items.map((i) => `${indent}<!-- optional -->\n${this.sampleParticle(i, nsDecls, depth, maxDepth, indent, true)}`).join("\n");
        return firstItem ? `${indent}<!-- choice: ${names} -->\n${this.sampleParticle(firstItem, nsDecls, depth, maxDepth, indent, opt)}` : "";
      }
      default:
        return mark(p.items.map((i) => this.sampleParticle(i, nsDecls, depth, maxDepth, indent, opt)).filter(Boolean).join('\n'));
    }
  }

  /** A value of the type that validates (first enumeration value, else a typed sample). */
  sampleValue(t: SimpleTypeDef, depth = 0): string {
    if (depth > 20) return '?';
    if (t.facets.enumeration?.length) return t.facets.enumeration[0];
    if (t.variety === 'list') return this.sampleValue(this.resolveType(t.itemType) as SimpleTypeDef, depth + 1);
    if (t.variety === 'union') return this.sampleValue(this.resolveType(t.memberTypes?.[0]) as SimpleTypeDef, depth + 1);
    if (!t.builtin) {
      const base = this.resolveType(t.base) as SimpleTypeDef | undefined;
      const v = base ? this.sampleValue(base, depth + 1) : '?';
      const f = t.facets;
      if (f.minInclusive !== undefined) return f.minInclusive;
      if (f.minExclusive !== undefined && isNumeric(this.builtinOf(t))) return String(Number(f.minExclusive) + 1);
      if (f.length !== undefined) return 'x'.repeat(f.length);
      if (f.minLength !== undefined && v.length < f.minLength) return v.padEnd(f.minLength, 'x');
      if (f.maxLength !== undefined && v.length > f.maxLength) return v.slice(0, f.maxLength);
      return v;
    }
    const b = builtinChain(t.builtin);
    if (b.includes('integer')) return t.builtin === 'negativeInteger' ? '-1' : t.builtin === 'positiveInteger' ? '1' : '0';
    if (b.includes('decimal') || t.builtin === 'float' || t.builtin === 'double') return '0.0';
    const samples: Record<string, string> = {
      boolean: 'false', date: '2024-01-01', dateTime: '2024-01-01T00:00:00Z', time: '00:00:00', duration: 'P1D', gYear: '2024', gYearMonth: '2024-01', gMonthDay: '--01-01', gDay: '---01', gMonth: '--01',
      base64Binary: '', hexBinary: '', anyURI: 'http://example.com', QName: 'q', NCName: 'name', Name: 'name', ID: 'id1', IDREF: 'id1', NMTOKEN: 'token', language: 'en',
    };
    return samples[t.builtin] ?? '?';
  }
}

function escapeSample(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function isNumeric(builtin: string): boolean {
  return builtinChain(builtin).includes('decimal') || builtin === 'float' || builtin === 'double';
}

function nsAllowed(w: Wildcard, ns: string): boolean {
  if (w.namespaces === '##any') return true;
  if (w.namespaces === '##other') return ns !== w.targetNs && ns !== '';
  return w.namespaces.includes(ns);
}

function text(el: XElement): string {
  return el.children.filter((c) => c.type === 'text').map((c) => (c as { value: string }).value).join('');
}
