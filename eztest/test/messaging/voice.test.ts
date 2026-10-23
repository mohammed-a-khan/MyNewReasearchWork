/**
 * Phone-call verification end to end. The real TwilioVoiceProvider talks HTTP
 * to TwilioMockServer (a local stand-in for the Twilio REST API: the only
 * external service here), driven by .ez journeys in a real browser: an IVR
 * check on an outbound call, and a voice one-time code the app under test
 * phones to the test number.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { messagingFromConfig } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { MemoryVoiceProvider, TwilioMockServer, TwilioVoiceProvider, normalizeSpokenText, outboundTwiml, type VoiceProvider } from '../../src/messaging/index.js';
import { runJourneys } from '../../src/runner/index.js';

const SID = 'AC00000000000000000000000000000001';
const TOKEN = 'tok-very-secret-123';
let mock: TwilioMockServer;
let app: Server;
let appUrl = '';

beforeAll(async () => {
  mock = await new TwilioMockServer({
    accountSid: SID, authToken: TOKEN,
    answer: (to) => (to === '+15550100'
      ? { transcript: 'Thank you for calling Acme Bank. For billing, press 1. For card services, press 2. You selected card services. Please hold.' }
      : { transcript: 'Hello.' }),
  }).start();
  // The app under test: "Call me with a code" makes the provider phone the user's number.
  app = createServer((req, res) => {
    if (req.url === '/call-me' && req.method === 'POST') {
      mock.receive('+15559990000', '+15550123', { transcript: 'Your Acme verification code is four eight two, nine one five. Again: 4 8 2 9 1 5. Goodbye.', pollsUntilDone: 1 });
      res.writeHead(204).end();
      return;
    }
    if (req.url?.startsWith('/verify?code=')) {
      const ok = req.url.endsWith('=482915');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${ok ? 'Verified' : 'Wrong code'}</p>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>2FA</title>
<button onclick="fetch('/call-me',{method:'POST'}).then(()=>{document.getElementById('s').textContent='Calling you now'})">Call me with a code</button>
<p id="s"></p><label>Code <input id="code"></label>
<button onclick="location.href='/verify?code='+document.getElementById('code').value">Verify</button>`);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await mock.stop();
  await new Promise<void>((r) => app.close(() => r()));
});

const twilio = (extra: Partial<ConstructorParameters<typeof TwilioVoiceProvider>[0]> = {}) =>
  new TwilioVoiceProvider({ accountSid: SID, authToken: TOKEN, baseUrl: mock.url, from: '+15559990001', allowedNumbers: ['+15550100', '+1555012*'], pollMs: 100, ...extra });

const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

async function run(ez: string, voice: VoiceProvider) {
  const outputDir = await mkdtemp(join(tmpdir(), 'eztest-voice-'));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, baseUrl: appUrl, stepTimeoutMs: 15_000, conditionTimeoutMs: 3000, voice, mask: (s) => s.split(TOKEN).join('***') });
  return { j: r.journeys[0], dir: join(outputDir, r.runId) };
}

describe('voice steps against the Twilio REST stand-in', () => {
  it('places a call to an IVR, sends DTMF and checks the prompts in order', async () => {
    const { j, dir } = await run(`Journey: IVR menu
Place a call to "+15550100" and press "ww2" as ivr
Expect the call ivr to say "Thank you for calling Acme Bank" then "for billing, press 1" then "For card services press 2"
Expect the call ivr to have sent the digits "2"
Expect \${ivr.status} equals "completed"
`, twilio());
    expect(j.status, describeSteps(j)).toBe('passed');
    const post = mock.requests.find((r) => r.method === 'POST')!;
    expect(post.form).toMatchObject({ To: '+15550100', From: '+15559990001', SendDigits: 'ww2' });
    expect(post.form?.Twiml).toContain('<Record transcribe="true"');
    // The call value is evidence; the auth token never is.
    const files = await readdir(join(dir, 'calls'), { recursive: true });
    const json = await readFile(join(dir, 'calls', files.find((f) => f.endsWith('.json'))!), 'utf8');
    expect(JSON.parse(json)).toMatchObject({ direction: 'outbound', transcriptSource: 'provider', digits: 'ww2' });
    expect(json).not.toContain(TOKEN);
  });

  it('a prompt missing from the transcript fails with what was heard', async () => {
    const { j } = await run(`Journey: IVR changed
Place a call to "+15550100" as ivr
Expect the call ivr to say "Press 9 for mortgages"
`, twilio());
    expect(j.status).toBe('failed');
    expect(j.steps[1].error?.message).toMatch(/did not say "Press 9 for mortgages"; transcript \(provider\): "Thank you for calling Acme Bank/);
    const order = await run(`Journey: Wrong order
Place a call to "+15550100" as ivr
Expect the call ivr to say "For card services, press 2" then "For billing, press 1"
`, twilio());
    expect(order.j.steps[1].error?.message).toMatch(/after the previous prompt/);
  });

  it('receives the call the app makes and captures the spoken code in the browser journey', async () => {
    const { j } = await run(`Journey: Voice OTP
Open "/"
Click the "Call me with a code" button
  Expect the page contains "Calling you now"
Wait for a call to "+15550123" within 30 seconds and capture the 6-digit spoken code as otp
Type "\${otp}" into the "Code" field
Click the "Verify" button
  Expect the page contains "Verified"
Expect the call call to say "Your Acme verification code is 482915"
`, twilio());
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.otp).toBe('482915');
  });

  it('refuses to dial a number that is not allow-listed', async () => {
    const before = mock.requests.length;
    const { j } = await run(`Journey: Not allowed
Place a call to "+447700900123" as c
`, twilio());
    expect(j.status).toBe('failed');
    expect(j.steps[0].error?.message).toMatch(/not allowed: add it to voice.allowedNumbers/);
    expect(mock.requests.slice(before).some((r) => r.method === 'POST')).toBe(false);
  });

  it('uses a deterministic local transcript fixture (by recording audio SHA-256) instead of provider transcription', async () => {
    const audio = Buffer.from('RIFF....WAVEfmt fake-audio-for-fixture');
    const sha = createHash('sha256').update(audio).digest('hex');
    const local = await new TwilioMockServer({ accountSid: SID, authToken: TOKEN, answer: () => ({ transcript: 'provider text that must not be used', audio }) }).start();
    try {
      const dir = await mkdtemp(join(tmpdir(), 'eztest-voice-fx-'));
      const fx = join(dir, 'transcripts.json');
      await writeFile(fx, JSON.stringify({ bySha256: { [sha]: 'Your code is 1 2 3 4 5 6.' } }));
      const { loadTranscriptFixtures } = await import('../../src/messaging/index.js');
      const p = new TwilioVoiceProvider({ accountSid: SID, authToken: TOKEN, baseUrl: local.url, from: '+15559990001', allowedNumbers: ['+15550100'], pollMs: 100, fixtures: await loadTranscriptFixtures(fx) });
      const { j } = await run(`Journey: Fixture
Place a call to "+15550100" as c
Extract the 6-digit code from c as code
Expect \${c.transcriptSource} equals "fixture"
`, p);
      expect(j.status, describeSteps(j)).toBe('passed');
      expect(j.ledger.code).toBe('123456');
    } finally {
      await local.stop();
    }
  });

  it('rejects bad credentials with the provider message', async () => {
    const p = new TwilioVoiceProvider({ accountSid: SID, authToken: 'wrong', baseUrl: mock.url, allowedNumbers: ['+15550100'], from: '+15559990001' });
    await expect(p.placeCall({ to: '+15550100' })).rejects.toThrow(/returned 401: Authenticate/);
  });
});

describe('voice configuration and helpers', () => {
  it('builds the provider from config with secret:// credentials resolved and masked', async () => {
    const masked: string[] = [];
    const vault = { registry: { resolve: async (ref: string) => (ref === 'secret://env/TWILIO_TOKEN' ? TOKEN : SID) } };
    const out = await messagingFromConfig(
      { voice: { provider: 'twilio', accountSid: 'secret://env/TWILIO_SID', authToken: 'secret://env/TWILIO_TOKEN', baseUrl: mock.url, from: '+15559990001', allowedNumbers: ['+15550100'] } } as never,
      vault as never, { add: (v: string) => masked.push(v) },
    );
    expect(out.voice?.name).toBe('twilio');
    expect(masked).toContain(TOKEN);
    const call = await out.voice!.placeCall({ to: '+15550100' });
    expect((await out.voice!.complete(call, { pollMs: 10 })).transcript).toMatch(/Acme Bank/);
  });

  it('normalises spoken digits and keeps ordinary words', () => {
    expect(normalizeSpokenText('Your code is four eight two, nine one five.')).toBe('Your code is 482915.');
    expect(normalizeSpokenText('Press 1 for billing. Oh, and 2 for cards')).toBe('Press 1 for billing. Oh, and 2 for cards');
    expect(normalizeSpokenText('code 4 8 2 9 1 5 again')).toBe('code 482915 again');
    expect(normalizeSpokenText('six oh seven')).toBe('607');
    expect(outboundTwiml({ to: '+1', say: 'Hi <there>' })).toContain('<Say>Hi &lt;there&gt;</Say>');
  });

  it('works with the in-process provider for custom gateways', async () => {
    const mem = new MemoryVoiceProvider({ allowedNumbers: ['+1555*'] });
    mem.push({ from: '+15550001', to: '+15550002', transcript: 'Code 9 9 1 2.' });
    const { j } = await run(`Journey: Memory
Wait for a call to "+15550002" and capture the code as code
`, mem);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.code).toBe('9912');
  });
});
