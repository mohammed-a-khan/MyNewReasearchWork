/**
 * The Azure Test Plans test case formats, both directions:
 *
 *  - `Microsoft.VSTS.TCM.Steps`: `<steps>` with `<step type="ActionStep|ValidateStep">`
 *    (two `parameterizedString`s: action and expected result, HTML inside
 *    XML) and `<compref ref="<shared steps id>">` references to Shared Steps;
 *  - `Microsoft.VSTS.TCM.Parameters`: `<parameters><param name=".." bind="default"/></parameters>`;
 *  - `Microsoft.VSTS.TCM.LocalDataSource`: the parameter values, either a
 *    `NewDataSet` table or, for shared parameters, JSON naming the Shared
 *    Parameter work items whose `<parameterSet>` holds the rows.
 */
import { XMLParser } from 'fast-xml-parser';

export interface TcStep {
  /** Step id inside the test case (actionPath is its 8-digit hex). */
  id: number;
  kind: 'step';
  action: string;
  expected: string;
  type: 'ActionStep' | 'ValidateStep';
}

export interface TcSharedRef {
  id: number;
  kind: 'shared';
  /** Work item id of the Shared Steps. */
  ref: number;
}

export type TcItem = TcStep | TcSharedRef;

export interface TcParameters {
  names: string[];
  rows: Array<Record<string, string>>;
  /** Shared Parameter work items the rows come from. */
  sharedSetIds?: number[];
  /** local name -> shared parameter name */
  sharedMap?: Record<string, string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  trimValues: false,
  processEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

type Node = Record<string, unknown> & { ':@'?: Record<string, string> };

function children(n: Node, tag: string): Node[] {
  return (n[tag] as Node[] | undefined) ?? [];
}

function text(nodes: Node[]): string {
  return nodes.map((n) => (typeof n['#text'] === 'string' ? (n['#text'] as string) : Object.keys(n).filter((k) => k !== ':@').map((k) => text(children(n, k))).join(''))).join('');
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML (as stored in parameterizedString) to plain text: paragraphs and breaks become newlines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function textToHtml(t: string): string {
  if (!t.trim()) return '';
  return `<DIV>${t.split('\n').map((l) => `<P>${escHtml(l)}</P>`).join('')}</DIV>`;
}

/** Parse a Steps field. Steps nested in a compref (an ADO quirk) are returned after the reference. */
export function parseStepsXml(xml: string | undefined): TcItem[] {
  if (!xml || !xml.trim()) return [];
  const doc = parser.parse(xml) as Node[];
  const root = doc.find((n) => 'steps' in n);
  if (!root) return [];
  const out: TcItem[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      const a = n[':@'] ?? {};
      if ('step' in n) {
        const strs = children(n, 'step').filter((c) => 'parameterizedString' in c);
        const action = htmlToText(text(children(strs[0] ?? {}, 'parameterizedString')));
        const expected = htmlToText(text(children(strs[1] ?? {}, 'parameterizedString')));
        out.push({ id: Number(a['@id']), kind: 'step', action, expected, type: a['@type'] === 'ValidateStep' ? 'ValidateStep' : 'ActionStep' });
      } else if ('compref' in n) {
        out.push({ id: Number(a['@id']), kind: 'shared', ref: Number(a['@ref']) });
        walk(children(n, 'compref'));
      }
    }
  };
  walk(children(root, 'steps'));
  return out;
}

/** Build a Steps field from action/expected pairs (ids 2, 3, ...; ValidateStep when there is an expected result). */
export function buildStepsXml(steps: Array<{ action: string; expected?: string } | { sharedRef: number }>): string {
  let id = 1;
  const parts = steps.map((s) => {
    id++;
    if ('sharedRef' in s) return `<compref id="${id}" ref="${s.sharedRef}" />`;
    const type = s.expected?.trim() ? 'ValidateStep' : 'ActionStep';
    return `<step id="${id}" type="${type}"><parameterizedString isformatted="true">${escXml(textToHtml(s.action))}</parameterizedString><parameterizedString isformatted="true">${escXml(textToHtml(s.expected ?? ''))}</parameterizedString><description/></step>`;
  });
  return `<steps id="0" last="${id}">${parts.join('')}</steps>`;
}

/** The actionPath of a step (8 hex digits per level: shared step children are prefixed by their compref's path). */
export function actionPath(...ids: number[]): string {
  return ids.map((i) => i.toString(16).toUpperCase().padStart(8, '0')).join('');
}

/** Parameter names declared in Microsoft.VSTS.TCM.Parameters. */
export function parseParameterNames(xml: string | undefined): string[] {
  if (!xml?.trim()) return [];
  return [...xml.matchAll(/<param\b[^>]*\bname="([^"]+)"/g)].map((m) => decodeXml(m[1]));
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENT[e]);
}

/** Rows of a LocalDataSource `NewDataSet` (one `<Table1>` per row). */
function parseDataSet(xml: string, names: string[]): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const body = xml.replace(/<xs:schema[\s\S]*?<\/xs:schema>/, '');
  for (const m of body.matchAll(/<(Table\d+)>([\s\S]*?)<\/\1>/g)) {
    const row: Record<string, string> = {};
    for (const c of m[2].matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>|<([A-Za-z_][\w.-]*)\s*\/>/g)) {
      if (c[3]) row[c[3]] = '';
      else row[c[1]] = decodeXml(c[2]);
    }
    for (const n of names) row[n] ??= '';
    rows.push(row);
  }
  return rows;
}

/** Rows of a Shared Parameter work item (`<parameterSet>`). */
export function parseSharedParameterSet(xml: string | undefined): { names: string[]; rows: Array<Record<string, string>> } {
  if (!xml?.trim()) return { names: [], rows: [] };
  const names = [...xml.matchAll(/<param>([^<]*)<\/param>/g)].map((m) => decodeXml(m[1]));
  const rows: Array<Record<string, string>> = [];
  for (const r of xml.matchAll(/<dataRow\b[^>]*>([\s\S]*?)<\/dataRow>/g)) {
    const row: Record<string, string> = {};
    for (const kv of r[1].matchAll(/<kvp\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g)) row[decodeXml(kv[1])] = decodeXml(kv[2]);
    for (const n of names) row[n] ??= '';
    rows.push(row);
  }
  return { names, rows };
}

/** Parameters and rows of a test case (local data, or the shared parameter mapping to resolve). */
export function parseTestCaseParameters(paramsXml: string | undefined, localDataSource: string | undefined): TcParameters {
  const names = parseParameterNames(paramsXml);
  const ds = (localDataSource ?? '').trim();
  if (ds.startsWith('{')) {
    try {
      const j = JSON.parse(ds) as { parameterMap?: Array<{ localParamName: string; sharedParameterName: string; sharedParameterDataSetId: number }>; sharedParameterDataSetIds?: number[] };
      const sharedMap: Record<string, string> = {};
      for (const p of j.parameterMap ?? []) sharedMap[p.localParamName] = p.sharedParameterName;
      return { names, rows: [], sharedSetIds: j.sharedParameterDataSetIds ?? [...new Set((j.parameterMap ?? []).map((p) => p.sharedParameterDataSetId))], sharedMap };
    } catch {
      return { names, rows: [] };
    }
  }
  return { names, rows: ds ? parseDataSet(ds, names) : [] };
}

/** Parameters field for names. */
export function buildParametersXml(names: string[]): string {
  return `<parameters>${names.map((n) => `<param name="${escXml(n)}" bind="default" />`).join('')}</parameters>`;
}

/** LocalDataSource field (NewDataSet with an inline schema) for rows. */
export function buildDataSourceXml(names: string[], rows: Array<Record<string, string>>): string {
  const schema = `<xs:schema id="NewDataSet" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata"><xs:element name="NewDataSet" msdata:IsDataSet="true" msdata:Locale=""><xs:complexType><xs:choice minOccurs="0" maxOccurs="unbounded"><xs:element name="Table1"><xs:complexType><xs:sequence>${names.map((n) => `<xs:element name="${escXml(n)}" type="xs:string" minOccurs="0" />`).join('')}</xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType></xs:element></xs:schema>`;
  const body = rows.map((r) => `<Table1>${names.map((n) => `<${n}>${escXml(r[n] ?? '')}</${n}>`).join('')}</Table1>`).join('');
  return `<NewDataSet>${schema}${body}</NewDataSet>`;
}

/** Replace ADO `@param` references with EZTest `<param>` placeholders (declared names only). */
export function adoParamsToEz(s: string, names: string[]): string {
  let out = s;
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^\\w@.])@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g'), `$1<${n}>`);
  }
  return out;
}

/** Replace EZTest `<param>` placeholders with ADO `@param` references. */
export function ezParamsToAdo(s: string, names: string[]): string {
  let out = s;
  for (const n of names) out = out.split(`<${n}>`).join(`@${n}`);
  return out;
}
