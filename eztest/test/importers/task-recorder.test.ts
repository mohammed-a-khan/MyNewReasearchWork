import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { importTaskRecorder } from '../../src/importers/index.js';

const XML = readFileSync(fileURLToPath(new URL('./fixtures/create-sales-order.xml', import.meta.url)), 'utf8');

describe('D365 Task Recorder / RSAT importer', () => {
  const r = importTaskRecorder(XML, { file: 'create-sales-order.xml' });
  const c = r.converted[0];

  it('maps menu items, control values, commands and validations by control label', () => {
    expect(c.name).toBe('Create a sales order');
    const lines = c.ez.split('\n');
    expect(lines.slice(1, 4)).toEqual([
      'Journey: Create a sales order',
      'Description: Create a sales order for customer US-001 and confirm it.',
      'Tags: @d365',
    ]);
    expect(lines.slice(5)).toEqual([
      '# Task: Create a sales order',
      'Open "/?mi=SalesTableListPage"',
      'Click the "New" button',
      '# Task: Fill in the order header',
      'Set the "Customer account" field to "US-001"',
      'Select "FOB" from the "Delivery terms" dropdown',
      'Check the "Prices include sales tax" checkbox',
      '# Info: The order header defaults the site and warehouse from the customer.',
      'Click the "OK" button',
      'Set [data-dyn-controlname="SalesLine_ItemId"] input to "D0001"',
      '  Expect the "Customer account" field has value "US-001"',
      '# TODO (not converted): Validate that Order status is not Invoiced.',
      '# TODO (not converted): In the list, mark the selected row.',
      '',
    ]);
  });

  it('produces label-based targets and value post-conditions', () => {
    const j = c.journey!;
    expect(parseEzScript(c.ez)).toEqual(j);
    const set = j.steps.find((s) => s.intent.startsWith('Set the "Customer account"'))!;
    expect(set).toMatchObject({ action: 'fill', value: 'US-001' });
    expect(set.target!.locators[0]).toMatchObject({ strategy: 'label', value: 'Customer account' });
    const item = j.steps.find((s) => s.intent.includes('SalesLine_ItemId'))!;
    expect(item.postconditions[0]).toMatchObject({ type: 'valueEquals', value: 'US-001' });
    expect(item.target!.locators).toEqual([{ strategy: 'css', value: '[data-dyn-controlname="SalesLine_ItemId"] input' }]);
  });

  it('reports unconverted actions with their source line', () => {
    expect(r.todo.map((t) => [t.line, t.reason])).toEqual([
      [XML.split('\n').findIndex((l) => l.includes('Order status is not Invoiced')), 'validation operator "notequal" is not converted'],
      [XML.split('\n').findIndex((l) => l.includes('mark the selected row')), 'user action type "GridRowUserAction" is not converted'],
    ]);
    expect(r.coverage).toEqual({ sourceSteps: 8, convertedSteps: 7, assertions: 2, convertedAssertions: 1 });
  });

  it('tolerates other shapes: UserAction elements, company and custom menu URLs, invalid XML', () => {
    const xml = `<TaskRecording><Name>Mini</Name><Steps>
      <UserAction><UserActionType>Navigate</UserActionType><MenuItemName>CustTable</MenuItemName><MenuItemType>Action</MenuItemType></UserAction>
      <UserAction><UserActionType>Click</UserActionType><ControlLabel>Save</ControlLabel></UserAction>
      <Validation><ControlLabel>Name</ControlLabel><Value>Contoso</Value></Validation>
    </Steps></TaskRecording>`;
    const rr = importTaskRecorder(xml, { file: 'mini.xml', company: 'USMF' });
    expect(rr.converted[0].ez).toContain('Open "/?cmp=USMF&mi=action:CustTable"\nClick the "Save" button\n  Expect the "Name" field has value "Contoso"');
    const custom = importTaskRecorder(xml, { menuItemUrl: (n) => `/d365/${n}` });
    expect(custom.converted[0].ez).toContain('Open "/d365/CustTable"');
    const bad = importTaskRecorder('<Recording><Name>x</Recording>', { file: 'bad.xml' });
    expect(bad.journeys).toHaveLength(0);
    expect(bad.todo[0]).toMatchObject({ file: 'bad.xml', line: 1 });
    expect(bad.todo[0].reason).toMatch(/invalid XML/);
  });
});
