/** The event hub (topics, replay buffers) and its multiplexed SSE stream `/api/events`. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { EventHub, startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, raw, readSse } from './helpers.js';

describe('EventHub', () => {
  it('publishes to topic subscribers with global sequence numbers', () => {
    const hub = new EventHub();
    const all: string[] = [];
    const runOnly: string[] = [];
    const offAll = hub.subscribe((e) => all.push(`${e.topic}:${e.data.type}:${e.seq}`));
    hub.subscribe((e) => runOnly.push(e.data.type), ['run']);
    hub.publish('run', { type: 'queued', runId: 'r1' });
    hub.publish('files', { type: 'changed', path: 'journeys/a.ez' });
    hub.publish('my-feature', { type: 'custom', n: 1 }); // undeclared topics are declared on first use
    offAll();
    hub.publish('run', { type: 'done', runId: 'r1' });
    expect(all).toEqual(['run:queued:1', 'files:changed:2', 'my-feature:custom:3']);
    expect(runOnly).toEqual(['queued', 'done']);
    expect(hub.lastSeq).toBe(4);
    expect(hub.topicNames().map((t) => t.name)).toEqual(expect.arrayContaining(['run', 'recorder', 'files', 'problems', 'system', 'my-feature']));
  });

  it('replays the last N events per topic, merged in order', () => {
    const hub = new EventHub();
    hub.registerTopic('ticks', { replay: 3 });
    for (let i = 1; i <= 5; i++) hub.publish('ticks', { type: 'tick', i });
    hub.publish('run', { type: 'queued', runId: 'x' });
    expect(hub.replay(0, ['ticks']).map((e) => e.data.i)).toEqual([3, 4, 5]);
    expect(hub.replay(4).map((e) => e.seq)).toEqual([5, 6]);
    expect(hub.replay(0).map((e) => e.topic)).toEqual(['ticks', 'ticks', 'ticks', 'run']);
  });

  it('never lets a broken listener break publishing', () => {
    const hub = new EventHub();
    const got: number[] = [];
    hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((e) => got.push(e.seq));
    hub.publish('system', { type: 'x' });
    expect(got).toEqual([1]);
  });
});

describe('/api/events', () => {
  let studio: StudioHandle;
  beforeAll(async () => {
    studio = await startStudio({ cwd: await copyShopProject(), watch: false });
  });
  afterAll(async () => studio?.close());

  it('needs the token and validates its query', async () => {
    expect((await raw(studio.port, '/api/events')).status).toBe(401);
    const c = client(studio.port, studio.token);
    expect((await c.get('/api/events?topics=a%20b')).status).toBe(400);
    expect((await c.get('/api/events?since=-1')).status).toBe(400);
  });

  it('replays buffered events, then streams live ones, filtered by topic', async () => {
    const hub = studio.app.hub;
    const base = hub.lastSeq;
    hub.publish('files', { type: 'added', path: 'journeys/one.ez' });
    hub.publish('run', { type: 'queued', runId: 'r' });
    const pending = readSse(studio.port, `/api/events?topics=files&since=${base}`, studio.token, (e) => e.path === 'journeys/two.ez', 10_000);
    setTimeout(() => {
      hub.publish('run', { type: 'done', runId: 'r' });
      hub.publish('files', { type: 'changed', path: 'journeys/two.ez' });
    }, 150);
    const events = await pending;
    expect(events.map((e) => `${e.topic}:${e.type}:${e.path}`)).toEqual(['files:added:journeys/one.ez', 'files:changed:journeys/two.ez']);
    expect(events[0].seq).toBe(base + 1);
    expect(typeof events[0].at).toBe('string');
  });

  it('resumes after Last-Event-ID without duplicates', async () => {
    const hub = studio.app.hub;
    const first = hub.publish('system', { type: 'a' }).seq;
    hub.publish('system', { type: 'b' });
    hub.publish('system', { type: 'c' });
    const events = await new Promise<string[]>((resolve, reject) => {
      const got: string[] = [];
      import('node:http').then(({ request }) => {
        const req = request(
          { host: '127.0.0.1', port: studio.port, path: `/api/events?topics=system&since=0`, headers: { host: `127.0.0.1:${studio.port}`, authorization: `Bearer ${studio.token}`, 'last-event-id': String(first) } },
          (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              for (const m of chunk.matchAll(/data: (.+)\n/g)) got.push(JSON.parse(m[1]).type);
              if (got.includes('c')) {
                req.destroy();
                resolve(got);
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
    });
    expect(events.filter((t) => ['a', 'b', 'c'].includes(t))).toEqual(['b', 'c']);
  });
});
