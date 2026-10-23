/** Page options passed by the server, and a tiny on-page log the tests can read. */
export interface PageOptions {
  path: string;
  locale: string;
  v: string;
  rows?: number;
  params: Record<string, string>;
}

declare global {
  interface Window {
    __PAGE: PageOptions;
  }
}

export const page: PageOptions = window.__PAGE;

export function log(m: string): void {
  let el = document.getElementById('log');
  if (!el) {
    el = document.createElement('div');
    el.id = 'log';
    document.body.appendChild(el);
  }
  el.textContent += `${m}\n`;
}
