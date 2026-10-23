/**
 * The 5250 presentation space (IBM i display stations): a character buffer,
 * display attributes, and the format table of input fields built from the
 * 5250 data stream (Clear Unit, Write To Display with SBA/IC/MC/RA/EA/TD/SF/
 * SOH/WEA/WDSF orders, Write Error Code, Read Input/MDT Fields, Read
 * Immediate, Read Screen Immediate, Save/Restore Screen, Roll and the 5250
 * Query structured field). It produces the inbound streams the host reads
 * back.
 *
 * Unlike 3270, a 5250 field has an explicit length from its Start Of Field
 * order and a Field Format Word (bypass, MDT, shift/edit, monocase, mandatory
 * enter, right adjust). The screen attribute before the field takes one
 * position, as on a real display.
 *
 * Addresses are 0-based buffer offsets; rows and columns are 1-based (5250
 * SBA orders carry 1-based row and column bytes).
 */
import { charToEbcdic, ebcdicToChar, isEbcdicEncodable } from '../tn3270/ebcdic.js';
import { TerminalError, type ScreenField, type ScreenSnapshot } from '../tn3270/screen.js';
import type { TerminalScreen } from '../types.js';

/** GDS record opcodes (RFC 1205 header, byte 9). */
export const OPCODE = {
  NO_OP: 0x00, INVITE: 0x01, OUTPUT_ONLY: 0x02, PUT_GET: 0x03, SAVE_SCREEN: 0x04, RESTORE_SCREEN: 0x05,
  READ_IMMEDIATE: 0x06, READ_SCREEN: 0x08, CANCEL_INVITE: 0x0a, MESSAGE_ON: 0x0b, MESSAGE_OFF: 0x0c,
} as const;

/** GDS header flags (byte 7). */
export const HFLAG = { ERR: 0x80, ATN: 0x40, SRQ: 0x04, TRQ: 0x02, HLP: 0x01 } as const;

export const ESC = 0x04;

/** 5250 commands (the byte after ESC). */
export const CMD5250 = {
  CLEAR_UNIT: 0x40, CLEAR_UNIT_ALTERNATE: 0x20, CLEAR_FORMAT_TABLE: 0x50, WRITE_TO_DISPLAY: 0x11,
  WRITE_ERROR_CODE: 0x21, WRITE_ERROR_CODE_WINDOW: 0x22, READ_INPUT_FIELDS: 0x42, READ_MDT_FIELDS: 0x52,
  READ_MDT_FIELDS_ALT: 0x82, READ_SCREEN_IMMEDIATE: 0x62, READ_IMMEDIATE: 0x72, SAVE_SCREEN: 0x02,
  SAVE_PARTIAL_SCREEN: 0x03, RESTORE_SCREEN: 0x12, RESTORE_PARTIAL_SCREEN: 0x13, ROLL: 0x23, WRITE_STRUCTURED_FIELD: 0xf3,
} as const;

/** Write To Display orders. */
export const ORDER5250 = { SOH: 0x01, RA: 0x02, EA: 0x03, TD: 0x10, SBA: 0x11, WEA: 0x12, IC: 0x13, MC: 0x14, WDSF: 0x15, SF: 0x1d } as const;

/** Attention identifiers of the 5250 keyboard. */
export const AID5250: Record<string, number> = {
  ENTER: 0xf1, HELP: 0xf3, ROLLDOWN: 0xf4, ROLLUP: 0xf5, PRINT: 0xf6, RECORDBACKSPACE: 0xf8, CLEAR: 0xbd, AUTOENTER: 0x3f, QUERY: 0x88,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x31 + i])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 13}`, 0xb1 + i])),
};

/** AIDs whose inbound record carries no field data. */
const NO_DATA_AIDS = new Set([AID5250.CLEAR, AID5250.HELP, AID5250.PRINT, AID5250.RECORDBACKSPACE]);

/**
 * Normalise a key name to a 5250 attention key: "Enter", "F3"/"PF3",
 * "Page Down"/"Roll Up", "Page Up"/"Roll Down", "Help", "Print", "Clear",
 * "SysReq", "Attn". Returns undefined for anything else.
 */
export function aid5250Name(key: string): string | undefined {
  const k = key.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (k === 'ENTER' || k === 'RETURN' || k === 'FIELDEXITENTER') return 'ENTER';
  if (k === 'HELP') return 'HELP';
  if (k === 'PRINT') return 'PRINT';
  if (k === 'CLEAR') return 'CLEAR';
  if (k === 'ROLLUP' || k === 'PAGEDOWN' || k === 'PGDN') return 'ROLLUP';
  if (k === 'ROLLDOWN' || k === 'PAGEUP' || k === 'PGUP') return 'ROLLDOWN';
  if (k === 'RECORDBACKSPACE' || k === 'RECBKSP') return 'RECORDBACKSPACE';
  if (k === 'SYSREQ' || k === 'SYSTEMREQUEST') return 'SYSREQ';
  if (k === 'ATTN' || k === 'ATTENTION') return 'ATTN';
  const f = /^P?F(\d{1,2})$/.exec(k);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return `F${Number(f[1])}`;
  return undefined;
}

export const SIZES_5250 = { normal: { rows: 24, cols: 80 }, wide: { rows: 27, cols: 132 } } as const;

/** A format-table entry: an input-capable field defined by Start Of Field. */
export interface Field5250 {
  /** Address of the first data position (the attribute is at start - 1). */
  start: number;
  length: number;
  /** Field format word (bypass 0x2000, dup 0x1000, MDT 0x0800, shift 0x0700, auto-enter 0x0080, field exit required 0x0040, monocase 0x0020, mandatory enter 0x0008, right adjust/fill 0x0007). */
  ffw: number;
  fcw: number[];
  /** Screen attribute (0x20-0x3F). */
  attr: number;
}

export const FFW = { BYPASS: 0x2000, DUP: 0x1000, MDT: 0x0800, SHIFT: 0x0700, AUTO_ENTER: 0x0080, FER: 0x0040, MONOCASE: 0x0020, MANDATORY_ENTER: 0x0008, ADJUST: 0x0007 } as const;
/** Shift/edit values (FFW bits 0x0700). */
export const SHIFT = { ALPHA_SHIFT: 0, ALPHA_ONLY: 1, NUMERIC_SHIFT: 2, NUMERIC_ONLY: 3, KATAKANA: 4, DIGITS_ONLY: 5, IO: 6, SIGNED_NUMERIC: 7 } as const;

const shiftOf = (f: Field5250) => (f.ffw & FFW.SHIFT) >> 8;
const isNumericShift = (f: Field5250) => [SHIFT.NUMERIC_SHIFT, SHIFT.NUMERIC_ONLY, SHIFT.DIGITS_ONLY, SHIFT.SIGNED_NUMERIC].includes(shiftOf(f) as 2 | 3 | 5 | 7);
const nondisplay = (attr: number) => (attr & 0x07) === 0x07;
const intense = (attr: number) => !nondisplay(attr) && (attr & 0x02) === 0x02;
const isAttrByte = (b: number) => b >= 0x20 && b <= 0x3f;

/** What the host asked the terminal to send back right away. */
export type ImmediateReply = 'query' | 'readImmediate' | 'readScreenImmediate' | 'saveScreen';

export class Screen5250 implements TerminalScreen {
  rows: number = SIZES_5250.normal.rows;
  cols: number = SIZES_5250.normal.cols;
  buffer: Uint8Array;
  /** Display attribute at a position, or -1. */
  dispAttr: Int16Array;
  fieldTable: Field5250[] = [];
  cursor = 0;
  keyboardLocked = true;
  alarm = false;
  messageWaiting = false;
  /** A Write Error Code is showing: the keyboard is inhibited until Reset. */
  errorState = false;
  /** Row the host uses for error messages (from SOH; default the last row). */
  errorRow = 0;
  private savedErrorLine?: { buffer: Uint8Array; attr: Int16Array };
  /** The read command waiting for an attention key. */
  pendingRead?: 'input' | 'mdt' | 'mdtAlt';
  version = 0;

  constructor(readonly wide = false) {
    const s = wide ? SIZES_5250.wide : SIZES_5250.normal;
    this.rows = s.rows;
    this.cols = s.cols;
    this.buffer = new Uint8Array(this.size);
    this.dispAttr = new Int16Array(this.size).fill(-1);
  }

  get size(): number {
    return this.rows * this.cols;
  }

  private wrap(a: number): number {
    return ((a % this.size) + this.size) % this.size;
  }

  addressOf(row: number, col: number): number {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || row > this.rows || col > this.cols) {
      throw new TerminalError(`row ${row} column ${col} is outside the ${this.rows}x${this.cols} screen`);
    }
    return (row - 1) * this.cols + (col - 1);
  }

  rowCol(addr: number): { row: number; col: number } {
    return { row: Math.floor(addr / this.cols) + 1, col: (addr % this.cols) + 1 };
  }

  get formatted(): boolean {
    return this.fieldTable.length > 0;
  }

  private clearUnit(size: { rows: number; cols: number }): void {
    this.rows = size.rows;
    this.cols = size.cols;
    this.buffer = new Uint8Array(this.size);
    this.dispAttr = new Int16Array(this.size).fill(-1);
    this.fieldTable = [];
    this.cursor = 0;
    this.errorState = false;
    this.savedErrorLine = undefined;
    this.errorRow = 0;
    this.pendingRead = undefined;
    this.keyboardLocked = true;
  }

  // ---------------------------------------------------------------- fields (the TerminalScreen view)

  private toScreenField(f: Field5250): ScreenField {
    const rc = this.rowCol(f.start);
    return {
      attrAddress: this.wrap(f.start - 1), address: f.start, row: rc.row, col: rc.col, length: f.length,
      protected: (f.ffw & FFW.BYPASS) !== 0, numeric: isNumericShift(f), hidden: nondisplay(f.attr), intensified: intense(f.attr),
      modified: (f.ffw & FFW.MDT) !== 0, value: this.readRange(f.start, f.length),
    };
  }

  /** Input-capable fields in format-table order (bypass fields included, as `protected`). */
  fields(): ScreenField[] {
    return this.fieldTable.map((f) => this.toScreenField(f));
  }

  private entryAt(addr: number): Field5250 | undefined {
    return this.fieldTable.find((f) => addr >= f.start && addr < f.start + f.length);
  }

  fieldAt(addr: number): ScreenField | undefined {
    const f = this.entryAt(addr);
    return f ? this.toScreenField(f) : undefined;
  }

  /** The format-table entry for a field returned by fields(). */
  entryOf(field: ScreenField): Field5250 {
    const f = this.fieldTable.find((x) => x.start === field.address);
    if (!f) throw new TerminalError(`no 5250 field starts at row ${field.row} column ${field.col}`);
    return f;
  }

  readRange(addr: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) {
      const a = this.wrap(addr + i);
      s += this.dispAttr[a] >= 0 || this.buffer[a] === 0 ? ' ' : ebcdicToChar(this.buffer[a]);
    }
    return s;
  }

  textRows(revealHidden = false): string[] {
    const hidden = new Uint8Array(this.size);
    if (!revealHidden) {
      // Output text after a non-display attribute, up to the next attribute, is not shown either.
      let cur = 0x20;
      for (let a = 0; a < this.size; a++) {
        if (this.dispAttr[a] >= 0) cur = this.dispAttr[a];
        else if (nondisplay(cur)) hidden[a] = 1;
      }
      for (const f of this.fieldTable) if (nondisplay(f.attr)) for (let i = 0; i < f.length; i++) hidden[this.wrap(f.start + i)] = 1;
    }
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) {
        const a = r * this.cols + c;
        s += hidden[a] || this.dispAttr[a] >= 0 || this.buffer[a] === 0 ? ' ' : ebcdicToChar(this.buffer[a]);
      }
      out.push(s);
    }
    return out;
  }

  text(): string {
    return this.textRows().join('\n');
  }

  snapshot(): ScreenSnapshot {
    return {
      rows: this.rows, cols: this.cols, cursor: this.rowCol(this.cursor), keyboardLocked: this.keyboardLocked, text: this.textRows(),
      fields: this.fields().map(({ attrAddress: _a, address: _b, ...f }) => ({ ...f, value: f.hidden ? '' : f.value })),
    };
  }

  // ---------------------------------------------------------------- operator side

  private checkTypeable(): void {
    if (this.errorState) throw new TerminalError('the keyboard is inhibited by an error message (press Reset)');
    if (this.keyboardLocked) throw new TerminalError('the keyboard is locked (the host has not finished; wait for the screen)');
  }

  private encode(f: Field5250, ch: string, where: { row: number; col: number }): number {
    const shift = shiftOf(f);
    const c = (f.ffw & FFW.MONOCASE) !== 0 ? ch.toUpperCase() : ch;
    if (shift === SHIFT.DIGITS_ONLY && !/[0-9 ]/.test(c)) throw new TerminalError(`the field at row ${where.row} column ${where.col} takes digits only; "${ch}" is not a digit`);
    if ((shift === SHIFT.NUMERIC_ONLY || shift === SHIFT.SIGNED_NUMERIC) && !/[0-9 .,+-]/.test(c)) throw new TerminalError(`the field at row ${where.row} column ${where.col} is numeric; "${ch}" is not a number`);
    if (shift === SHIFT.ALPHA_ONLY && !/[A-Za-z ,.-]/.test(c)) throw new TerminalError(`the field at row ${where.row} column ${where.col} is alphabetic only; "${ch}" is not allowed`);
    if (!isEbcdicEncodable(c)) throw new TerminalError(`"${ch}" cannot be typed on a 5250 (no EBCDIC code)`);
    return charToEbcdic(c);
  }

  typeAt(addr: number, text: string): void {
    this.checkTypeable();
    const f = this.entryAt(addr);
    const where = this.rowCol(addr);
    if (!f) throw new TerminalError(`row ${where.row} column ${where.col} is not in an input field`);
    if (f.ffw & FFW.BYPASS) throw new TerminalError(`row ${where.row} column ${where.col} is in a protected (bypass) field`);
    const room = f.length - (addr - f.start);
    if (text.length > room) throw new TerminalError(`"${text}" (${text.length} characters) does not fit the field at row ${where.row} column ${where.col} (${room} positions left)`);
    const bytes = [...text].map((ch) => this.encode(f, ch, where));
    bytes.forEach((b, i) => (this.buffer[addr + i] = b));
    f.ffw |= FFW.MDT;
    this.cursor = this.wrap(addr + text.length);
    // A full field moves the cursor to the next input field, unless it needs Field Exit.
    if (this.cursor === this.wrap(f.start + f.length) && !(f.ffw & FFW.FER)) this.cursor = (this.nextInput(f.start + f.length) ?? f).start;
  }

  fillField(field: ScreenField, text: string): void {
    this.checkTypeable();
    const f = this.entryOf(field);
    if (f.ffw & FFW.BYPASS) throw new TerminalError(`the field at row ${field.row} column ${field.col} is protected (bypass)`);
    for (let i = 0; i < f.length; i++) this.buffer[f.start + i] = 0;
    f.ffw |= FFW.MDT;
    this.typeAt(f.start, text);
  }

  eraseToEndOfField(addr: number): void {
    const f = this.entryAt(addr);
    if (!f || f.ffw & FFW.BYPASS) throw new TerminalError('Erase EOF: the cursor is not in an input field');
    for (let a = addr; a < f.start + f.length; a++) this.buffer[a] = 0;
    f.ffw |= FFW.MDT;
  }

  /** First non-bypass field at or after `addr` (wrapping). */
  nextInput(addr: number): Field5250 | undefined {
    const inputs = this.fieldTable.filter((f) => !(f.ffw & FFW.BYPASS)).sort((a, b) => a.start - b.start);
    return inputs.find((f) => f.start >= addr) ?? inputs[0];
  }

  /**
   * Field Exit / Field+ / Field-: erase from the cursor to the end of the
   * field, right-adjust when the field asks for it, mark the sign for Field-
   * on numeric fields, and move to the next input field.
   */
  fieldExit(kind: 'exit' | 'plus' | 'minus'): Field5250 {
    this.checkTypeable();
    const f = this.entryAt(this.cursor);
    if (!f || f.ffw & FFW.BYPASS) throw new TerminalError('Field Exit: the cursor is not in an input field');
    for (let a = this.cursor; a < f.start + f.length; a++) this.buffer[a] = 0;
    const adjust = f.ffw & FFW.ADJUST;
    const numeric = isNumericShift(f);
    if (kind === 'minus' && !numeric) throw new TerminalError('Field-: only numeric fields take a sign');
    if (adjust === 5 || adjust === 6 || (numeric && kind !== 'exit')) {
      const content = [...this.buffer.subarray(f.start, f.start + f.length)].filter((b) => b !== 0 && b !== 0x40);
      const fill = adjust === 5 ? charToEbcdic('0') : 0x40;
      const signPos = shiftOf(f) === SHIFT.SIGNED_NUMERIC ? 1 : 0;
      const width = f.length - signPos;
      const right = content.slice(-width);
      for (let i = 0; i < width; i++) this.buffer[f.start + i] = i < width - right.length ? fill : right[i - (width - right.length)];
      if (signPos) this.buffer[f.start + f.length - 1] = kind === 'minus' ? charToEbcdic('-') : 0x40;
      else if (kind === 'minus' && right.length) {
        // Zoned decimal: the last digit's zone becomes D (negative).
        const last = f.start + f.length - 1;
        this.buffer[last] = 0xd0 | (this.buffer[last] & 0x0f);
      }
    }
    f.ffw |= FFW.MDT;
    const next = this.nextInput(f.start + f.length) ?? f;
    this.cursor = next.start;
    return f;
  }

  /** Reset: clear an error message (restoring the line under it) and release the keyboard. */
  reset(): void {
    if (this.errorState && this.savedErrorLine) {
      const row = this.errorLineRow();
      const base = (row - 1) * this.cols;
      this.buffer.set(this.savedErrorLine.buffer, base);
      this.dispAttr.set(this.savedErrorLine.attr, base);
    }
    this.savedErrorLine = undefined;
    this.errorState = false;
    if (this.pendingRead) this.keyboardLocked = false;
  }

  private errorLineRow(): number {
    return this.errorRow >= 1 && this.errorRow <= this.rows ? this.errorRow : this.rows;
  }

  // ---------------------------------------------------------------- inbound (terminal -> host)

  private fieldBytes(f: Field5250, trimNulls: boolean): number[] {
    const raw = [...this.buffer.subarray(f.start, f.start + f.length)];
    let end = raw.length;
    if (trimNulls) while (end > 0 && raw[end - 1] === 0) end--;
    return raw.slice(0, end).map((b) => (b === 0 ? 0x40 : b));
  }

  /**
   * The inbound data for an attention key: cursor row, column, AID, then the
   * fields the pending read asks for (Read Input Fields: every input field's
   * content in format-table order; Read MDT Fields: SBA + data of modified
   * fields). Keys without data (Clear, Help, Print) send the header only.
   */
  inbound(aid: number): Buffer {
    const { row, col } = this.rowCol(this.cursor);
    const out: number[] = [row, col, aid];
    if (NO_DATA_AIDS.has(aid)) return Buffer.from(out);
    const mode = this.pendingRead ?? 'mdt';
    const inputs = this.fieldTable.filter((f) => !(f.ffw & FFW.BYPASS));
    if (mode === 'input') {
      for (const f of inputs) out.push(...this.fieldBytes(f, false));
    } else {
      for (const f of inputs) {
        if (!(f.ffw & FFW.MDT)) continue;
        const rc = this.rowCol(f.start);
        out.push(ORDER5250.SBA, rc.row, rc.col, ...this.fieldBytes(f, true));
      }
    }
    return Buffer.from(out);
  }

  /** Read Screen Immediate: the whole display (attributes as their bytes, nulls as nulls). */
  screenImage(): Buffer {
    const out: number[] = [];
    for (let a = 0; a < this.size; a++) out.push(this.dispAttr[a] >= 0 ? this.dispAttr[a] : this.buffer[a]);
    return Buffer.from(out);
  }

  /**
   * Save Screen: a data stream that, sent back as Restore Screen, rebuilds
   * this display (Clear Unit, then Write To Display with every attribute,
   * field and character, and the cursor).
   */
  saveImage(): Buffer {
    const out: number[] = [ESC, this.cols === 132 ? CMD5250.CLEAR_UNIT_ALTERNATE : CMD5250.CLEAR_UNIT, ...(this.cols === 132 ? [0x00] : []), ESC, CMD5250.WRITE_TO_DISPLAY, 0x00, 0x00];
    const starts = new Map(this.fieldTable.map((f) => [f.start, f]));
    for (let a = 0; a < this.size; a++) {
      const f = starts.get(this.wrap(a + 1));
      if (f) {
        const rc = this.rowCol(a);
        out.push(ORDER5250.SBA, rc.row, rc.col, ORDER5250.SF, (f.ffw >> 8) | 0x40, f.ffw & 0xff, ...f.fcw.flatMap((w) => [w >> 8, w & 0xff]), f.attr, f.length >> 8, f.length & 0xff);
        continue;
      }
      const b = this.dispAttr[a] >= 0 ? this.dispAttr[a] : this.buffer[a];
      if (b === 0) continue;
      const rc = this.rowCol(a);
      out.push(ORDER5250.SBA, rc.row, rc.col, b);
    }
    const cur = this.rowCol(this.cursor);
    out.push(ORDER5250.IC, cur.row, cur.col);
    return Buffer.from(out);
  }

  /** The 5250 Query reply (display emulation, 3180-002 class device, standard keyboard). */
  queryReply(deviceType = '3180', model = '002'): Buffer {
    const ebc = (s: string) => [...s].map(charToEbcdic);
    const body = [
      0xd9, 0x70, 0x80, // command class, type (Query), flag
      0x06, 0x00, // controller hardware class: Other WSF / emulator
      0x01, 0x01, 0x00, // controller code level 1.1.0
      ...new Array<number>(16).fill(0),
      0x01, // device type: display emulation
      ...ebc(deviceType), ...ebc(model),
      0x02, 0x00, 0x00, // keyboard: standard; extended id; reserved
      0x00, 0x61, 0x50, 0x00, // display serial number
      0x01, 0x00, // maximum input fields: 256
      0x00, 0x00, 0x00, // control unit customization, reserved
      0x23, 0x31, 0x00, 0x00, // device capability: row 1/col 1 support, 24x80 and 27x132, no graphics
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    const len = body.length + 2;
    return Buffer.from([0x00, 0x00, AID5250.QUERY, (len >> 8) & 0xff, len & 0xff, ...body]);
  }

  // ---------------------------------------------------------------- outbound (host -> terminal)

  /**
   * Process the data of one record (after the GDS header). Returns the
   * immediate replies the host asked for, in order.
   */
  process(data: Uint8Array): ImmediateReply[] {
    const replies: ImmediateReply[] = [];
    let i = 0;
    this.version++;
    while (i < data.length) {
      if (data[i] !== ESC) {
        i++; // stray byte between commands: ignored, as a display station does
        continue;
      }
      const cmd = data[i + 1];
      i += 2;
      switch (cmd) {
        case CMD5250.CLEAR_UNIT:
          this.clearUnit(SIZES_5250.normal);
          break;
        case CMD5250.CLEAR_UNIT_ALTERNATE: {
          const p = data[i++];
          this.clearUnit(p === 0x80 ? SIZES_5250.normal : SIZES_5250.wide);
          break;
        }
        case CMD5250.CLEAR_FORMAT_TABLE:
          this.fieldTable = [];
          this.keyboardLocked = true;
          break;
        case CMD5250.WRITE_TO_DISPLAY:
          i = this.writeToDisplay(data, i);
          break;
        case CMD5250.WRITE_ERROR_CODE:
          i = this.writeErrorCode(data, i);
          break;
        case CMD5250.WRITE_ERROR_CODE_WINDOW:
          i = this.writeErrorCode(data, i + 2);
          break;
        case CMD5250.READ_INPUT_FIELDS:
        case CMD5250.READ_MDT_FIELDS:
        case CMD5250.READ_MDT_FIELDS_ALT: {
          const cc1 = data[i] ?? 0;
          const cc2 = data[i + 1] ?? 0;
          i += 2;
          this.applyCc1(cc1);
          this.pendingRead = cmd === CMD5250.READ_INPUT_FIELDS ? 'input' : cmd === CMD5250.READ_MDT_FIELDS ? 'mdt' : 'mdtAlt';
          this.applyCc2(cc2, false);
          if (!this.errorState) this.keyboardLocked = false;
          break;
        }
        case CMD5250.READ_IMMEDIATE:
          replies.push('readImmediate');
          break;
        case CMD5250.READ_SCREEN_IMMEDIATE:
          replies.push('readScreenImmediate');
          break;
        case CMD5250.SAVE_SCREEN:
        case CMD5250.SAVE_PARTIAL_SCREEN:
          if (cmd === CMD5250.SAVE_PARTIAL_SCREEN) i += 5;
          replies.push('saveScreen');
          break;
        case CMD5250.RESTORE_SCREEN:
        case CMD5250.RESTORE_PARTIAL_SCREEN:
          // The rest of the record is the stream a Save Screen produced.
          break;
        case CMD5250.ROLL: {
          const ctl = data[i];
          const top = data[i + 1];
          const bottom = data[i + 2];
          i += 3;
          this.roll((ctl & 0x80) !== 0, ctl & 0x1f, top, bottom);
          break;
        }
        case CMD5250.WRITE_STRUCTURED_FIELD: {
          const len = (data[i] << 8) | data[i + 1];
          const cls = data[i + 2];
          const type = data[i + 3];
          if (cls === 0xd9 && type === 0x70) replies.push('query');
          i += Math.max(len, 2);
          break;
        }
        default:
          throw new TerminalError(`unknown 5250 command 0x${(cmd ?? 0).toString(16)}`);
      }
    }
    return replies;
  }

  private applyCc1(cc1: number): void {
    const op = cc1 & 0xe0;
    if (op === 0) return;
    this.keyboardLocked = true;
    const resetMdt = op === 0x40 || op === 0x60 || op === 0xa0 || op === 0xc0;
    const nullAll = op === 0xa0 || op === 0xe0;
    const nullMdt = op === 0x80 || op === 0xc0;
    for (const f of this.fieldTable) {
      const bypass = (f.ffw & FFW.BYPASS) !== 0;
      if (!bypass && (nullAll || (nullMdt && f.ffw & FFW.MDT))) for (let k = 0; k < f.length; k++) this.buffer[f.start + k] = 0;
      if (resetMdt && (op !== 0x40 || !bypass)) f.ffw &= ~FFW.MDT;
    }
  }

  private applyCc2(cc2: number, icSeen: boolean): void {
    if (cc2 & 0x04) this.alarm = true;
    if (cc2 & 0x01) this.messageWaiting = true;
    if (cc2 & 0x02) this.messageWaiting = false;
    if (cc2 & 0x08) {
      this.keyboardLocked = false;
      if (!icSeen) {
        const home = this.nextInput(0);
        if (home && !this.entryAt(this.cursor)) this.cursor = home.start;
      }
    }
  }

  private addrRC(row: number, col: number): number {
    if (row < 1 || col < 1 || row > this.rows || col > this.cols) throw new TerminalError(`5250 order addresses row ${row} column ${col}, outside the ${this.rows}x${this.cols} display`);
    return (row - 1) * this.cols + (col - 1);
  }

  private put(addr: number, b: number): void {
    if (isAttrByte(b)) {
      this.dispAttr[addr] = b;
      this.buffer[addr] = 0;
    } else {
      this.dispAttr[addr] = -1;
      this.buffer[addr] = b;
    }
  }

  private writeToDisplay(data: Uint8Array, start: number): number {
    let i = start;
    const need = (n: number) => {
      if (i + n > data.length) throw new TerminalError('truncated 5250 order');
    };
    need(2);
    const cc1 = data[i++];
    const cc2 = data[i++];
    this.applyCc1(cc1);
    let addr = this.cursor;
    let icSeen = false;
    while (i < data.length && data[i] !== ESC) {
      const b = data[i++];
      switch (b) {
        case ORDER5250.SOH: {
          need(1);
          const n = data[i++];
          need(n);
          const hdr = data.subarray(i, i + n);
          i += n;
          if (n >= 4 && hdr[3]) this.errorRow = hdr[3];
          // A new header starts a new format: the old format table is gone.
          this.fieldTable = [];
          break;
        }
        case ORDER5250.SBA:
          need(2);
          addr = this.addrRC(data[i], data[i + 1]);
          i += 2;
          break;
        case ORDER5250.IC:
        case ORDER5250.MC:
          need(2);
          this.cursor = this.addrRC(data[i], data[i + 1]);
          i += 2;
          icSeen = true;
          break;
        case ORDER5250.RA: {
          need(3);
          const stop = this.addrRC(data[i], data[i + 1]);
          const ch = data[i + 2];
          i += 3;
          for (let a = addr; ; a = this.wrap(a + 1)) {
            this.put(a, ch);
            if (a === stop) {
              addr = this.wrap(a + 1);
              break;
            }
          }
          break;
        }
        case ORDER5250.EA: {
          need(3);
          const stop = this.addrRC(data[i], data[i + 1]);
          const n = data[i + 2];
          i += 2 + Math.max(1, n);
          for (let a = addr; ; a = this.wrap(a + 1)) {
            this.buffer[a] = 0;
            this.dispAttr[a] = -1;
            if (a === stop) {
              addr = this.wrap(a + 1);
              break;
            }
          }
          break;
        }
        case ORDER5250.TD: {
          need(2);
          const n = (data[i] << 8) | data[i + 1];
          i += 2;
          need(n);
          for (let k = 0; k < n; k++) {
            this.buffer[addr] = data[i + k];
            this.dispAttr[addr] = -1;
            addr = this.wrap(addr + 1);
          }
          i += n;
          break;
        }
        case ORDER5250.WEA:
          need(2);
          i += 2; // extended attributes (colour, ideographic) are not modelled
          break;
        case ORDER5250.WDSF: {
          need(2);
          const n = (data[i] << 8) | data[i + 1];
          i += Math.max(2, n); // windows, scroll bars, selection fields: not modelled
          break;
        }
        case ORDER5250.SF: {
          need(1);
          let ffw: number | undefined;
          const fcw: number[] = [];
          if (!isAttrByte(data[i])) {
            need(2);
            ffw = ((data[i] & 0x3f) << 8) | data[i + 1];
            i += 2;
            while (i < data.length && (data[i] & 0xe0) === 0x80) {
              need(2);
              fcw.push((data[i] << 8) | data[i + 1]);
              i += 2;
            }
          }
          need(1);
          const attr = data[i++];
          this.put(addr, attr);
          const fieldStart = this.wrap(addr + 1);
          if (ffw !== undefined) {
            need(2);
            const length = (data[i] << 8) | data[i + 1];
            i += 2;
            if (length < 1 || length > this.size) throw new TerminalError(`5250 field at row ${this.rowCol(fieldStart).row} has length ${length}`);
            const known = this.fieldTable.find((f) => f.start === fieldStart);
            if (known) Object.assign(known, { ffw, fcw, attr, length });
            else this.fieldTable.push({ start: fieldStart, length, ffw, fcw, attr });
          }
          addr = fieldStart;
          break;
        }
        default:
          this.put(addr, b);
          addr = this.wrap(addr + 1);
      }
    }
    this.applyCc2(cc2, icSeen);
    return i;
  }

  private writeErrorCode(data: Uint8Array, start: number): number {
    let i = start;
    const row = this.errorLineRow();
    const base = (row - 1) * this.cols;
    if (!this.errorState) this.savedErrorLine = { buffer: this.buffer.slice(base, base + this.cols), attr: this.dispAttr.slice(base, base + this.cols) };
    for (let c = 0; c < this.cols; c++) {
      this.buffer[base + c] = 0;
      this.dispAttr[base + c] = -1;
    }
    let addr = base;
    while (i < data.length && data[i] !== ESC) {
      const b = data[i++];
      if (b === ORDER5250.IC && i + 1 < data.length) {
        this.cursor = this.addrRC(data[i], data[i + 1]);
        i += 2;
        continue;
      }
      if (addr < base + this.cols) this.put(addr++, b);
    }
    this.errorState = true;
    this.keyboardLocked = true;
    this.alarm = true;
    return i;
  }

  private roll(down: boolean, lines: number, top: number, bottom: number): void {
    if (!lines || top < 1 || bottom > this.rows || top > bottom) return;
    const copy = (from: number, to: number) => {
      this.buffer.copyWithin((to - 1) * this.cols, (from - 1) * this.cols, from * this.cols);
      this.dispAttr.copyWithin((to - 1) * this.cols, (from - 1) * this.cols, from * this.cols);
    };
    const blank = (r: number) => {
      this.buffer.fill(0, (r - 1) * this.cols, r * this.cols);
      this.dispAttr.fill(-1, (r - 1) * this.cols, r * this.cols);
    };
    if (down) {
      for (let r = bottom; r >= top; r--) (r - lines >= top ? copy(r - lines, r) : blank(r));
    } else {
      for (let r = top; r <= bottom; r++) (r + lines <= bottom ? copy(r + lines, r) : blank(r));
    }
  }
}
