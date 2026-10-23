/** Minimal XML property lists (dict, array, string, integer, real, true/false, data), for the usbmuxd protocol. */
import { XMLParser } from 'fast-xml-parser';

export type PlistValue = string | number | boolean | Buffer | PlistValue[] | { [k: string]: PlistValue };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function write(v: PlistValue): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString('base64')}</data>`;
  if (Array.isArray(v)) return `<array>${v.map(write).join('')}</array>`;
  return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${write(x)}`).join('')}</dict>`;
}

export function buildPlist(v: PlistValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${write(v)}</plist>\n`;
}

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, parseTagValue: false, trimValues: true, processEntities: true });

type Node = Record<string, unknown>;

function tagOf(n: Node): string {
  return Object.keys(n).find((k) => k !== ':@')!;
}

function textOf(kids: Node[]): string {
  return kids.map((k) => (typeof k['#text'] === 'string' ? (k['#text'] as string) : '')).join('');
}

function read(n: Node): PlistValue {
  const tag = tagOf(n);
  const kids = (n[tag] as Node[]) ?? [];
  switch (tag) {
    case 'string': return textOf(kids);
    case 'integer': return Number(textOf(kids));
    case 'real': return Number(textOf(kids));
    case 'true': return true;
    case 'false': return false;
    case 'data': return Buffer.from(textOf(kids).replace(/\s+/g, ''), 'base64');
    case 'array': return kids.filter((k) => !('#text' in k)).map(read);
    case 'dict': {
      const out: Record<string, PlistValue> = {};
      const items = kids.filter((k) => !('#text' in k));
      for (let i = 0; i + 1 < items.length; i += 2) out[textOf(items[i].key as Node[])] = read(items[i + 1]);
      return out;
    }
    default: throw new Error(`plist: unsupported element <${tag}>`);
  }
}

export function parsePlist(xml: string): PlistValue {
  const doc = parser.parse(xml) as Node[];
  const plist = doc.find((n) => tagOf(n) === 'plist');
  const root = ((plist?.plist as Node[]) ?? []).find((n) => !('#text' in n));
  if (!root) throw new Error('plist: no value');
  return read(root);
}
