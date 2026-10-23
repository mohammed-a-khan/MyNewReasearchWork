/**
 * The page-side engine the driver installs: the full selector engine
 * (./engine.ts). The interim ./stub-engine.ts stays as a fallback for
 * debugging: switch this line to './stub-engine.js' to use it.
 */
export { engineSource } from './engine.js';
