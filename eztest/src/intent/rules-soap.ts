/**
 * SOAP operations of configured services (soap.services, docs/soap.md):
 *
 *   Call SOAP operation "GetPolicy" on "policy" with PolicyId = "P-100" and store as policy
 *   Call SOAP operation "SearchPolicies" on policy with '{"Status": "Active", "MaxResults": 5}'
 *   Call SOAP operation "GetPolicy" on policy with body "<p:GetPolicy ...>...</p:GetPolicy>"
 *   Call SOAP operation "GetPolicy" on policy with file "requests/get-policy.xml" allowing faults
 *
 * They are custom steps (handler "eztest.soap") run by the SOAP service client:
 * request built from the WSDL, XSD-validated, WS-Security applied, response
 * verified and validated. "Call SOAP action ... on /url with body ..." (a raw
 * envelope to a URL) stays the API step it always was.
 */
import { literal } from './quotes.js';
import type { IntentRule } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;
const V = (s: string, q: string[]) => literal(s, q);

/** "A = "x", B.C = 5 and D = "y"" -> { A: 'x', 'B.C': '5', D: 'y' }; undefined when it is not that shape. */
function assignments(s: string, q: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const re = new RegExp(String.raw`\s*([A-Za-z_][\w.-]*)\s*(?:=|:|\bto\b)\s*(${Q}|[^\s,]+)\s*(?:,|\band\b|$)`, 'iy');
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return undefined;
    out[m[1]] = V(m[2], q);
    at = re.lastIndex;
  }
  return Object.keys(out).length ? out : undefined;
}

export const SOAP_STEP_HANDLER = 'eztest.soap';

export const SOAP_RULES: IntentRule[] = [
  { name: 'soap-operation', keywords: ['call', 'invoke', 'send'], category: 'API', example: 'Call SOAP operation "GetPolicy" on "policy" with PolicyId = "P-100" and store as policy',
    re: new RegExp(String.raw`^(?:call|invoke|send)\s+(?:the\s+)?soap\s+operation\s+(${Q}|[A-Za-z_][\w.-]*)\s+(?:on|of)\s+(?:the\s+)?(?:service\s+)?(${Q}|[A-Za-z_][\w.-]*)(?:\s+(?:service\s+)?with\s+(.+?))?(\s+allowing\s+faults?)?(?:\s+(?:and\s+)?(?:store|save)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const operation = V(m[1], q);
      const service = V(m[2], q);
      // A URL or path is the raw "Call SOAP action ... on /url with body" API step, not a configured service.
      if (/^(?:\/|https?:)/i.test(service)) return undefined;
      const args: Record<string, unknown> = { service, operation };
      const w = m[3]?.trim();
      if (w) {
        const body = new RegExp(String.raw`^(?:the\s+)?body\s+(${Q})$`, 'i').exec(w);
        const file = new RegExp(String.raw`^(?:the\s+)?(?:request\s+)?file\s+(${Q}|\S+)$`, 'i').exec(w);
        const json = new RegExp(String.raw`^(?:values?\s+)?(${Q})$`, 'i').exec(w);
        if (body) args.body = V(body[1], q);
        else if (file) args.file = V(file[1], q);
        else if (json) {
          const text = V(json[1], q);
          if (!/^\s*\{/.test(text)) return undefined;
          args.json = text;
        } else {
          const p = assignments(w, q);
          if (!p) return undefined;
          args.params = p;
        }
      }
      if (m[4]) args.allowFault = true;
      return { action: 'custom', handler: SOAP_STEP_HANDLER, args, captureAs: m[5] ?? 'response' };
    } },
];

/** The .ez text of a SOAP operation step. */
export function soapStepToText(args: Record<string, unknown>, captureAs: string | undefined, quote: (s: string) => string): string {
  const parts = [`Call SOAP operation ${quote(String(args.operation))} on ${quote(String(args.service))}`];
  if (args.params && typeof args.params === 'object') parts.push(`with ${Object.entries(args.params as Record<string, string>).map(([k, v]) => `${k} = ${quote(String(v))}`).join(', ')}`);
  else if (args.body !== undefined) parts.push(`with body ${quote(String(args.body))}`);
  else if (args.file !== undefined) parts.push(`with file ${quote(String(args.file))}`);
  else if (args.json !== undefined) parts.push(`with ${quote(String(args.json))}`);
  if (args.allowFault) parts.push('allowing faults');
  if (captureAs && captureAs !== 'response') parts.push(`and store as ${captureAs}`);
  return parts.join(' ');
}
