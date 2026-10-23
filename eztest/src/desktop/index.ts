/**
 * The desktop and legacy driver ladder (docs/desktop-and-legacy.md): Electron,
 * Windows UI Automation and Java Swing through EZTest's own agents, SAP GUI
 * Scripting, TN3270 terminals and the image/OCR rung, behind the same
 * plain-English journeys.
 */
export * from './config.js';
export * from './surface.js';
export * from './interceptor.js';
export * from './agent.js';
export * from './agent-surface.js';
export * from './java.js';
export * from './desktop-handlers.js';
export * from './integration.js';
export * from './sap.js';
export * from './sap-handlers.js';
export * from './electron.js';
export * from './vision/image.js';
export * from './vision/template.js';
export * from './vision/ocr.js';
export * from './vision/rfb.js';
export { vncAuthResponse, desEncrypt } from './vision/des.js';
export * from './vision/surface.js';
export * from './vision/sources.js';
export * from './vision/handlers.js';
