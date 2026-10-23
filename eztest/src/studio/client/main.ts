/**
 * EZTest Studio client entry: registers the built-in pages, panels, commands
 * and shortcuts, mounts the workbench and connects the live event stream.
 * Later features register themselves the same way (see docs/studio.md).
 */
import { TOKEN } from './core/api.js';
import { startEvents } from './core/events.js';
import { registerShortcut, startShortcuts } from './core/keys.js';
import { pages, registerCommand, runCommand } from './core/registry.js';
import { link, navigate } from './core/router.js';
import { loadGrammar, loadSession, refreshJourneys, refreshProblems, restoreActiveRun, startState } from './core/state.js';
import { theme, toggleTheme } from './core/theme.js';
import { registerAssurancePage } from './pages/assurance.js';
import { registerDashboardPage } from './pages/dashboard.js';
import { registerDebugPage } from './pages/debug/page.js';
import { registerDesktopTab } from './pages/desktop.js';
import { registerImportPage } from './pages/import.js';
import { registerInsightsPage } from './pages/insights.js';
import { registerJourneysPage } from './pages/journeys/page.js';
import { registerPanelsAndStatus } from './pages/panels.js';
import { registerQualityCenter } from './pages/quality/index.js';
import { registerProjectPage } from './pages/project.js';
import { registerLoadPage } from './pages/load.js';
import { registerRecordPage } from './pages/record.js';
import { registerResultsPage } from './pages/results.js';
import { registerRunPage } from './pages/run.js';
import { registerSettingsPage } from './pages/settings.js';
import { registerSourceControlPage } from './pages/source-control.js';
import { registerTracePage } from './pages/trace/page.js';
import { registerMobileTab } from './pages/mobile.js';
import { registerWorkbenchPage } from './pages/workbench.js';
import { registerManualPage } from './pages/manual/index.js';
import { registerPluginPages } from './pages/plugins.js';
import { openShortcutsHelp } from './ui/help.js';
import { openPalette } from './ui/palette.js';
import { mountShell, togglePanel } from './ui/shell.js';
import { toastError } from './ui/toast.js';

function registerCore(): void {
  registerCommand({ id: 'palette.commands', title: 'Show all commands', group: 'Help', icon: 'command', shortcut: 'Mod+Shift+P', run: () => openPalette('>') });
  registerCommand({ id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', icon: 'keyboard', shortcut: '?', run: () => openShortcutsHelp() });
  registerCommand({ id: 'view.theme', title: 'Toggle light / dark theme', group: 'View', icon: 'sun', keywords: ['dark mode', 'light mode', 'appearance'], run: () => toggleTheme() });
  registerCommand({ id: 'view.themeSystem', title: 'Use the system theme', group: 'View', icon: 'settings', when: () => theme.get() !== 'system', run: () => theme.set('system') });
  registerCommand({
    id: 'data.reload',
    title: 'Reload journeys and problems',
    group: 'View',
    icon: 'refresh',
    run: async () => {
      await Promise.all([refreshJourneys(), refreshProblems()]);
    },
  });

  registerShortcut({ keys: 'Mod+K', title: 'Command palette', group: 'General', inInputs: true, run: () => openPalette() });
  registerShortcut({ keys: 'Mod+Shift+P', title: 'Commands', group: 'General', inInputs: true, run: () => openPalette('>') });
  registerShortcut({ keys: 'Mod+P', title: 'Open a journey', group: 'General', inInputs: true, run: () => openPalette() });
  registerShortcut({ keys: '?', title: 'Keyboard shortcuts', group: 'General', run: () => openShortcutsHelp() });
  registerShortcut({ keys: 'Mod+J', title: 'Toggle panel', group: 'View', inInputs: true, run: () => togglePanel() });
  registerShortcut({ keys: 'Mod+Shift+M', title: 'Show problems', group: 'View', inInputs: true, run: () => runCommand('view.problems') });
  // Alt+<n> opens the page with that shortcut.
  for (let n = 1; n <= 9; n++) {
    registerShortcut({
      keys: `Alt+${n}`,
      title: `Open page ${n}`,
      group: 'Navigate',
      inInputs: true,
      when: () => pages.get().some((p) => p.shortcut === `Alt+${n}`),
      run: () => {
        const p = pages.get().find((x) => x.shortcut === `Alt+${n}`);
        if (p) navigate(link(p.route ?? p.id));
      },
    });
  }
}

async function boot(): Promise<void> {
  // The token stays in the meta tag; drop it from the address bar.
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  if (!TOKEN) {
    document.body.textContent = 'Missing session token: open the Studio with the link printed by "eztest studio".';
    return;
  }
  registerCore();
  registerDashboardPage();
  registerJourneysPage();
  registerDebugPage();
  registerRunPage();
  registerResultsPage();
  registerTracePage();
  registerDesktopTab();
  registerMobileTab();
  registerInsightsPage();
  registerRecordPage();
  registerImportPage();
  registerSettingsPage();
  registerQualityCenter();
  registerAssurancePage();
  registerWorkbenchPage();
  registerManualPage();
  registerProjectPage();
  registerLoadPage();
  registerSourceControlPage();
  registerPanelsAndStatus();
  void registerPluginPages();
  startShortcuts();
  startState();
  mountShell(document.getElementById('app')!);
  try {
    const s = await loadSession();
    startEvents(s.lastEventSeq);
  } catch (e) {
    toastError(`Not connected: ${(e as Error).message}`);
    startEvents(0);
  }
  void refreshJourneys().catch(() => undefined);
  void refreshProblems().catch(() => undefined);
  void restoreActiveRun().catch(() => undefined);
  void loadGrammar().catch(() => undefined);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
