/**
 * The 3270 presentation space: a character buffer plus field attributes,
 * driven by the outbound 3270 data stream (Write, Erase/Write, Erase/Write
 * Alternate, Erase All Unprotected, Write Structured Field) and producing the
 * inbound stream (Read Modified, Read Buffer, Query Reply).
 *
 * Addresses are 0-based offsets into the buffer; rows and columns in the
 * public helpers are 1-based, as mainframe screen specs are written.
 */
import { CODE_TABLE, charToEbcdic, decodeAddress, ebcdicToChar, encodeAddress, isEbcdicEncodable } from './ebcdic.js';

// ---------------------------------------------------------------- data stream constants
export const CMD = {
  W: [0xf1, 0x01], EW: [0xf5, 0x05], EWA: [0x7e, 0x0d], RB: [0xf2, 0x02], RM: [0xf6, 0x06], RMA: [0x6e, 0x0e], EAU: [0x6f, 0x0f], WSF: [0xf3, 0x11],
} as const;
export const ORDER = { SF: 0x1d, SFE: 0x29, SBA: 0x11, SA: 0x28, MF: 0x2c, IC: 0x13, PT: 0x05, RA: 0x3c, EUA: 0x12, GE: 0x08 } as const;

/** Attention identifiers. */
export const AID: Record<string, number> = {
  NONE: 0x60, ENTER: 0x7d, CLEAR: 0x6d, PA1: 0x6c, PA2: 0x6e, PA3: 0x6b, SYSREQ: 0xf0, SF: 0x88,
  PF1: 0xf1, PF2: 0xf2, PF3: 0xf3, PF4: 0xf4, PF5: 0xf5, PF6: 0xf6, PF7: 0xf7, PF8: 0xf8, PF9: 0xf9, PF10: 0x7a, PF11: 0x7b, PF12: 0x7c,
  PF13: 0xc1, PF14: 0xc2, PF15: 0xc3, PF16: 0xc4, PF17: 0xc5, PF18: 0xc6, PF19: 0xc7, PF20: 0xc8, PF21: 0xc9, PF22: 0x4a, PF23: 0x4b, PF24: 0x4c,
};
const SHORT_READ = new Set([AID.CLEAR, AID.PA1, AID.PA2, AID.PA3]);

/** Normalise a key name ("Enter", "PF3", "F3", "pa1", "Clear", "SysReq") to an AID name, or undefined. */
export function aidName(key: string): string | undefined {
  const k = key.trim().toUpperCase().replace(/\s+/g, '');
  if (k === 'ENTER' || k === 'RETURN') return 'ENTER';
  if (k === 'CLEAR') return 'CLEAR';
  if (k === 'SYSREQ' || k === 'ATTN' || k === 'TESTREQ') return 'SYSREQ';
  const pf = /^(?:PF|F)(\d{1,2})$/.exec(k);
  if (pf && Number(pf[1]) >= 1 && Number(pf[1]) <= 24) return `PF${Number(pf[1])}`;
  const pa = /^PA([1-3])$/.exec(k);
  if (pa) return `PA${pa[1]}`;
  return undefined;
}

export const MODELS: Record<number, { rows: number; cols: number }> = { 2: { rows: 24, cols: 80 }, 3: { rows: 32, cols: 80 }, 4: { rows: 43, cols: 80 }, 5: { rows: 27, cols: 132 } };

const isProt = (a: number) => (a & 0x20) !== 0;
const isNum = (a: number) => (a & 0x10) !== 0;
const isHidden = (a: number) => (a & 0x0c) === 0x0c;
const isIntense = (a: number) => (a & 0x0c) === 0x08;

/** A field as seen by tests: 1-based row/column of its first character (the position after the attribute byte). */
export interface ScreenField {
  /** Buffer address of the attribute byte. */
  attrAddress: number;
  /** Buffer address of the first data character. */
  address: number;
  row: number;
  col: number;
  length: number;
  protected: boolean;
  numeric: boolean;
  hidden: boolean;
  intensified: boolean;
  modified: boolean;
  /** Field content (blank for hidden fields in snapshots; see `rawValue`). */
  value: string;
}

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  cursor: { row: number; col: number };
  keyboardLocked: boolean;
  /** Screen text, one string per row; hidden (non-display) fields are blank. */
  text: string[];
  fields: Array<Omit<ScreenField, 'attrAddress' | 'address'>>;
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

export class Screen3270 {
  rows: number;
  cols: number;
  /** EBCDIC bytes; 0x00 is a null (displays blank). */
  buffer: Uint8Array;
  /** Field attribute byte at an address, or -1. */
  attr: Int16Array;
  cursor = 0;
  keyboardLocked = true;
  alarm = false;
  /** Bumped on every host write (used to wait for a new screen). */
  version = 0;
  private alternate = false;

  constructor(readonly model = 2, private readonly defaults = { rows: 24, cols: 80 }) {
    const alt = MODELS[model] ?? MODELS[2];
    this.altSize = alt;
    this.rows = defaults.rows;
    this.cols = defaults.cols;
    this.buffer = new Uint8Array(this.rows * this.cols);
    this.attr = new Int16Array(this.rows * this.cols).fill(-1);
  }

  readonly altSize: { rows: number; cols: number };

  get size(): number {
    return this.rows * this.cols;
  }

  private resize(alternate: boolean): void {
    this.alternate = alternate;
    const s = alternate ? this.altSize : this.defaults;
    this.rows = s.rows;
    this.cols = s.cols;
    this.buffer = new Uint8Array(this.rows * this.cols);
    this.attr = new Int16Array(this.rows * this.cols).fill(-1);
    this.cursor = 0;
  }

  /** 0-based address of 1-based row/col. */
  addressOf(row: number, col: number): number {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || row > this.rows || col > this.cols) {
      throw new TerminalError(`row ${row} column ${col} is outside the ${this.rows}x${this.cols} screen`);
    }
    return (row - 1) * this.cols + (col - 1);
  }

  rowCol(addr: number): { row: number; col: number } {
    return { row: Math.floor(addr / this.cols) + 1, col: (addr % this.cols) + 1 };
  }

  private wrap(a: number): number {
    return ((a % this.size) + this.size) % this.size;
  }

  // ---------------------------------------------------------------- fields

  /** True when the screen has at least one field (a formatted screen). */
  get formatted(): boolean {
    for (let i = 0; i < this.size; i++) if (this.attr[i] >= 0) return true;
    return false;
  }

  /** Address of the attribute byte governing `addr` (-1 on an unformatted screen). */
  fieldAttrAddress(addr: number): number {
    for (let i = 0; i < this.size; i++) {
      const a = this.wrap(addr - i);
      if (this.attr[a] >= 0) return a;
    }
    return -1;
  }

  /** All fields, in buffer order. */
  fields(): ScreenField[] {
    const starts: number[] = [];
    for (let i = 0; i < this.size; i++) if (this.attr[i] >= 0) starts.push(i);
    return starts.map((s, k) => {
      const next = starts[(k + 1) % starts.length];
      const length = starts.length === 1 ? this.size - 1 : this.wrap(next - s) - 1;
      return this.describeField(s, length);
    });
  }

  private describeField(attrAddr: number, length: number): ScreenField {
    const a = this.attr[attrAddr];
    const address = this.wrap(attrAddr + 1);
    const rc = this.rowCol(address);
    return {
      attrAddress: attrAddr, address, row: rc.row, col: rc.col, length,
      protected: isProt(a), numeric: isNum(a), hidden: isHidden(a), intensified: isIntense(a), modified: (a & 1) === 1,
      value: this.readRange(address, length),
    };
  }

  /** The field containing an address (undefined on an attribute byte or unformatted screen). */
  fieldAt(addr: number): ScreenField | undefined {
    if (this.attr[addr] >= 0) return undefined;
    const fa = this.fieldAttrAddress(addr);
    if (fa < 0) return undefined;
    return this.fields().find((f) => f.attrAddress === fa);
  }

  /** Text of `length` positions from `addr` (nulls and controls as blanks). */
  readRange(addr: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) {
      const a = this.wrap(addr + i);
      s += this.attr[a] >= 0 ? ' ' : this.buffer[a] === 0 ? ' ' : ebcdicToChar(this.buffer[a]);
    }
    return s;
  }

  /** Screen rows as text. Hidden (non-display) field content is blanked unless `revealHidden`. */
  textRows(revealHidden = false): string[] {
    const hidden = new Uint8Array(this.size);
    if (!revealHidden) {
      for (const f of this.fields()) if (f.hidden) for (let i = 0; i < f.length; i++) hidden[this.wrap(f.address + i)] = 1;
    }
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) {
        const a = r * this.cols + c;
        s += hidden[a] || this.attr[a] >= 0 || this.buffer[a] === 0 ? ' ' : ebcdicToChar(this.buffer[a]);
      }
      out.push(s);
    }
    return out;
  }

  text(): string {
    return this.textRows().join('\n');
  }

  snapshot(): ScreenSnapshot {
    const cur = this.rowCol(this.cursor);
    return {
      rows: this.rows, cols: this.cols, cursor: cur, keyboardLocked: this.keyboardLocked, text: this.textRows(),
      fields: this.fields().map(({ attrAddress: _a, address: _b, ...f }) => ({ ...f, value: f.hidden ? '' : f.value })),
    };
  }

  // ---------------------------------------------------------------- typing (the operator side)

  /** The first unprotected field at or after `addr` (wrapping), or undefined. */
  nextUnprotected(addr: number): ScreenField | undefined {
    const fields = this.fields().filter((f) => !f.protected && f.length > 0);
    if (!fields.length) return undefined;
    return fields.find((f) => f.address >= addr) ?? fields[0];
  }

  /** Type text at an address, as an operator would (field rules enforced). */
  typeAt(addr: number, text: string): void {
    if (this.keyboardLocked) throw new TerminalError('the keyboard is locked (the host has not finished; wait for the screen)');
    if (!this.formatted) {
      for (let i = 0; i < text.length; i++) this.putChar(this.wrap(addr + i), text[i]);
      this.cursor = this.wrap(addr + text.length);
      return;
    }
    const f = this.fieldAt(addr);
    const where = this.rowCol(addr);
    if (!f) throw new TerminalError(`row ${where.row} column ${where.col} is a field attribute position, not an input field`);
    if (f.protected) throw new TerminalError(`row ${where.row} column ${where.col} is in a protected field ("${f.value.trim()}")`);
    const room = f.length - this.wrap(addr - f.address);
    if (text.length > room) throw new TerminalError(`"${text}" (${text.length} characters) does not fit the field at row ${where.row} column ${where.col} (${room} positions left)`);
    if (f.numeric && !/^[0-9.,+\- ]*$/.test(text)) throw new TerminalError(`the field at row ${f.row} column ${f.col} is numeric; "${text}" is not a number`);
    for (let i = 0; i < text.length; i++) this.putChar(this.wrap(addr + i), text[i]);
    this.attr[f.attrAddress] |= 1; // MDT
    this.cursor = this.wrap(addr + text.length);
  }

  /** Replace a field's content: nulls first, then the text from its first position. */
  fillField(f: ScreenField, text: string): void {
    if (f.protected) throw new TerminalError(`the field at row ${f.row} column ${f.col} is protected`);
    if (this.keyboardLocked) throw new TerminalError('the keyboard is locked (the host has not finished; wait for the screen)');
    for (let i = 0; i < f.length; i++) this.buffer[this.wrap(f.address + i)] = 0;
    this.attr[f.attrAddress] |= 1;
    this.typeAt(f.address, text);
  }

  private putChar(addr: number, ch: string): void {
    if (!isEbcdicEncodable(ch)) throw new TerminalError(`"${ch}" cannot be typed on a 3270 (no EBCDIC code)`);
    this.buffer[addr] = charToEbcdic(ch);
  }

  /** Null an input field from `addr` to its end (Erase EOF) and mark it modified. */
  eraseToEndOfField(addr: number): void {
    const f = this.fieldAt(addr);
    if (!f || f.protected) throw new TerminalError('Erase EOF: the cursor is not in an input field');
    for (let a = addr; a < f.address + f.length; a++) this.buffer[this.wrap(a)] = 0;
    this.attr[f.attrAddress] |= 1;
  }

  /** The Clear key also clears the presentation space locally. */
  clearLocal(): void {
    this.resize(false);
  }

  // ---------------------------------------------------------------- inbound (terminal -> host)

  /** Read Modified (or Read Modified All) inbound data for an AID. */
  readModified(aid: number, all = false): Buffer {
    const out: number[] = [aid];
    if (SHORT_READ.has(aid) && !all) return Buffer.from(out);
    out.push(...encodeAddress(this.cursor));
    if (!this.formatted) {
      for (let i = 0; i < this.size; i++) if (this.buffer[i]) out.push(this.buffer[i]);
      return Buffer.from(out);
    }
    for (const f of this.fields()) {
      if (!f.modified) continue;
      out.push(ORDER.SBA, ...encodeAddress(f.address));
      for (let i = 0; i < f.length; i++) {
        const b = this.buffer[this.wrap(f.address + i)];
        if (b) out.push(b);
      }
    }
    return Buffer.from(out);
  }

  /** Read Buffer inbound data. */
  readBuffer(aid: number): Buffer {
    const out: number[] = [aid, ...encodeAddress(this.cursor)];
    for (let i = 0; i < this.size; i++) {
      if (this.attr[i] >= 0) out.push(ORDER.SF, CODE_TABLE[this.attr[i] & 0x3f]);
      else out.push(this.buffer[i]);
    }
    return Buffer.from(out);
  }

  /** Query Reply (Summary, Usable Area, Implicit Partition) for a Read Partition Query. */
  queryReply(): Buffer {
    const w = this.altSize.cols;
    const hgt = this.altSize.rows;
    const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    const summary = [0x81, 0x80, 0x80, 0x81, 0xa6];
    const usable = [0x81, 0x81, 0x01, 0x00, ...be16(w), ...be16(hgt), 0x01, 0x00, 0x0a, 0x02, 0xe5, 0x00, 0x02, 0x00, 0x6f, 0x09, 0x0c, ...be16(w * hgt)];
    const implicit = [0x81, 0xa6, 0x00, 0x00, 0x0b, 0x01, 0x00, ...be16(this.defaults.cols), ...be16(this.defaults.rows), ...be16(w), ...be16(hgt)];
    const sf = (body: number[]) => [...be16(body.length + 2), ...body];
    return Buffer.from([AID.SF, ...sf(summary), ...sf(usable), ...sf(implicit)]);
  }

  // ---------------------------------------------------------------- outbound (host -> terminal)

  /**
   * Process one outbound record (command byte first). Returns what the host
   * asked to read back, if anything.
   */
  process(rec: Uint8Array): { read?: 'buffer' | 'modified' | 'modifiedAll' | 'query' } {
    if (!rec.length) return {};
    const cmd = rec[0];
    const is = (c: readonly number[]) => c.includes(cmd);
    this.version++;
    if (is(CMD.RB)) return { read: 'buffer' };
    if (is(CMD.RM)) return { read: 'modified' };
    if (is(CMD.RMA)) return { read: 'modifiedAll' };
    if (is(CMD.EAU)) {
      this.eraseAllUnprotected();
      return {};
    }
    if (is(CMD.WSF)) return this.structuredFields(rec.subarray(1));
    if (is(CMD.EW) || is(CMD.EWA)) {
      this.resize(is(CMD.EWA));
      this.write(rec.subarray(1), true);
      return {};
    }
    if (is(CMD.W)) {
      this.write(rec.subarray(1), false);
      return {};
    }
    throw new TerminalError(`unknown 3270 command 0x${cmd.toString(16)}`);
  }

  private eraseAllUnprotected(): void {
    for (const f of this.fields()) {
      if (f.protected) continue;
      for (let i = 0; i < f.length; i++) this.buffer[this.wrap(f.address + i)] = 0;
      this.attr[f.attrAddress] &= ~1;
    }
    const first = this.nextUnprotected(0);
    this.cursor = first ? first.address : 0;
    this.keyboardLocked = false;
  }

  private structuredFields(data: Uint8Array): { read?: 'query' } {
    let read: 'query' | undefined;
    let p = 0;
    while (p + 2 < data.length) {
      let len = (data[p] << 8) | data[p + 1];
      if (len === 0) len = data.length - p; // "rest of the stream"
      const sf = data.subarray(p + 2, p + len);
      const id = sf[0];
      if (id === 0x01) {
        // Read Partition: Query (0x02) or Query List (0x03).
        if (sf[2] === 0x02 || sf[2] === 0x03) read = 'query';
      } else if (id === 0x03) {
        // Erase/Reset: bit 0x80 = alternate size.
        this.resize((sf[1] & 0x80) !== 0);
      } else if (id === 0x40) {
        // Outbound 3270DS: partition id, then a 3270 command and its data.
        const inner = sf.subarray(2);
        if (inner.length) this.process(inner);
      }
      p += len;
    }
    return read ? { read } : {};
  }

  private write(data: Uint8Array, erase: boolean): void {
    if (!data.length) return;
    const wcc = data[0];
    if (wcc & 0x01) for (let i = 0; i < this.size; i++) if (this.attr[i] >= 0) this.attr[i] &= ~1;
    let addr = erase ? 0 : this.cursor;
    let lastData = false;
    let i = 1;
    const need = (n: number) => {
      if (i + n > data.length) throw new TerminalError('truncated 3270 order');
    };
    while (i < data.length) {
      const b = data[i++];
      switch (b) {
        case ORDER.SF: {
          need(1);
          this.setAttr(addr, data[i++]);
          addr = this.wrap(addr + 1);
          lastData = false;
          break;
        }
        case ORDER.SFE: {
          need(1);
          const n = data[i++];
          let fa = 0;
          for (let k = 0; k < n; k++) {
            need(2);
            const type = data[i++];
            const v = data[i++];
            if (type === 0xc0) fa = v;
          }
          this.setAttr(addr, fa);
          addr = this.wrap(addr + 1);
          lastData = false;
          break;
        }
        case ORDER.SBA: {
          need(2);
          addr = this.wrap(decodeAddress(data[i], data[i + 1]));
          i += 2;
          lastData = false;
          break;
        }
        case ORDER.SA: {
          need(2);
          i += 2; // character attributes (colour, highlighting) are not modelled
          break;
        }
        case ORDER.MF: {
          need(1);
          const n = data[i++];
          for (let k = 0; k < n; k++) {
            need(2);
            const type = data[i++];
            const v = data[i++];
            if (type === 0xc0 && this.attr[addr] >= 0) this.attr[addr] = v;
          }
          addr = this.wrap(addr + 1);
          lastData = false;
          break;
        }
        case ORDER.IC:
          this.cursor = addr;
          break;
        case ORDER.PT: {
          // Nulls to the end of the current field when the tab follows data, then the next unprotected field.
          if (lastData && this.attr[addr] < 0) {
            for (let a = addr, k = 0; k < this.size && this.attr[a] < 0; k++, a = this.wrap(a + 1)) this.buffer[a] = 0;
          }
          const nf = this.nextUnprotectedAfter(addr);
          addr = nf ?? 0;
          lastData = false;
          break;
        }
        case ORDER.RA: {
          need(3);
          const stop = this.wrap(decodeAddress(data[i], data[i + 1]));
          i += 2;
          let ch = data[i++];
          if (ch === ORDER.GE) {
            need(1);
            ch = data[i++];
          }
          do {
            this.putByte(addr, ch);
            addr = this.wrap(addr + 1);
          } while (addr !== stop);
          lastData = true;
          break;
        }
        case ORDER.EUA: {
          need(2);
          const stop = this.wrap(decodeAddress(data[i], data[i + 1]));
          i += 2;
          do {
            if (this.attr[addr] < 0) {
              const fa = this.fieldAttrAddress(addr);
              if (fa < 0 || !isProt(this.attr[fa])) this.buffer[addr] = 0;
            }
            addr = this.wrap(addr + 1);
          } while (addr !== stop);
          lastData = false;
          break;
        }
        case ORDER.GE: {
          need(1);
          this.putByte(addr, data[i++]);
          addr = this.wrap(addr + 1);
          lastData = true;
          break;
        }
        default:
          this.putByte(addr, b);
          addr = this.wrap(addr + 1);
          lastData = true;
      }
    }
    if (wcc & 0x04) this.alarm = true;
    if (wcc & 0x02) this.keyboardLocked = false;
  }

  private nextUnprotectedAfter(addr: number): number | undefined {
    for (let k = 0; k < this.size; k++) {
      const a = this.wrap(addr + k);
      if (this.attr[a] >= 0 && !isProt(this.attr[a])) {
        const first = this.wrap(a + 1);
        if (this.attr[first] < 0) return first;
      }
    }
    return undefined;
  }

  private setAttr(addr: number, fa: number): void {
    this.attr[addr] = fa;
    this.buffer[addr] = 0;
  }

  private putByte(addr: number, b: number): void {
    this.attr[addr] = -1;
    this.buffer[addr] = b;
  }
}
