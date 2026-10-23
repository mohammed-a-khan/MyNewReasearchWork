/**
 * US keyboard layout: for every physical key (UI Events `code`), its legacy
 * keyCode, the `key` value unshifted and shifted, and its location.
 */

export interface KeyDef {
  /** UI Events code, e.g. 'KeyA', 'Digit1', 'ShiftLeft'. */
  code: string;
  /** Legacy (windows virtual) key code. */
  keyCode: number;
  /** `key` without Shift. */
  key: string;
  /** `key` with Shift (printable keys only). */
  shiftKey?: string;
  /** 0 standard, 1 left, 2 right, 3 numpad. */
  location: number;
  /** Text a keydown produces (printable keys, Enter). */
  text?: string;
  shiftText?: string;
}

const defs: KeyDef[] = [];

function add(code: string, keyCode: number, key: string, shiftKey?: string, location = 0, text?: string): void {
  const printable = key.length === 1;
  defs.push({
    code,
    keyCode,
    key,
    ...(shiftKey !== undefined ? { shiftKey } : {}),
    location,
    ...(text !== undefined ? { text } : printable ? { text: key } : {}),
    ...(shiftKey !== undefined && shiftKey.length === 1 ? { shiftText: shiftKey } : {}),
  });
}

// Letters
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  add(`Key${lower.toUpperCase()}`, 65 + i, lower, lower.toUpperCase());
}
// Digit row
const shiftedDigits = ')!@#$%^&*(';
for (let d = 0; d < 10; d++) add(`Digit${d}`, 48 + d, String(d), shiftedDigits[d]);
// Punctuation
add('Backquote', 192, '`', '~');
add('Minus', 189, '-', '_');
add('Equal', 187, '=', '+');
add('BracketLeft', 219, '[', '{');
add('BracketRight', 221, ']', '}');
add('Backslash', 220, '\\', '|');
add('Semicolon', 186, ';', ':');
add('Quote', 222, "'", '"');
add('Comma', 188, ',', '<');
add('Period', 190, '.', '>');
add('Slash', 191, '/', '?');
add('Space', 32, ' ');
// Editing and whitespace
add('Enter', 13, 'Enter', undefined, 0, '\r');
add('Tab', 9, 'Tab');
add('Backspace', 8, 'Backspace');
add('Escape', 27, 'Escape');
add('Delete', 46, 'Delete');
add('Insert', 45, 'Insert');
// Navigation
add('Home', 36, 'Home');
add('End', 35, 'End');
add('PageUp', 33, 'PageUp');
add('PageDown', 34, 'PageDown');
add('ArrowLeft', 37, 'ArrowLeft');
add('ArrowUp', 38, 'ArrowUp');
add('ArrowRight', 39, 'ArrowRight');
add('ArrowDown', 40, 'ArrowDown');
// Modifiers
add('ShiftLeft', 16, 'Shift', undefined, 1);
add('ShiftRight', 16, 'Shift', undefined, 2);
add('ControlLeft', 17, 'Control', undefined, 1);
add('ControlRight', 17, 'Control', undefined, 2);
add('AltLeft', 18, 'Alt', undefined, 1);
add('AltRight', 18, 'Alt', undefined, 2);
add('MetaLeft', 91, 'Meta', undefined, 1);
add('MetaRight', 92, 'Meta', undefined, 2);
add('CapsLock', 20, 'CapsLock');
add('NumLock', 144, 'NumLock');
add('ScrollLock', 145, 'ScrollLock');
add('Pause', 19, 'Pause');
add('PrintScreen', 44, 'PrintScreen');
add('ContextMenu', 93, 'ContextMenu');
// Function keys
for (let f = 1; f <= 24; f++) add(`F${f}`, 111 + f, `F${f}`);
// Numpad (NumLock on)
for (let d = 0; d < 10; d++) add(`Numpad${d}`, 96 + d, String(d), undefined, 3);
add('NumpadMultiply', 106, '*', undefined, 3);
add('NumpadAdd', 107, '+', undefined, 3);
add('NumpadSubtract', 109, '-', undefined, 3);
add('NumpadDecimal', 110, '.', undefined, 3);
add('NumpadDivide', 111, '/', undefined, 3);
add('NumpadEnter', 13, 'Enter', undefined, 3, '\r');
add('NumpadEqual', 187, '=', undefined, 3);
// Media / browser keys commonly used in tests
add('AudioVolumeMute', 173, 'AudioVolumeMute');
add('AudioVolumeDown', 174, 'AudioVolumeDown');
add('AudioVolumeUp', 175, 'AudioVolumeUp');
add('MediaTrackNext', 176, 'MediaTrackNext');
add('MediaTrackPrevious', 177, 'MediaTrackPrevious');
add('MediaStop', 178, 'MediaStop');
add('MediaPlayPause', 179, 'MediaPlayPause');

/** Key definitions by code. */
export const keysByCode: ReadonlyMap<string, KeyDef> = new Map(defs.map((d) => [d.code, d]));

/**
 * Resolve a key name as accepted by keyboard.press / down / up:
 * a code ('KeyA', 'ShiftLeft'), a key value ('a', 'A', '!', 'Enter',
 * 'Shift'), or a single character. Returns the definition plus whether the
 * character needs Shift on this layout.
 */
export function resolveKey(name: string): { def: KeyDef; shifted: boolean } | undefined {
  const byCode = keysByCode.get(name);
  if (byCode) return { def: byCode, shifted: false };
  const alias: Record<string, string> = {
    Shift: 'ShiftLeft', Control: 'ControlLeft', Ctrl: 'ControlLeft', Alt: 'AltLeft', Option: 'AltLeft', Meta: 'MetaLeft', Command: 'MetaLeft', Cmd: 'MetaLeft',
    '\n': 'Enter', '\r': 'Enter', Return: 'Enter', ' ': 'Space', Esc: 'Escape', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
    '\t': 'Tab',
  };
  const a = alias[name];
  if (a) return { def: keysByCode.get(a)!, shifted: false };
  for (const d of defs) {
    if (d.location === 3) continue; // prefer the main block over the numpad for characters
    if (d.key === name) return { def: d, shifted: false };
  }
  for (const d of defs) {
    if (d.location === 3) continue;
    if (d.shiftKey === name) return { def: d, shifted: true };
  }
  return undefined;
}
