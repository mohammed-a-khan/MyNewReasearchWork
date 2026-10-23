/**
 * The TN3270 client against a REAL mainframe: MVS 3.8j TK4- on the Hercules
 * emulator (Docker image rattydave/docker-ubuntu-hercules-mvs). Opt-in, since
 * it needs the container running and booted:
 *
 *   docker run -d --name ez-tk4 -p 13270:3270 rattydave/docker-ubuntu-hercules-mvs
 *   EZ_TK4=127.0.0.1:13270 npm test -- test/desktop/tn3270-tk4.test.ts
 *
 * The journey logs on to TSO through VTAM, walks the TSO Applications menu,
 * terminates it with X, logs off at READY and is back at the logon screen.
 * Use a fresh container (or a user without a hung session): TSO keeps a
 * dropped session waiting for reconnect.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import { flattenStepResults } from '../../src/core/index.js';
import { createDesktopIntegration } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

const target = process.env.EZ_TK4;

(target ? describe : describe.skip)('TN3270 against MVS 3.8j (TK4-) on Hercules', () => {
  it('logs on to TSO, navigates the menu, logs off', async () => {
    const [host, port] = target!.split(':');
    const user = process.env.EZ_TK4_USER ?? 'HERC01';
    const journey = parseEzScript(`Journey: TSO logon and logoff on TK4-
Connect to mainframe "tk4"
Press Clear
Wait until the screen contains "Logon ===>" within 60 seconds
Type "${user}" into the "Logon" field
Press Enter
Wait until the screen contains "ENTER CURRENT PASSWORD FOR ${user}" within 60 seconds
Type "\${password}" at row 2 column 2
Press Enter
Wait until the screen contains "Welcome to the TSO system" within 60 seconds
Press Enter
Wait until the screen contains "fortune cookie" within 60 seconds
Press Enter
Wait until the screen contains "TSO Applications" within 60 seconds
Read the "TSO User" field as tsoUser
Type "X" into the "Option" field
Press Enter
Wait until the screen contains "READY" within 60 seconds
Type "LOGOFF" at the cursor
Press Enter
Wait until the screen contains "Logon ===>" within 60 seconds
Disconnect from the mainframe
`);
    const integration = createDesktopIntegration({ mainframe: { hosts: { tk4: { host, port: Number(port), timeoutMs: 60_000, settleMs: 400 } } } });
    const run = await runJourneys([journey], {
      outputDir: await mkdtemp(join(tmpdir(), 'eztest-tk4-')), stepTimeoutMs: 70_000, conditionTimeoutMs: 10_000,
      variables: { password: process.env.EZ_TK4_PASSWORD ?? 'CUL8TR' }, stepInterceptors: [integration.interceptor],
    });
    const j = run.journeys[0];
    expect(j.status, flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status} ${s.error?.message ?? ''}`).join('\n')).toBe('passed');
    expect(j.ledger.tsoUser).toBe(user);
  }, 240_000);
});
