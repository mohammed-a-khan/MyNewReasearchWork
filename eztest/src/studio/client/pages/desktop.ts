/**
 * "Desktop & legacy" run-detail tab: for steps run by the desktop and legacy
 * driver ladder (Electron, Windows/Java agents, SAP GUI, TN3270, image/OCR),
 * which driver and rung acted, how the element was found, the screen box,
 * the screenshot (with match boxes) and the terminal screen as text.
 */
import { runAsset } from '../core/api.js';
import { h } from '../core/dom.js';
import { registerRunDetailTab, type RunDetail } from '../core/registry.js';
import { badge, statusIcon } from '../ui/badge.js';

interface SurfaceUse {
  driver: string;
  rung: string;
  via?: string;
  box?: { x: number; y: number; width: number; height: number };
}

type Step = RunDetail['run']['journeys'][number]['steps'][number] & { surface?: SurfaceUse };

const DRIVERS: Record<string, string> = { electron: 'Electron', windows: 'Windows UIA', java: 'Java Swing', sap: 'SAP GUI', tn3270: 'Mainframe 3270', tn5250: 'Mainframe 5250', vision: 'Image / OCR' };

function surfaceSteps(d: RunDetail): Array<{ journey: string; journeyId: string; step: Step }> {
  const out: Array<{ journey: string; journeyId: string; step: Step }> = [];
  for (const j of d.run.journeys) for (const s of j.steps as Step[]) if (s.surface) out.push({ journey: j.name, journeyId: j.journeyId, step: s });
  return out;
}

function terminalText(url: string, into: HTMLElement): void {
  void fetch(url)
    .then((r) => r.json() as Promise<{ text?: string[] }>)
    .then((j) => {
      if (Array.isArray(j.text)) into.textContent = j.text.join('\n');
    })
    .catch(() => {
      into.textContent = '(screen snapshot unavailable)';
    });
}

export function registerDesktopTab(): void {
  registerRunDetailTab({
    id: 'desktop',
    title: 'Desktop & legacy',
    order: 37,
    when: (d) => surfaceSteps(d).length > 0,
    badge: (d) => surfaceSteps(d).length || undefined,
    mount(el, d) {
      const rows = surfaceSteps(d);
      let current = '';
      for (const { journey, step } of rows) {
        if (journey !== current) {
          current = journey;
          el.append(h('h3', { class: 'h3', text: journey }));
        }
        const s = step.surface!;
        const ev = step.evidence.map((id) => d.evidence[id]).filter(Boolean);
        const shot = ev.find((e) => e.kind === 'screenshot');
        const screen = ev.find((e) => e.kind === 'data' && /terminal screen/.test(e.description ?? ''));
        const pre = screen ? h('pre', { class: 'code-block', style: { background: '#0b0f0b', color: '#33ff66', padding: '8px', overflow: 'auto', fontSize: '12px', lineHeight: '1.25' }, 'aria-label': 'Terminal screen' }) : null;
        if (screen && pre) terminalText(runAsset(d.run.runId, screen.path), pre);
        el.append(
          h(
            'div',
            { class: 'card', style: { marginBottom: '12px' } },
            h('div', { class: 'row wrap' }, statusIcon(step.status), h('strong', { text: step.intent }), badge('info', DRIVERS[s.driver] ?? s.driver), badge('info', `rung: ${s.rung}`)),
            s.via ? h('p', { class: 'muted', text: `Found by ${s.via}` }) : null,
            s.box ? h('p', { class: 'muted', text: s.driver === 'tn3270' ? `Row ${s.box.y}, column ${s.box.x}, ${s.box.width} positions` : `Box ${Math.round(s.box.x)},${Math.round(s.box.y)} ${Math.round(s.box.width)}×${Math.round(s.box.height)} px` }) : null,
            step.heal ? h('p', { class: 'heal-note', text: `Healed via ${step.heal.tier} to ${step.heal.healed.strategy}=${step.heal.healed.value}${step.heal.verified ? ' (verified)' : ' (NOT verified)'}` }) : null,
            step.error ? h('p', { class: 'error-note', text: step.error.message }) : null,
            shot ? h('img', { src: runAsset(d.run.runId, shot.path), alt: `Screen after: ${step.intent}`, loading: 'lazy', style: { maxWidth: '100%', border: '1px solid var(--border, #ccc)' } }) : null,
            pre,
          ),
        );
      }
    },
  });
}
