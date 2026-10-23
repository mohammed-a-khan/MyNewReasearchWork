/** A contract from an `eztest mock` store: every recording becomes an expectation with inferred matchers. */
import { decodeBody, isJsonContentType, type MockStore } from '../mocks/store.js';
import { inferMatchers, type Contract, type Expectation, type MatcherStyle } from './model.js';

export function contractFromMockStore(store: MockStore, consumer: string, provider: string, style: MatcherStyle = 'type'): Contract {
  const expectations: Expectation[] = [];
  const seen = new Set<string>();
  for (const r of store.recordings) {
    const reqCt = Object.entries(r.request.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const resCt = Object.entries(r.response.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const parse = (text: string | undefined, ct: string | undefined): unknown => {
      if (text === undefined || text === '') return undefined;
      if (isJsonContentType(ct)) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return text;
    };
    const resText = decodeBody(r.response.body, r.response.bodyEncoding).toString('utf8');
    const body = parse(resText, resCt);
    const query: Record<string, string[]> = {};
    for (const [k, v] of new URLSearchParams(r.request.query)) (query[k] ??= []).push(v);
    let description = `${r.request.method} ${r.request.path}${r.request.query ? `?${r.request.query}` : ''} -> ${r.response.status}`;
    for (let n = 2; seen.has(description); n++) description = `${description} (${n})`;
    seen.add(description);
    const match = body !== undefined && typeof body === 'object' ? inferMatchers(body, style) : {};
    expectations.push({
      description, given: [],
      request: {
        method: r.request.method, path: r.request.path, ...(Object.keys(query).length ? { query } : {}),
        ...(reqCt ? { headers: { 'Content-Type': reqCt } } : {}),
        ...(r.request.body ? { body: parse(r.request.body, reqCt) } : {}),
      },
      response: {
        status: r.response.status, ...(resCt ? { headers: { 'Content-Type': resCt } } : {}),
        ...(body !== undefined ? { body } : {}), ...(Object.keys(match).length ? { match } : {}),
      },
    });
  }
  return { consumer, provider, expectations };
}
