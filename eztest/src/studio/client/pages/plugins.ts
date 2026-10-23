/**
 * Plugin pages: every page a plugin registers (registerStudioPage) appears in
 * the activity bar. The page HTML is rendered by the plugin on the server and
 * shown in a frame from GET /api/plugins/pages/<id> (strict CSP, no scripts).
 */
import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { registerPage } from '../core/registry.js';

export async function registerPluginPages(): Promise<void> {
  let list: Array<{ id: string; title: string }> = [];
  try {
    list = await api.get<Array<{ id: string; title: string }>>('/api/plugins/pages');
  } catch {
    return; // older server or no plugins
  }
  if (!Array.isArray(list)) return;
  list.forEach((p, i) => {
    registerPage({
      id: `plugin-${p.id}`,
      title: p.title,
      icon: 'plug',
      group: 'secondary',
      order: 200 + i,
      mount(ctx) {
        ctx.setTitle(p.title);
        const frame = h('iframe', { class: 'plugin-frame', title: p.title, src: `/api/plugins/pages/${encodeURIComponent(p.id)}` }) as HTMLIFrameElement;
        // No scripts in plugin pages (their CSP forbids them too); same-origin so the Studio session cookie applies.
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.style.width = '100%';
        frame.style.height = '100%';
        frame.style.border = '0';
        ctx.root.append(h('h1', { class: 'sr-only', text: p.title }), frame);
        return { focus: () => frame.focus() };
      },
    });
  });
}
