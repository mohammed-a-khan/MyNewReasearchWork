/**
 * Test management (#/manual): manual and hybrid cases, the guided runner,
 * suites / cycles / assignments, the progress dashboard and conversion of a
 * manual case into an automated journey. Server side: routes/manual.ts.
 */
import { registerCommand } from '../../core/registry.js';
import { link, navigate } from '../../core/router.js';
import { registerSectionPage } from '../assurance-ui.js';
import { automateSection } from './automate.js';
import { casesSection } from './cases.js';
import { cyclesSection, dashboardSection } from './cycles.js';
import { runSection } from './runner.js';

export function registerManualPage(): void {
  registerSectionPage({
    id: 'manual',
    title: 'Test management',
    icon: 'check',
    order: 58,
    sections: [dashboardSection, casesSection, runSection, cyclesSection, automateSection],
  });
  registerCommand({ id: 'manual.new', title: 'New manual test case', group: 'Test management', icon: 'plus', keywords: ['manual', 'test case', 'tester'], run: () => navigate(link('manual', 'cases', 'new')) });
}
