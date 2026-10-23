/** Shared helpers for runner and heal integration tests (real Chromium + demo app). */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRef, RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import type { DbHandler } from '../../src/runner/index.js';
import type { DemoServer } from '../../examples/demo-app/server.js';

export const BOB_ORDER_EZ = `
Journey: Bob creates an order
Id: bob-order
Tags: @smoke @orders
Role: manager
Requirements: R-ORD-1

# sign in
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"

# create the order
Go to /orders/new
Select "Gadget (49.50)" from the Product dropdown
Type "2" into the Quantity field
Click the "Submit order" button
  Expect page contains "created"
Capture the text of testid=order-number as orderNumber
  Verify page contains "\${orderNumber} created"
Download the "Download invoice" link as invoice
  Expect download invoice exists
`;

export const bobOrderJourney = () => parseEzScript(BOB_ORDER_EZ);

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eztest-${prefix}-`));
}

export async function manifest(runDir: string): Promise<EvidenceRef[]> {
  const text = await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvidenceRef);
}

export function runDirOf(outputDir: string, run: RunResult): string {
  return join(outputDir, run.runId);
}

/** A DbHandler over the demo app's node:sqlite database (connection name "demo"). */
export function demoDb(server: DemoServer): DbHandler {
  return {
    async query(connection, sql, params) {
      if (connection !== 'demo') throw new Error(`unknown connection ${connection}`);
      const args = (params ?? []).map((v) => (typeof v === 'boolean' ? Number(v) : v));
      return server.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    },
  };
}

export const FAST = { stepTimeoutMs: 5000, locateTimeoutMs: 1500, conditionTimeoutMs: 3000 } as const;
