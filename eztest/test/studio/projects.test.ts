/** Studio project switcher: projects.<name> overlays with their own environments, effective values per project. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client } from './helpers.js';

describe('Studio project switcher', () => {
  let dir: string;
  let studio: StudioHandle;
  let c: ReturnType<typeof client>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eztest-studio-projects-'));
    await writeFile(join(dir, 'eztest.config.yaml'), [
      'baseUrl: https://base.example.test',
      'retries: 0',
      'projects:',
      '  shop:',
      '    baseUrl: https://shop.example.test',
      '    identity: { roles: { clerk: { username: clerk, password: "secret://env/CLERK_PW", loginUrl: /login } } }',
      '  admin:',
      '    baseUrl: https://admin.example.test',
      '    retries: 1',
      '',
    ].join('\n'));
    await mkdir(join(dir, 'config', 'shop'), { recursive: true });
    await writeFile(join(dir, 'config', 'shop', 'sit.yaml'), 'retries: 3\n');
    await mkdir(join(dir, 'journeys'));
    studio = await startStudio({ cwd: dir, port: 0, openBrowser: false, env: { PATH: process.env.PATH } });
    c = client(studio.port, studio.token);
  });
  afterAll(async () => {
    await studio?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists projects, switches project and environment, and shows the effective values with their layer', async () => {
    const v = (await c.get('/api/project/environments')).json();
    expect(v.projects).toEqual(['admin', 'shop']);
    expect(v.project).toBeNull();
    expect(v.values.find((x: { path: string }) => x.path === 'baseUrl').value).toBe('https://base.example.test');
    expect(v.values.some((x: { path: string }) => x.path.startsWith('projects.'))).toBe(false);

    expect((await c.post('/api/project/environments/project', { name: 'nope' })).status).toBe(400);
    expect((await c.post('/api/project/environments/project', { name: 'shop' })).json()).toMatchObject({ ok: true, project: 'shop' });
    const shop = (await c.get('/api/project/environments')).json();
    expect(shop).toMatchObject({ project: 'shop', projectOverridden: true });
    expect(shop.values.find((x: { path: string }) => x.path === 'baseUrl')).toMatchObject({ value: 'https://shop.example.test', source: 'projects.shop' });
    expect(shop.environments.map((e: { name: string }) => e.name)).toEqual(['sit']); // config/shop/sit.yaml
    expect(shop.layers.map((l: { source: string }) => l.source)).toEqual(['defaults', 'eztest.config.yaml', 'projects.shop']);

    expect((await c.post('/api/project/environments/active', { name: 'sit' })).json()).toMatchObject({ ok: true, active: 'sit' });
    const sit = (await c.get('/api/project/environments')).json();
    expect(sit.values.find((x: { path: string }) => x.path === 'retries')).toMatchObject({ value: 3, source: 'config/shop/sit.yaml' });
    expect((await c.get('/api/settings')).json().config.retries).toBe(3);

    expect((await c.post('/api/project/environments/active', { name: null })).status).toBe(200);
    expect((await c.post('/api/project/environments/project', { name: 'admin' })).json()).toMatchObject({ ok: true, project: 'admin' });
    const admin = (await c.get('/api/project/environments')).json();
    expect(admin.values.find((x: { path: string }) => x.path === 'retries')).toMatchObject({ value: 1, source: 'projects.admin' });
    await c.post('/api/project/environments/project', { name: null });
    expect((await c.get('/api/project/environments')).json().project).toBeNull();
  });
});
