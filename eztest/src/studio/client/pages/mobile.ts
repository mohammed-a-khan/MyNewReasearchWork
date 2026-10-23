/**
 * Run detail "Device" tab for native mobile journeys (Platform: android/ios):
 * the device and app of each journey, and a small inspector per step that has
 * a screenshot and a page-source snapshot: the screenshot with every element
 * of the hierarchy drawn at its bounds; picking an element shows its
 * attributes and an EZ target for it. Time-travel traces of mobile journeys
 * open in the regular Trace tab (snapshots are drawn the same way).
 */
import { h } from '../core/dom.js';
import { runAsset } from '../core/api.js';
import { registerRunDetailTab, type RunDetail } from '../core/registry.js';

interface MobileStep {
  journey: string;
  intent: string;
  status: string;
  shot?: string;
  source?: string;
}

const browserOf = (j: object) => (j as { browser?: string }).browser;
const isMobileJourney = (j: object) => /^(?:android|ios)\b/.test(browserOf(j) ?? '');

function mobileSteps(d: RunDetail): MobileStep[] {
  const out: MobileStep[] = [];
  for (const j of d.run.journeys) {
    if (!isMobileJourney(j)) continue;
    for (const s of j.steps) {
      const ev = (s.evidence ?? []).map((id) => d.evidence[id]).filter(Boolean);
      const shot = ev.find((e) => e.kind === 'screenshot')?.path;
      const source = ev.find((e) => e.kind === 'dom' && e.path.endsWith('.source.xml'))?.path;
      if (shot || source) out.push({ journey: j.name, intent: s.intent, status: s.status, shot, source });
    }
  }
  return out;
}

interface Box {
  el: Element;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesOf(doc: Document): Box[] {
  const out: Box[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(el.getAttribute('bounds') ?? '');
    if (b) out.push({ el, x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] });
    else if (el.hasAttribute('width') && el.hasAttribute('x')) out.push({ el, x: +el.getAttribute('x')!, y: +el.getAttribute('y')!, w: +el.getAttribute('width')!, h: +el.getAttribute('height')! });
  }
  return out.filter((b) => b.w > 0 && b.h > 0);
}

/** An EZ target for an element: the most specific attribute first. */
function targetFor(el: Element): string {
  const id = el.getAttribute('resource-id') || el.getAttribute('identifier');
  if (id) return `id=${id}`;
  const desc = el.getAttribute('content-desc') || el.getAttribute('name');
  if (desc) return `accessibility id=${desc}`;
  const text = el.getAttribute('text') || el.getAttribute('label');
  return text ? `"${text}"` : el.tagName;
}

function inspector(d: RunDetail, s: MobileStep): HTMLElement {
  const stage = h('div', { class: 'mobile-stage', style: { position: 'relative', display: 'inline-block', maxWidth: '360px' } });
  const props = h('pre', { class: 'mobile-props small', style: { whiteSpace: 'pre-wrap', maxWidth: '420px' } }, 'Pick an element on the screen.');
  const img = h('img', { src: s.shot ? runAsset(d.run.runId, s.shot) : '', alt: `Screen after: ${s.intent}`, style: { width: '100%', display: 'block' } }) as HTMLImageElement;
  stage.append(img);
  if (s.source) {
    void fetch(runAsset(d.run.runId, s.source)).then((r) => r.text()).then((xml) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const root = doc.documentElement;
      const w = Number(root.getAttribute('width')) || Math.max(...boxesOf(doc).map((b) => b.x + b.w));
      const hgt = Number(root.getAttribute('height')) || Math.max(...boxesOf(doc).map((b) => b.y + b.h));
      for (const b of boxesOf(doc)) {
        const box = h('button', {
          type: 'button', class: 'mobile-box', title: `${b.el.tagName} ${targetFor(b.el)}`,
          style: { position: 'absolute', left: `${(b.x / w) * 100}%`, top: `${(b.y / hgt) * 100}%`, width: `${(b.w / w) * 100}%`, height: `${(b.h / hgt) * 100}%`, border: '1px solid rgba(56,189,248,.5)', background: 'transparent', padding: '0' },
          onclick: () => {
            stage.querySelectorAll('.mobile-box.on').forEach((x) => { x.classList.remove('on'); (x as HTMLElement).style.outline = ''; });
            box.classList.add('on');
            box.style.outline = '3px solid #e11d48';
            props.textContent = [`<${b.el.tagName}>`, ...Array.from(b.el.attributes).map((a) => `${a.name} = ${a.value}`), '', `EZ target: ${targetFor(b.el)}`].join('\n');
          },
        });
        stage.append(box);
      }
    }).catch(() => { props.textContent = 'Could not load the page source.'; });
  }
  return h('div', { class: 'row wrap', style: { gap: '16px', alignItems: 'flex-start' } }, stage, props);
}

export function registerMobileTab(): void {
  registerRunDetailTab({
    id: 'device',
    title: 'Device',
    order: 32,
    when: (d) => d.run.journeys.some(isMobileJourney),
    badge: (d) => d.run.journeys.filter(isMobileJourney).length || undefined,
    mount(el, d) {
      el.append(h('ul', { class: 'bullets' }, d.run.journeys.filter(isMobileJourney).map((j) => h('li', null, h('strong', { text: j.name }), h('span', { class: 'muted', text: ` · ${browserOf(j)} · ${j.status}` })))));
      const steps = mobileSteps(d);
      if (!steps.length) {
        el.append(h('p', { class: 'muted', text: 'No step screenshots or page sources in this run (screenshots: every-step and mobile.pageSource: every-step keep one per step).' }));
        return;
      }
      const host = h('div', { class: 'mobile-inspector' });
      const pick = h('select', { 'aria-label': 'Step', onchange: () => show(Number(pick.value)) }, steps.map((s, i) => h('option', { value: String(i), text: `${s.journey}: ${s.intent} (${s.status})` }))) as HTMLSelectElement;
      const show = (i: number) => host.replaceChildren(inspector(d, steps[i]));
      el.append(h('p', null, 'Step: ', pick), host);
      show(0);
    },
  });
}
