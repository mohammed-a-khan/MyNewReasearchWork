/**
 * Failure headlines: a short sentence a person reads first ("Expected the URL
 * to contain /pim/viewPersonalDetails/empNumber/"), made from the engine's
 * machine message (`post-condition failed: urlContains: URL does not contain
 * "/pim/..."`). The report shows the headline and keeps the raw message one
 * click away; grouping still uses the raw message and the signature.
 */

const MAX = 160;

const clip = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A quoted value as written in a sentence: a path or URL reads without quotes, text keeps them. */
const val = (v: string) => (/^[/\w.:-]+\/[\w/.:-]*$/.test(v) || /^https?:\/\//.test(v) ? v : `"${v}"`);

/** One failed check of a post-condition ("urlContains: URL does not contain \"/x\""), as a sentence. */
function conditionSentence(type: string, msg: string): string {
  let m: RegExpExecArray | null;
  switch (type) {
    case 'urlContains':
      if ((m = /URL does not contain "([\s\S]*)"/.exec(msg))) return `Expected the URL to contain ${val(m[1])}`;
      break;
    case 'urlMatches':
      if ((m = /URL does not match (\/[\s\S]*\/)/.exec(msg))) return `Expected the URL to match ${m[1]}`;
      break;
    case 'titleContains':
      if ((m = /title does not contain "([\s\S]*)"/.exec(msg))) return `Expected the page title to contain "${m[1]}"`;
      break;
    case 'pageContainsText':
      if ((m = /page does not contain "([\s\S]*)"/.exec(msg))) return `Expected the page to show "${m[1]}"`;
      break;
    case 'pageNotContainsText':
      if ((m = /page contains "([\s\S]*)"/.exec(msg))) return `Expected the page not to show "${m[1]}"`;
      break;
    case 'textEquals':
      if ((m = /^([\s\S]+?) text is "([\s\S]*)", expected "([\s\S]*)"$/.exec(msg))) return `Expected ${m[1]} to read "${m[3]}", but it reads "${m[2]}"`;
      break;
    case 'textContains':
      if ((m = /^([\s\S]+?) text "([\s\S]*)" does not contain "([\s\S]*)"$/.exec(msg))) return `Expected ${m[1]} to contain "${m[3]}"`;
      break;
    case 'valueEquals':
      if ((m = /^([\s\S]+?) value is "([\s\S]*)", expected "([\s\S]*)"$/.exec(msg))) return `Expected ${m[1]} to have the value "${m[3]}", but it was "${m[2]}"`;
      break;
    case 'visible':
      if ((m = /^([\s\S]+?) is not visible$/.exec(msg))) return `Expected ${m[1]} to be visible`;
      break;
    case 'hidden':
      if ((m = /^([\s\S]+?) is visible\b/.exec(msg))) return `Expected ${m[1]} to be hidden`;
      break;
    case 'count':
      if ((m = /^([\s\S]+?): found (\d+), expected (\d+)$/.exec(msg))) return `Expected ${m[3]} of ${m[1]}, found ${m[2]}`;
      break;
    case 'ledgerEquals':
      if ((m = /^([\s\S]+?) is "([\s\S]*)", expected "([\s\S]*)"$/.exec(msg))) return `Expected ${m[1]} to be "${m[3]}", but it was "${m[2]}"`;
      break;
    default:
      break;
  }
  if (/: not found exactly once/.test(msg)) return `Could not find ${msg.split(':')[0]} on the page`;
  return `${cap(msg)} (${type})`;
}

/** Split "a: x; b: y; did you mean ..." into the checks, dropping the hints the engine appends. */
function conditions(rest: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of rest.split(/;\s+(?=[a-zA-Z]+: )/)) {
    const m = /^([a-zA-Z]+): ([\s\S]*)$/.exec(part.trim());
    if (!m || /^(did you mean|console error|failed request|hint)$/i.test(m[1])) continue;
    out.push([m[1], m[2].split(/;\s+(did you mean|console error)/i)[0].trim()]);
  }
  return out;
}

/**
 * The headline of a failure message: a short human sentence, or the message's first line when no
 * rule recognises it (with a technical prefix such as "Error: " removed). Never longer than 160 characters.
 */
export function failureHeadline(message: string | undefined): string {
  const raw = String(message ?? '').trim();
  if (!raw) return 'Failed';
  const first = raw.split('\n')[0].trim();
  let m: RegExpExecArray | null;
  if ((m = /^post-condition failed(?: after the manual step)?: ([\s\S]*)$/i.exec(first))) {
    const cs = conditions(m[1]);
    if (cs.length) {
      const head = conditionSentence(cs[0][0], cs[0][1]);
      return clip(cs.length > 1 ? `${head} (and ${cs.length - 1} more check${cs.length > 2 ? 's' : ''})` : head);
    }
  }
  if (/^query returned no rows$/i.test(first) || /\bNO_ROWS\b/.test(first)) return 'The database query returned no rows';
  if ((m = /^\[([^\]]+)\] ([\s\S]*?)(?:: )?syntax error$/i.exec(first))) return clip(`The SQL query on ${m[1]} has a syntax error${m[2] ? ` (${m[2].trim()})` : ''}`);
  if ((m = /^expected ([\s\S]+?) to (be|equal|contain|match) ("[\s\S]*"|\S+) \(actual: ([\s\S]*)\)$/i.exec(first))) return clip(`Expected ${m[1]} to ${m[2]} ${m[3]}, but it was ${m[4]}`);
  if ((m = /^no locator candidate matched exactly one element for ([\s\S]+?)(?:;|$)/i.exec(first))) return clip(`Could not find ${m[1].replace(/\s+on\s*$/, '')} on the page`);
  if ((m = /^(?:[\w.]+: )?Timeout (\d+) ?ms exceeded/i.exec(first))) {
    const s = Number(m[1]) / 1000;
    const what = /waiting for ([\s\S]+?)(?:$|\n| to be )/.exec(raw);
    return clip(`Timed out after ${s % 1 ? s.toFixed(1) : s} s${what ? ` waiting for ${what[1].trim()}` : ''}`);
  }
  if (/ECONNREFUSED|net::ERR_CONNECTION_REFUSED/.test(first)) return 'The application could not be reached (connection refused)';
  if (/ENOTFOUND|net::ERR_NAME_NOT_RESOLVED|getaddrinfo/.test(first)) return 'The application’s host name could not be resolved';
  if ((m = /^expected status (\d+)[^\d]+(\d+)/i.exec(first))) return `Expected HTTP status ${m[1]}, got ${m[2]}`;
  const plain = first.replace(/^(?:Ez\w*Error|Error|AssertionError|TypeError|EzTestError):\s*/, '').replace(/;\s+(did you mean|console error)[\s\S]*$/i, '');
  return clip(cap(plain));
}
