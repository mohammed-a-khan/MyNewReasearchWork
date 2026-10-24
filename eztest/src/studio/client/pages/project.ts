/**
 * Project workspace: environments, identities and roles, test data, mocks,
 * shared elements, monitors, performance and compliance, as one page with section navigation
 * (`#/project/<section>/...`).
 */
import { complianceSection } from './project-compliance.js';
import { dataSection } from './project-data.js';
import { storeSection } from './project-store.js';
import { environmentsSection } from './project-environments.js';
import { identitySection } from './project-identity.js';
import { mocksSection } from './project-mocks.js';
import { contractsSection, messagesSection } from './project-contracts.js';
import { monitorsSection } from './project-monitors.js';
import { perfSection } from './project-perf.js';
import { elementsSection } from './project-elements.js';
import { registerSectionPage } from './assurance-ui.js';

export function registerProjectPage(): void {
  registerSectionPage({
    id: 'project',
    title: 'Project',
    icon: 'briefcase',
    order: 800,
    group: 'secondary',
    sections: [environmentsSection, identitySection, dataSection, storeSection, mocksSection, contractsSection, messagesSection, elementsSection, monitorsSection, perfSection, complianceSection],
  });
}
