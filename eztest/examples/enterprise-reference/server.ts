/**
 * Larkspur Mutual: the enterprise reference system for EZTest.
 *
 *   node server.ts            # Node 22.18+ (type stripping); or: npx tsx server.ts
 *
 * Starts, with seeded data:
 *   - MyCover customer portal (SPA, TOTP MFA, quote, claim with upload/iframe/popup, virtualized grid)  :4700
 *   - ClaimDesk back office (adjusters approve, reject, refer)                                          :4701
 *   - API gateway: OAuth2 client credentials, REST v1, GraphQL, OpenAPI                                 :4702
 *   - Legacy SOAP 1.1 policy administration service                                                     :4703
 *   - SQLite database (var/larkspur.db), Kafka events (larkspur.claims.events), SMTP notifications,
 *     the nightly settlement batch (CSV into var/drop/outbound) and PDF statements.
 * See app/settings.ts for the REF_* environment variables (ports, REF_BUG, REF_VARIANT, ...).
 */
import type { Server } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { startApi } from './app/api.ts';
import { startBackoffice } from './app/backoffice.ts';
import { outboundDir } from './app/batch.ts';
import { openDatabase } from './app/db.ts';
import { startPortal } from './app/portal.ts';
import { Services } from './app/services.ts';
import { settings, urls } from './app/settings.ts';
import { startSoap } from './app/soap.ts';

export interface ReferenceSystem {
  services: Services;
  close(): Promise<void>;
}

export async function startReferenceSystem(log: (m: string) => void = (m) => console.log(m)): Promise<ReferenceSystem> {
  if (settings.reset) rmSync(settings.dropDir, { recursive: true, force: true });
  mkdirSync(outboundDir(), { recursive: true });
  const db = openDatabase(settings.dbFile, settings.reset);
  const services = new Services(db, log);
  const { host } = settings;
  const servers: Server[] = [
    startPortal(services, settings.portalPort, host),
    startBackoffice(services, settings.backofficePort, host),
    startApi(services, settings.apiPort, host),
    startSoap(services, settings.soapPort, host),
  ];
  await Promise.all(servers.map((s) => new Promise<void>((resolve, reject) => (s.listening ? resolve() : s.once('listening', resolve).once('error', reject)))));
  log(`Larkspur Mutual reference system (variant ${settings.variant}, bug ${settings.bug})`);
  log(`  portal      ${urls.portal()}/login`);
  log(`  back office ${urls.backoffice()}/signin`);
  log(`  API         ${urls.api()}/v1/health  (OpenAPI: ${urls.api()}/openapi.yaml, GraphQL: POST ${urls.api()}/graphql)`);
  log(`  SOAP        ${urls.soap()}/legacy/PolicyAdministration?wsdl`);
  log(`  database    ${settings.dbFile}`);
  log(`  drop folder ${outboundDir()}`);
  log(`  kafka       ${settings.kafka} (topic larkspur.claims.events)   smtp ${settings.smtp}`);
  return {
    services,
    async close() {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              s.close(() => r());
              s.closeAllConnections();
            }),
        ),
      );
      await services.close();
      db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sys = await startReferenceSystem();
  const stop = async () => {
    await sys.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
