/**
 * A device-agent simulator: serves the EZTest agent protocol (the same JSON
 * API as agents/android and agents/ios) over a fixture hierarchy, with a small
 * app model so journeys have observable effects (typing, alerts, check boxes,
 * scrolling lists, rotation). Every request, gesture and key is recorded.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { intersects, parseSource, type Gesture, type NativeNode } from '../../src/mobile/index.js';
import { evaluateXPath } from './xpath-lite.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export interface SimRequest {
  method: string;
  path: string;
  body: unknown;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export class AgentSimulator {
  readonly requests: SimRequest[] = [];
  readonly gestures: Gesture[] = [];
  readonly keys: string[] = [];
  nodes: NativeNode[] = [];
  root?: NativeNode;
  screen = { x: 0, y: 0, width: 1080, height: 2280 };
  orientationValue: 'portrait' | 'landscape' = 'portrait';
  alert?: string;
  platform: 'android' | 'ios' = 'android';
  /** Commands the simulator refuses with "not supported". */
  unsupported = new Set<string>();
  shutdowns = 0;
  private server?: Server;
  port = 0;

  constructor(fixture: string) {
    this.load(fixture);
  }

  /** Load a fixture XML (file path or XML text). */
  load(fixture: string): void {
    const xml = fixture.trim().startsWith('<') ? fixture : readFileSync(fixture, 'utf8');
    const src = parseSource(xml);
    this.nodes = src.nodes;
    this.root = src.root;
    const r = this.root?.attrs;
    if (r?.width) this.screen = { x: 0, y: 0, width: Number(r.width), height: Number(r.height) };
    this.refreshDisplayed();
  }

  node(id: string): NativeNode | undefined {
    return this.nodes[Number(id.replace(/^n/, ''))];
  }

  byId(resourceId: string): NativeNode | undefined {
    return this.nodes.find((n) => n.attrs['resource-id']?.endsWith(`:id/${resourceId}`) || n.attrs['resource-id'] === resourceId);
  }

  source(): string {
    const ser = (n: NativeNode): string => {
      const attrs = Object.entries(n.attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
      return n.children.length ? `<${n.tag} ${attrs}>${n.children.map(ser).join('')}</${n.tag}>` : `<${n.tag} ${attrs}/>`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>${this.root ? ser(this.root) : ''}`;
  }

  private refreshDisplayed(): void {
    for (const n of this.nodes) {
      if (!n.bounds || n.attrs['ez-hidden'] === 'true') {
        if (n.attrs['ez-hidden'] === 'true') n.attrs.displayed = 'false';
        continue;
      }
      n.attrs.displayed = String(intersects(n.bounds, this.screen));
    }
  }

  private setBounds(n: NativeNode, dy: number): void {
    if (!n.bounds) return;
    n.bounds = { ...n.bounds, y: n.bounds.y + dy };
    n.attrs.bounds = `[${n.bounds.x},${n.bounds.y}][${n.bounds.x + n.bounds.width},${n.bounds.y + n.bounds.height}]`;
  }

  private find(using: string, value: string): NativeNode[] {
    const all = this.nodes;
    switch (using) {
      case 'id': return all.filter((n) => n.attrs['resource-id'] === value || n.attrs['resource-id']?.endsWith(`:id/${value}`));
      case 'accessibility id': return all.filter((n) => (this.platform === 'ios' ? n.attrs.name : n.attrs['content-desc']) === value);
      case 'predicate': {
        if (this.platform !== 'ios') break;
        // The predicate form EZTest generates: label == "X" OR name == "X" OR value == "X" (or CONTAINS).
        const m = /^label (==|CONTAINS) "((?:[^"\\]|\\.)*)"/.exec(value);
        if (!m) throw Object.assign(new Error(`unsupported predicate ${value}`), { code: 'invalid argument' });
        const v = m[2].replace(/\\"/g, '"');
        const hit = (x?: string) => (m[1] === '==' ? x === v : (x ?? '').includes(v));
        return all.filter((n) => hit(n.attrs.label) || hit(n.attrs.name) || hit(n.attrs.value));
      }
      case 'text': return all.filter((n) => n.attrs.text === value);
      case 'text contains': return all.filter((n) => (n.attrs.text ?? '').includes(value));
      case 'class': return all.filter((n) => n.tag === value || n.attrs.class === value);
      case 'xpath': return evaluateXPath(value, all, this.root);
      default: break;
    }
    throw Object.assign(new Error(`strategy "${using}" is not supported on ${this.platform}`), { code: 'not supported' });
  }

  /** The app model: what a tap does. */
  private onClick(n: NativeNode): void {
    const alert = n.attrs['ez-alert'];
    if (alert) {
      const user = this.byId('username')?.attrs.text ?? '';
      this.alert = alert.replace('{username}', user);
    }
    if (n.attrs.checkable === 'true') n.attrs.checked = String(n.attrs.checked !== 'true');
    if (n.tag === 'XCUIElementTypeSwitch') n.attrs.value = n.attrs.value === '1' ? '0' : '1';
    if (n.attrs['ez-sets']) {
      const [id, text] = n.attrs['ez-sets'].split('=');
      const t = this.byId(id);
      if (t) t.attrs.text = text;
    }
  }

  /** The app model: a vertical one-finger swipe scrolls the scrollable container under the finger. */
  private onGesture(g: Gesture): void {
    if (g.fingers.length !== 1) return;
    const f = g.fingers[0];
    const a = f[0];
    const b = f[f.length - 1];
    const dy = b.y - a.y;
    if (Math.abs(dy) < 50) return;
    const box = this.nodes.find((n) => n.attrs.scrollable === 'true' && n.bounds && a.x >= n.bounds.x && a.x <= n.bounds.x + n.bounds.width && a.y >= n.bounds.y && a.y <= n.bounds.y + n.bounds.height)
      ?? this.nodes.find((n) => n.attrs.scrollable === 'true');
    if (!box) return;
    const walk = (n: NativeNode) => n.children.forEach((c) => { this.setBounds(c, dy); walk(c); });
    walk(box);
    this.refreshDisplayed();
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const path = req.url ?? '/';
        this.requests.push({ method: req.method ?? 'GET', path, body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const ok = (value: unknown = null) => send(200, { value });
        const err = (status: number, code: string, message: string) => send(status, { error: { code, message } });
        try {
          const route = `${req.method} ${path.replace(/^\/element\/[^/]+/, '/element/:id').replace(/\/attribute\/.+$/, '/attribute/:name')}`;
          if (this.unsupported.has(route)) return err(501, 'not supported', `${route} is not supported on this device`);
          const el = /^\/element\/([^/]+)\/(\w+)(?:\/(.+))?$/.exec(path);
          if (el) {
            const n = this.node(decodeURIComponent(el[1]));
            if (!n) return err(404, 'stale element', 'element is gone');
            switch (el[2]) {
              case 'click': this.onClick(n); return ok();
              case 'clear': n.attrs.text = ''; return ok();
              case 'type':
                if (this.platform === 'ios') n.attrs.value = (n.attrs.value ?? '') + String(body.text ?? '');
                else n.attrs.text = (n.attrs.text ?? '') + String(body.text ?? '');
                return ok();
              case 'text': return ok(this.platform === 'ios' ? (n.attrs.value || n.attrs.label || '') : (n.attrs.text ?? ''));
              case 'rect': return ok(n.bounds ?? { x: 0, y: 0, width: 0, height: 0 });
              case 'displayed': return ok(n.attrs.displayed !== 'false');
              case 'enabled': return ok(n.attrs.enabled !== 'false');
              case 'selected': return ok(n.attrs.selected === 'true' || n.attrs.checked === 'true');
              case 'attribute': return ok(n.attrs[decodeURIComponent(el[3] ?? '')] ?? null);
              default: return err(404, 'unknown command', el[2]);
            }
          }
          switch (`${req.method} ${path}`) {
            case 'GET /status': return send(200, { ready: true, agent: `eztest-${this.platform}-sim`, version: '1.0.0', protocol: 1, platform: this.platform, device: { model: 'Simulated Pixel', sdk: 34 } });
            case 'POST /find': {
              const found = this.find(String(body.using), String(body.value));
              return send(200, { elements: found.map((n) => `n${n.index}`) });
            }
            case 'GET /source': return ok(this.source());
            case 'GET /screenshot': return ok(PNG_1PX);
            case 'GET /window': return ok(this.screen);
            case 'POST /gesture': this.gestures.push(body as unknown as Gesture); this.onGesture(body as unknown as Gesture); return ok();
            case 'POST /key': this.keys.push(String(body.key)); return ok();
            case 'POST /keys': this.keys.push(`text:${String(body.text)}`); return ok();
            case 'GET /orientation': return ok(this.orientationValue);
            case 'POST /orientation': {
              const v = body.value === 'landscape' ? 'landscape' : 'portrait';
              if (v !== this.orientationValue) this.screen = { x: 0, y: 0, width: this.screen.height, height: this.screen.width };
              this.orientationValue = v;
              return ok();
            }
            case 'GET /alert': return ok(this.alert ?? null);
            case 'POST /alert/accept':
            case 'POST /alert/dismiss':
              if (this.alert === undefined) return err(404, 'no such alert', 'no alert is open');
              this.alert = undefined;
              return ok();
            case 'POST /keyboard/hide': return ok();
            case 'POST /geolocation': return err(501, 'not supported', 'mock location is not enabled');
            case 'POST /shutdown': this.shutdowns++; return ok();
            default:
              if (/^POST \/(?:app\/\w+|deeplink|notifications\/open|lock|unlock|shake)$/.test(`${req.method} ${path}`)) return ok();
              return err(404, 'unknown command', `${req.method} ${path}`);
          }
        } catch (e) {
          const code = (e as { code?: string }).code ?? 'invalid argument';
          return err(code === 'not supported' ? 501 : 400, code, (e as Error).message);
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}
