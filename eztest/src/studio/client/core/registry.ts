/**
 * The Studio's extension registries. A feature adds itself with one call:
 *
 *   registerPage({ id, title, icon, route, group, mount })   a page + nav entry
 *   registerCommand({ id, title, run })                       a palette command
 *   registerCommandProvider({ id, items(query) })             dynamic palette items
 *   registerRunDetailTab({ id, title, mount })                a tab in run details
 *   registerPanel({ id, title, mount })                       a bottom panel tab
 *   registerStatusItem({ id, align, mount })                  a status bar item
 *
 * Registration order does not matter: the shell re-renders when a registry changes.
 */
import type { IconName } from '../ui/icons.js';
import type { Route } from './router.js';
import { store, type Readable } from './store.js';

// ------------------------------------------------------------------ pages

export interface PageContext {
  /** The page's own container (kept alive while the page is hidden). */
  root: HTMLElement;
  /** The current route (page segment matches this page). */
  route: Readable<Route>;
  /** Set the document title suffix. */
  setTitle(title: string): void;
}

export interface PageInstance {
  /** Called whenever the page becomes visible or its route changes. */
  show?(route: Route): void;
  /** Called when another page takes over. */
  hide?(): void;
  /** Move focus to the page's main heading or primary control. */
  focus?(): void;
}

/** Activity bar group: primary (top), quality (the Quality Center section, labelled) or secondary (bottom). */
export type NavGroup = 'primary' | 'quality' | 'secondary';

export interface PageDef {
  id: string;
  title: string;
  icon: IconName;
  /** First hash segment (default: id). */
  route?: string;
  /** Activity bar group: primary (top) or secondary (bottom). Default primary. */
  group?: NavGroup;
  /** Sort order inside its group (lower first). Default 100. */
  order?: number;
  /** Hidden from the activity bar (still routable and in the palette). */
  hidden?: boolean;
  /** Keyboard shortcut to open the page, e.g. "Alt+2". */
  shortcut?: string;
  mount(ctx: PageContext): PageInstance | void;
}

export const pages = store<PageDef[]>([]);

export function registerPage(def: PageDef): () => void {
  pages.update((list) => [...list.filter((p) => p.id !== def.id), def].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => pages.update((list) => list.filter((p) => p !== def));
}

export function pageForRoute(segment: string): PageDef | undefined {
  return pages.get().find((p) => (p.route ?? p.id) === segment);
}

// ------------------------------------------------------------------ commands

export interface CommandDef {
  id: string;
  title: string;
  /** Palette group heading, e.g. "Navigate", "Run", "Editor", "View". */
  group?: string;
  keywords?: string[];
  icon?: IconName;
  /** Shown in the palette and the shortcuts help, e.g. "Mod+S". Binding is done with registerShortcut. */
  shortcut?: string;
  /** Hide the command when this returns false. */
  when?(): boolean;
  run(): void | Promise<void>;
}

export const commands = store<CommandDef[]>([]);

export function registerCommand(def: CommandDef): () => void {
  commands.update((list) => [...list.filter((c) => c.id !== def.id), def]);
  return () => commands.update((list) => list.filter((c) => c !== def));
}

export function runCommand(id: string): void {
  const c = commands.get().find((x) => x.id === id);
  if (c && (!c.when || c.when())) void c.run();
}

export interface PaletteItem {
  id: string;
  title: string;
  detail?: string;
  group: string;
  icon?: IconName;
  keywords?: string[];
  run(): void;
}

export interface CommandProvider {
  id: string;
  /** Only consulted when the query starts with this prefix (e.g. "@"); omit to join the default search. */
  prefix?: string;
  /** Description of the prefix mode for the palette's help row. */
  hint?: string;
  items(query: string): PaletteItem[] | Promise<PaletteItem[]>;
}

export const providers = store<CommandProvider[]>([]);

export function registerCommandProvider(p: CommandProvider): () => void {
  providers.update((list) => [...list.filter((x) => x.id !== p.id), p]);
  return () => providers.update((list) => list.filter((x) => x !== p));
}

// ------------------------------------------------------------------ run detail tabs

/** The run detail payload from `GET /api/runs/:id` (shape owned by the server). */
export interface RunDetail {
  run: {
    runId: string;
    startedAt: string;
    durationMs: number;
    summary: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
    journeys: Array<{
      journeyId: string;
      name: string;
      status: string;
      durationMs: number;
      attempt: number;
      error?: { message: string; name?: string };
      /** Cross-browser runs: the browser of this journey x browser unit. */
      browser?: string;
      /** Gherkin scenarios: feature, rule, scenario and Examples row. */
      bdd?: {
        file: string;
        feature: { name: string; line: number };
        rule?: { name: string; line: number };
        scenario: { name: string; line: number; keyword: string };
        examples?: { name: string; line: number; row?: { line: number; index: number } };
      };
      steps: Array<{
        stepId: string;
        intent: string;
        status: string;
        durationMs: number;
        /** Multi-actor journeys: who ran the step. */
        actor?: string;
        error?: { message: string };
        heal?: { tier: string; verified: boolean; healed: { strategy: string; value: string; name?: string } };
        evidence: string[];
        conditions?: Array<{ passed: boolean; description?: string; message?: string }>;
        /** Gherkin scenarios: the feature step or hook, and what it was bound to. */
        gherkin?: { kind: 'step' | 'before' | 'after' | 'beforeAll' | 'afterAll'; keyword?: string; text?: string; line: number; match?: string; location?: string; snippet?: string; background?: boolean };
      }>;
      evidence: string[];
    }>;
    environment?: Record<string, string>;
  };
  evidence: Record<string, { kind: string; path: string; description?: string }>;
  verification: { ok: boolean; entries: number; problems: string[] };
  healProposals?: { proposals?: Array<Record<string, unknown>>; rejected?: Array<Record<string, unknown>> };
  insights?: Record<string, unknown>;
  report?: string;
}

export interface RunDetailContext {
  /** Deep-link target inside the run, from `#/runs/<id>/<journeyId>/<stepId>`. */
  journeyId?: string;
  stepId?: string;
  /** Switch to another tab of the same run. */
  selectTab(id: string): void;
}

export interface RunDetailTab {
  id: string;
  title: string;
  order?: number;
  /** Hide the tab for runs where it has nothing to show. */
  when?(detail: RunDetail): boolean;
  /** Count shown next to the title. */
  badge?(detail: RunDetail): string | number | undefined;
  mount(el: HTMLElement, detail: RunDetail, ctx: RunDetailContext): void | (() => void);
}

export const runDetailTabs = store<RunDetailTab[]>([]);

export function registerRunDetailTab(tab: RunDetailTab): () => void {
  runDetailTabs.update((list) => [...list.filter((t) => t.id !== tab.id), tab].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => runDetailTabs.update((list) => list.filter((t) => t !== tab));
}

// ------------------------------------------------------------------ bottom panel and status bar

export interface PanelDef {
  id: string;
  title: string;
  order?: number;
  /** Count shown in the tab. */
  badge?: Readable<number | string | undefined>;
  mount(el: HTMLElement): void;
}

export const panels = store<PanelDef[]>([]);

export function registerPanel(p: PanelDef): () => void {
  panels.update((list) => [...list.filter((x) => x.id !== p.id), p].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => panels.update((list) => list.filter((x) => x !== p));
}

export interface StatusItemDef {
  id: string;
  align: 'left' | 'right';
  order?: number;
  mount(el: HTMLElement): void;
}

export const statusItems = store<StatusItemDef[]>([]);

export function registerStatusItem(s: StatusItemDef): () => void {
  statusItems.update((list) => [...list.filter((x) => x.id !== s.id), s].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => statusItems.update((list) => list.filter((x) => x !== s));
}

// ------------------------------------------------------------------ dashboard cards

export interface DashboardCardDef {
  id: string;
  order?: number;
  /** Build the card (a `card()` element); called whenever the dashboard refreshes. Return undefined to skip it. */
  render(): HTMLElement | undefined | Promise<HTMLElement | undefined>;
}

export const dashboardCards = store<DashboardCardDef[]>([]);

export function registerDashboardCard(c: DashboardCardDef): () => void {
  dashboardCards.update((list) => [...list.filter((x) => x.id !== c.id), c].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => dashboardCards.update((list) => list.filter((x) => x !== c));
}
