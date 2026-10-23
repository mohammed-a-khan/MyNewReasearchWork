/**
 * Grammar for the apiContract expectation (kept free of the spec loader so the
 * intent module stays light), plus the memory of which request produced each
 * captured API response.
 *
 *   Expect response orders to conform to OpenAPI "specs/shop.yaml"
 *   Expect response order conforms to the API spec operation "getOrder"
 */
import type { Condition } from '../core/index.js';
import type { CondRule } from '../intent/conditions.js';
import { literal, quoteText } from '../intent/quotes.js';

const Q = String.raw`⟦\d+⟧`;

export interface ApiRequestMeta {
  method: string;
  url: string;
  requestBody?: unknown;
  requestContentType?: string;
  requestHeaders?: Record<string, string>;
}

const requests = new WeakMap<object, ApiRequestMeta>();

/** Remember the request behind a captured API response (called by the API step). */
export function rememberApiRequest(response: unknown, meta: ApiRequestMeta): void {
  if (response && typeof response === 'object') requests.set(response, meta);
}

export function apiRequestOf(response: unknown): ApiRequestMeta | undefined {
  return response && typeof response === 'object' ? requests.get(response) : undefined;
}

type ApiContractCondition = Extract<Condition, { type: 'apiContract' }>;

export const CONTRACT_CONDITION_RULES: CondRule[] = [
  {
    name: 'api-contract',
    re: new RegExp(
      String.raw`^(?:the\s+)?(?:response\s+)?([\w.]+)(?:\s+response)?\s+(?:conforms\s+to|to\s+conform\s+to|is\s+valid\s+against|complies\s+with|follows|matches)\s+(?:the\s+)?` +
        String.raw`(?:(?:openapi|swagger|api)(?:\s+spec(?:ification)?)?(?:\s+(${Q}))?|(?:api\s+)?contract)(?:\s+(?:for\s+)?operation\s+(${Q}|[\w.-]+))?$`,
      'i',
    ),
    build: (m, q) => ({
      type: 'apiContract',
      captureKey: m[1],
      ...(m[2] ? { spec: literal(m[2], q) } : {}),
      ...(m[3] ? { operation: m[3].startsWith('⟦') ? literal(m[3], q) : m[3] } : {}),
    }),
  },
];

export function apiContractConditionText(c: ApiContractCondition): string {
  return `response ${c.captureKey} conforms to ${c.spec ? `OpenAPI ${quoteText(c.spec)}` : 'the API spec'}${c.operation ? ` operation ${quoteText(c.operation)}` : ''}`;
}
