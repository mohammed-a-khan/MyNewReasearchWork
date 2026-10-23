/**
 * Plain-English Power Apps canvas phrasings; every line names Power Apps (or
 * Power Fx). The Dataverse cross-check reuses the D365 add-on's own phrasing
 * and handler ("Verify in Dataverse that account "Contoso" has ...").
 */
import type { Journey } from '../../core/index.js';
import { createD365IntentRules } from '../../d365/intents.js';
import type { IntentRule, ParseEzOptions } from '../../intent/index.js';
import { ASSERT, CONTAIN, Q, TO_BE, V, categorize, custom, parseWithRules } from '../common/intents.js';

const PA = String.raw`power\s*apps?`;

export function createPowerAppsIntentRules(o: { dataverse?: boolean } = {}): IntentRule[] {
  const rules = categorize('Power Apps', [
    { name: 'pa-login', keywords: ['log', 'login', 'sign'], example: 'Log in to Power Apps as maker',
      re: new RegExp(String.raw`^(?:log\s*in|login|sign\s*in)\s+(?:to\s+)?${PA}\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('pa.login', { role: V(m[1], q) }) },
    { name: 'pa-open-app', keywords: ['open', 'play', 'launch'], example: 'Open the Power Apps app "Account Manager"',
      re: new RegExp(String.raw`^(?:open|play|launch|start)\s+(?:the\s+)?${PA}\s+(?:canvas\s+)?app\s+${Q}$`, 'i'),
      build: (m, q) => custom('pa.openApp', { app: V(m[1], q) }) },
    { name: 'pa-expect-powerfx', keywords: ['expect', 'verify', 'check', 'assert'], example: 'Expect Power Fx `CountRows(galAccounts.AllItems) = 3`',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?power\s*fx\s+(?:formula\s+|expression\s+)?${Q}(?:\s+(?:to\s+be|is)\s+true)?$`, 'i'),
      build: (m, q) => custom('pa.expectPowerFx', { expression: V(m[1], q) }) },
    { name: 'pa-expect-property', keywords: ['expect', 'verify', 'check'], example: 'Expect Power Apps control "lblStatus".Text to be "Saved"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${PA}\s+(?:control\s+${Q}\s*\.\s*([A-Za-z]\w*)|property\s+(⟦\d+⟧))\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => {
        if (m[3]) {
          const [control, ...rest] = V(m[3], q).split('.');
          return rest.length ? custom('pa.expectProperty', { control, property: rest.join('.'), value: V(m[4], q) }) : undefined;
        }
        return custom('pa.expectProperty', { control: V(m[1], q), property: m[2], value: V(m[4], q) });
      } },
    { name: 'pa-expect-state', keywords: ['expect', 'verify', 'check'], example: 'Expect Power Apps control "btnDelete" to be hidden',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${PA}\s+control\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(visible|hidden|disabled|enabled|read[\s-]?only)$`, 'i'),
      build: (m, q) => custom('pa.expectState', { control: V(m[1], q), state: m[2].toLowerCase().replace(/\s+/g, '-').replace(/^readonly$/, 'read-only') }) },
    { name: 'pa-expect-gallery-count', keywords: ['expect', 'verify', 'check'], example: 'Expect Power Apps gallery "galAccounts" to have 3 items',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${PA}\s+gallery\s+${Q}\s+(?:to\s+have|has|should\s+have)\s+(\d+)\s+items?$`, 'i'),
      build: (m, q) => custom('pa.expectGallery', { gallery: V(m[1], q), count: Number(m[2]) }) },
    { name: 'pa-expect-gallery', keywords: ['expect', 'verify', 'check'], example: 'Expect Power Apps gallery "galAccounts" to contain "Fabrikam"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${PA}\s+gallery\s+${Q}\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('pa.expectGallery', { gallery: V(m[1], q), value: V(m[2], q) }) },
    { name: 'pa-expect-notification', keywords: ['expect', 'verify', 'check'], example: 'Expect the Power Apps notification to contain "saved"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?${PA}\s+notification\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('pa.expectNotification', { text: V(m[1], q) }) },
    { name: 'pa-expect-screen', keywords: ['expect', 'verify', 'check'], example: 'Expect the Power Apps screen to be "EditScreen"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:active\s+)?${PA}\s+screen\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => custom('pa.expectScreen', { screen: V(m[1], q) }) },
    { name: 'pa-select-item-where', keywords: ['select', 'in'], example: 'In Power Apps gallery "galAccounts", select the item where "lblAccountName" is "Fabrikam"',
      re: new RegExp(String.raw`^in\s+(?:the\s+)?${PA}\s+gallery\s+${Q}\s*,?\s+select\s+the\s+item\s+where\s+${Q}\s+(?:is|=|equals)\s+${Q}$`, 'i'),
      build: (m, q) => custom('pa.selectItem', { gallery: V(m[1], q), where: { control: V(m[2], q), value: V(m[3], q) } }) },
    { name: 'pa-select-item', keywords: ['select'], example: 'Select item 2 in Power Apps gallery "galAccounts"',
      re: new RegExp(String.raw`^select\s+(?:the\s+)?item\s+(\d+)\s+(?:in|of)\s+(?:the\s+)?${PA}\s+gallery\s+${Q}$`, 'i'),
      build: (m, q) => custom('pa.selectItem', { gallery: V(m[2], q), index: Number(m[1]) }) },
    { name: 'pa-set-control', keywords: ['set', 'enter', 'choose'], example: 'Set Power Apps control "txtName" to "Contoso"',
      re: new RegExp(String.raw`^(?:set|enter|choose|change)\s+(?:the\s+)?${PA}\s+control\s+${Q}\s+(?:to|with)\s+(.+)$`, 'i'),
      build: (m, q) => custom('pa.setControl', { control: V(m[1], q), value: V(m[2], q) }) },
    { name: 'pa-select', keywords: ['select', 'press', 'click'], example: 'Select Power Apps control "btnSave"',
      re: new RegExp(String.raw`^(?:select|press|click|tap)\s+(?:the\s+)?${PA}\s+(?:control|button)\s+${Q}$`, 'i'),
      build: (m, q) => custom('pa.select', { control: V(m[1], q) }) },
  ]);
  // The Dataverse cross-check is the D365 add-on's phrasing; the pack registers it when no d365 block does.
  if (o.dataverse) rules.push(...createD365IntentRules().filter((r) => r.name === 'd365-verify-dataverse'));
  return rules;
}

export const POWERAPPS_INTENT_RULES: IntentRule[] = createPowerAppsIntentRules({ dataverse: true });

export function parsePowerAppsEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  return parseWithRules(text, POWERAPPS_INTENT_RULES, opts);
}
