/**
 * Legacy terminals: TN3270 (IBM Z) and TN5250 (IBM i) clients in TypeScript
 * (telnet negotiation, the 3270 and 5250 data streams, fields, attention
 * keys), host simulators for both for offline tests, and the terminal surface
 * that runs plain-English green-screen steps.
 */
export * from './tn3270/ebcdic.js';
export * from './tn3270/screen.js';
export * from './tn3270/fields.js';
export * from './tn3270/client.js';
export * from './tn3270/simulator.js';
export { TelnetConnection, type TelnetPolicy } from './telnet.js';
export { renderScreenSvg, type RenderableScreen } from './render.js';
export { TerminalSurface, type TerminalHostConfig } from './terminal.js';
export * from './tn5250/screen.js';
export * from './tn5250/client.js';
export * from './tn5250/simulator.js';
export type { TerminalClient, TerminalScreen, TerminalWaitOptions } from './types.js';
