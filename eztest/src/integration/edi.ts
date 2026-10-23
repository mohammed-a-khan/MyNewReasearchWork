/**
 * EDI interchanges (ANSI X12 and UN/EDIFACT) parsed into plain JSON for
 * assertions, with envelope checks: segment counts (SE01 / UNT01), control
 * number pairs (ST02/SE02, GS06/GE02, ISA13/IEA02, UNH01/UNT02, UNB05/UNZ02)
 * and transaction/group counts. Segments are objects keyed by element
 * position ({ id: "BEG", BEG01: "00", BEG03: "PO-1" }); `first.BEG` is the
 * first BEG segment, `count.LIN` how many LIN segments there are.
 */
import { EzTestError } from '../core/index.js';

export type EdiSegment = { id: string } & Record<string, string>;

export interface EdiTransaction {
  /** X12 ST01 (e.g. 850) / EDIFACT UNH02 message type (e.g. ORDERS). */
  type: string;
  /** ST02 / UNH01 */
  control: string;
  segments: EdiSegment[];
}

export interface EdiDocument {
  format: 'x12' | 'edifact';
  valid: boolean;
  errors: string[];
  interchange: { sender: string; receiver: string; control: string; date?: string; time?: string };
  groups: Array<{ id: string; control: string; transactions: EdiTransaction[] }>;
  transactions: EdiTransaction[];
  segments: EdiSegment[];
  first: Record<string, EdiSegment>;
  count: Record<string, number>;
}

function seg(id: string, elements: string[]): EdiSegment {
  const s: EdiSegment = { id } as EdiSegment;
  elements.forEach((e, i) => (s[`${id}${String(i + 1).padStart(2, '0')}`] = e));
  return s;
}

function finish(doc: Omit<EdiDocument, 'first' | 'count' | 'valid'>): EdiDocument {
  const first: Record<string, EdiSegment> = {};
  const count: Record<string, number> = {};
  for (const s of doc.segments) {
    first[s.id] ??= s;
    count[s.id] = (count[s.id] ?? 0) + 1;
  }
  return { ...doc, valid: doc.errors.length === 0, first, count };
}

export function parseX12(text: string): EdiDocument {
  const t = text.replace(/^﻿/, '').replace(/^\s+/, '');
  if (!t.startsWith('ISA') || t.length < 106) throw new EzTestError('Not an X12 interchange (no ISA header)', 'EDI_INVALID');
  const elem = t[3];
  const comp = t[104];
  let term = t[105];
  const rest = t.slice(106);
  // Segment terminator followed by line breaks is common; a newline terminator also works.
  if (term === '\r' || term === '\n') term = '\n';
  const raw = t.slice(0, 105).concat(term).concat(rest);
  const parts = raw.split(term).map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, '')).filter((s) => s.length);
  const segments = parts.map((p) => {
    const [id, ...els] = p.split(elem);
    return seg(id, els);
  });
  const errors: string[] = [];
  const isa = segments[0];
  const groups: EdiDocument['groups'] = [];
  const transactions: EdiTransaction[] = [];
  let group: EdiDocument['groups'][number] | undefined;
  let tx: EdiTransaction | undefined;
  for (const s of segments) {
    if (s.id === 'GS') {
      group = { id: s.GS01 ?? '', control: s.GS06 ?? '', transactions: [] };
      groups.push(group);
    } else if (s.id === 'ST') {
      tx = { type: s.ST01 ?? '', control: s.ST02 ?? '', segments: [s] };
      transactions.push(tx);
      (group ?? (groups[0] ??= { id: '', control: '', transactions: [] })).transactions.push(tx);
    } else if (s.id === 'SE') {
      if (!tx) errors.push('SE without ST');
      else {
        tx.segments.push(s);
        if (Number(s.SE01) !== tx.segments.length) errors.push(`transaction ${tx.control}: SE01 says ${s.SE01} segments, found ${tx.segments.length}`);
        if (s.SE02 !== tx.control) errors.push(`transaction ${tx.control}: SE02 ${s.SE02} does not match ST02 ${tx.control}`);
      }
      tx = undefined;
    } else if (s.id === 'GE') {
      if (!group) errors.push('GE without GS');
      else {
        if (Number(s.GE01) !== group.transactions.length) errors.push(`group ${group.control}: GE01 says ${s.GE01} transactions, found ${group.transactions.length}`);
        if (s.GE02 !== group.control) errors.push(`group ${group.control}: GE02 ${s.GE02} does not match GS06 ${group.control}`);
      }
      group = undefined;
    } else if (s.id === 'IEA') {
      if (Number(s.IEA01) !== groups.length) errors.push(`interchange: IEA01 says ${s.IEA01} groups, found ${groups.length}`);
      if (s.IEA02 !== isa.ISA13) errors.push(`interchange: IEA02 ${s.IEA02} does not match ISA13 ${isa.ISA13}`);
    } else if (tx) tx.segments.push(s);
  }
  if (tx) errors.push(`transaction ${tx.control} has no SE`);
  if (!segments.some((s) => s.id === 'IEA')) errors.push('interchange has no IEA trailer');
  void comp;
  return finish({
    format: 'x12', errors,
    interchange: { sender: (isa.ISA06 ?? '').trim(), receiver: (isa.ISA08 ?? '').trim(), control: isa.ISA13 ?? '', date: isa.ISA09, time: isa.ISA10 },
    groups, transactions, segments,
  });
}

export function parseEdifact(text: string): EdiDocument {
  let t = text.replace(/^﻿/, '').trim();
  let comp = ':';
  let elem = '+';
  let release = '?';
  let term = "'";
  if (t.startsWith('UNA')) {
    comp = t[3];
    elem = t[4];
    release = t[6];
    term = t[8];
    t = t.slice(9).replace(/^[\r\n]+/, '');
  }
  // Split on unescaped terminators, then on unescaped element separators.
  const splitEsc = (s: string, sep: string): string[] => {
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === release && i + 1 < s.length) {
        cur += s[i] + s[i + 1];
        i++;
      } else if (s[i] === sep) {
        out.push(cur);
        cur = '';
      } else cur += s[i];
    }
    out.push(cur);
    return out;
  };
  const unescape = (s: string) => s.replace(new RegExp(`\\${release}(.)`, 'g'), '$1');
  const parts = splitEsc(t, term).map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, '')).filter(Boolean);
  const segments = parts.map((p) => {
    const [id, ...els] = splitEsc(p, elem);
    return seg(id, els.map(unescape));
  });
  if (!segments.length || (segments[0].id !== 'UNB' && segments[0].id !== 'UNH')) throw new EzTestError('Not an EDIFACT interchange (no UNB/UNH)', 'EDI_INVALID');
  const errors: string[] = [];
  const unb = segments.find((s) => s.id === 'UNB');
  const transactions: EdiTransaction[] = [];
  const groups: EdiDocument['groups'] = [];
  let group: EdiDocument['groups'][number] | undefined;
  let tx: EdiTransaction | undefined;
  for (const s of segments) {
    if (s.id === 'UNG') {
      group = { id: (s.UNG01 ?? '').split(comp)[0], control: s.UNG05 ?? '', transactions: [] };
      groups.push(group);
    } else if (s.id === 'UNH') {
      tx = { type: (s.UNH02 ?? '').split(comp)[0], control: s.UNH01 ?? '', segments: [s] };
      transactions.push(tx);
      (group ?? (groups[0] ??= { id: '', control: '', transactions: [] })).transactions.push(tx);
    } else if (s.id === 'UNT') {
      if (!tx) errors.push('UNT without UNH');
      else {
        tx.segments.push(s);
        if (Number(s.UNT01) !== tx.segments.length) errors.push(`message ${tx.control}: UNT01 says ${s.UNT01} segments, found ${tx.segments.length}`);
        if (s.UNT02 !== tx.control) errors.push(`message ${tx.control}: UNT02 ${s.UNT02} does not match UNH01 ${tx.control}`);
      }
      tx = undefined;
    } else if (s.id === 'UNE') {
      group = undefined;
    } else if (s.id === 'UNZ') {
      const n = segments.some((x) => x.id === 'UNG') ? groups.length : transactions.length;
      if (Number(s.UNZ01) !== n) errors.push(`interchange: UNZ01 says ${s.UNZ01}, found ${n}`);
      if (unb && s.UNZ02 !== unb.UNB05) errors.push(`interchange: UNZ02 ${s.UNZ02} does not match UNB05 ${unb.UNB05}`);
    } else if (tx) tx.segments.push(s);
  }
  if (tx) errors.push(`message ${tx.control} has no UNT`);
  if (unb && !segments.some((s) => s.id === 'UNZ')) errors.push('interchange has no UNZ trailer');
  const dt = (unb?.UNB04 ?? '').split(comp);
  return finish({
    format: 'edifact', errors,
    interchange: { sender: (unb?.UNB02 ?? '').split(comp)[0], receiver: (unb?.UNB03 ?? '').split(comp)[0], control: unb?.UNB05 ?? '', ...(dt[0] ? { date: dt[0] } : {}), ...(dt[1] ? { time: dt[1] } : {}) },
    groups, transactions, segments,
  });
}

/** Parse X12 or EDIFACT, detected from the first segment. */
export function parseEdi(text: string): EdiDocument {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('ISA')) return parseX12(t);
  if (/^(?:UNA|UNB|UNH)/.test(t)) return parseEdifact(t);
  throw new EzTestError('Not an EDI interchange: expected ISA (X12) or UNA/UNB/UNH (EDIFACT)', 'EDI_INVALID');
}
