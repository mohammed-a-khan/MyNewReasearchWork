/**
 * Kafka security.
 *
 * Live, against a security-enabled broker (test/integration/kafka-secure.ts):
 * mutual TLS with a private CA and a client certificate; SASL PLAIN and
 * SCRAM-SHA-256 over TLS; SASL OAUTHBEARER with tokens EZTest gets by client
 * credentials from a local OAuth server (the broker checks their signature
 * against a JWKS and their audience). Each also fails as it should (no
 * client certificate, wrong password, a token for another audience).
 *
 * Local: Amazon MSK IAM (AWS_MSK_IAM) - the payload's SigV4 signature is
 * recomputed independently here; no MSK cluster is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { KafkaBusDriver, kafkajsSasl } from '../../src/integration/bus/kafka.js';
import { mskIamAuthenticationProvider, mskIamPayload } from '../../src/integration/bus/msk-iam.js';
import { kafkaOptions } from '../../src/integration/runtime.js';
import { BrokerSchema } from '../../src/integration/config.js';
import { OAuth2TokenProvider } from '../../src/identity/oauth.js';
import { startMockOidc, type MockOidc } from '../server/mock-oidc.js';
import { clientAvailable } from './brokers.js';
import { secureKafkaBroker, type SecureKafka } from './kafka-secure.js';

const hasKafkajs = await clientAvailable('kafkajs');

/** A TLS handshake with the client certificate succeeds (the broker is up). */
function tlsProbe(k: SecureKafka): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: '127.0.0.1', port: 19093, ca: k.ca, cert: k.clientCert, key: k.clientKey, servername: 'localhost' }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(3000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const secure = hasKafkajs ? await secureKafkaBroker(async (k) => {
  if (!(await tlsProbe(k))) return false;
  const d = new KafkaBusDriver('probe', { brokers: [k.ssl], ssl: { ca: k.ca, cert: k.clientCert, key: k.clientKey }, connectionTimeoutMs: 3000 });
  try {
    await d.publish({ type: 'topic', name: '__probe' }, { payload: 'x' }).catch((e: Error) => {
      if (!/does not exist/.test(e.message)) throw e;
    });
    return true;
  } finally {
    await d.close();
  }
}) : undefined;
if (!secure) console.warn('[eztest] Kafka security suite skipped: needs Docker with the apache/kafka:3.9.1 image (and kafkajs)');

describe('Amazon MSK IAM (AWS_MSK_IAM) payload', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-token-example' };
  const date = new Date('2026-03-01T12:00:00Z');

  /** Recompute the presigned request's signature the way the broker's IAM check does (independent of src/). */
  function expectedSignature(p: Record<string, string>): string {
    const q: Array<[string, string]> = [['Action', p.action], ['X-Amz-Algorithm', p['x-amz-algorithm']], ['X-Amz-Credential', p['x-amz-credential']], ['X-Amz-Date', p['x-amz-date']], ['X-Amz-Expires', p['x-amz-expires']], ['X-Amz-Security-Token', p['x-amz-security-token']], ['X-Amz-SignedHeaders', p['x-amz-signedheaders']]];
    const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const query = q.map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const canonical = ['GET', '/', query, `host:${p.host}\n`, 'host', createHash('sha256').update('').digest('hex')].join('\n');
    const [, day, region, service] = p['x-amz-credential'].split('/');
    const sts = ['AWS4-HMAC-SHA256', p['x-amz-date'], `${day}/${region}/${service}/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
    let key: Buffer = createHmac('sha256', `AWS4${credentials.secretAccessKey}`).update(day).digest();
    for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
    return createHmac('sha256', key).update(sts).digest('hex');
  }

  it('holds a SigV4-presigned kafka-cluster:Connect for the broker host', () => {
    const p = mskIamPayload({ host: 'b-1.demo.abc123.c2.kafka.eu-west-1.amazonaws.com', region: 'eu-west-1', credentials, date });
    expect(p).toMatchObject({
      version: '2020_10_22', host: 'b-1.demo.abc123.c2.kafka.eu-west-1.amazonaws.com', action: 'kafka-cluster:Connect', 'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': 'AKIDEXAMPLE/20260301/eu-west-1/kafka-cluster/aws4_request', 'x-amz-date': '20260301T120000Z', 'x-amz-expires': '900',
      'x-amz-security-token': 'session-token-example', 'x-amz-signedheaders': 'host',
    });
    expect(p['x-amz-signature']).toBe(expectedSignature(p));
    expect(p['x-amz-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is what the kafkajs authentication provider sends, and the broker\'s JSON answer is parsed', async () => {
    const sent: Buffer[] = [];
    const parsed: unknown[] = [];
    const provider = mskIamAuthenticationProvider({ region: 'us-east-1', credentials: async () => credentials });
    await provider({
      host: 'b-2.x.kafka.us-east-1.amazonaws.com', port: 9098,
      saslAuthenticate: async ({ request, response }) => {
        sent.push(Buffer.from(await request.encode()));
        parsed.push(response!.parse(response!.decode(Buffer.from('{"version":"2020_10_22","request-id":"r-1"}'))));
      },
    }).authenticate();
    const p = JSON.parse(sent[0].toString('utf8')) as Record<string, string>;
    expect(p.host).toBe('b-2.x.kafka.us-east-1.amazonaws.com');
    expect(p['x-amz-signature']).toBe(expectedSignature(p));
    expect(parsed).toEqual([{ version: '2020_10_22', 'request-id': 'r-1' }]);
    // kafkajs gets a custom mechanism with this provider
    expect(kafkajsSasl({ mechanism: 'aws-msk-iam', region: 'us-east-1', credentials: () => credentials })).toMatchObject({ mechanism: 'AWS_MSK_IAM', authenticationProvider: expect.any(Function) });
  });

  it('broker config: mechanism aws-msk-iam with secret:// credentials, or the AWS_* environment', () => {
    const c = BrokerSchema.parse({ type: 'kafka', brokers: ['b-1:9098'], ssl: true, sasl: { mechanism: 'aws-msk-iam', region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: 'shh' } });
    const o = kafkaOptions(c as never, process.cwd());
    expect(o.ssl).toBe(true);
    expect(o.sasl).toMatchObject({ mechanism: 'aws-msk-iam', region: 'eu-west-1' });
  });
});

describe.skipIf(!secure)('Kafka security (live broker: mTLS, SASL over TLS, OAUTHBEARER)', () => {
  let idp: MockOidc;
  const topic = `sec-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    idp = await startMockOidc({ sub: 'unused' }, { signingKey: { privateKey: secure!.jwtKey, kid: secure!.jwtKid }, audience: 'eztest-kafka' });
    idp.registerClient('orders-service', { secret: 'orders-secret' });
  });
  afterAll(async () => {
    await idp?.close();
  });

  /** Publish and read back one message through a driver. */
  async function roundTrip(d: KafkaBusDriver): Promise<string> {
    const sub = await d.subscribe({ type: 'topic', name: topic }, { fromTimestamp: Date.now() - 1000 });
    const body = `hello-${randomUUID().slice(0, 6)}`;
    await d.publish({ type: 'topic', name: topic }, { payload: body });
    const m = await sub.next((x) => x.payload === body, 20_000);
    await sub.close();
    return m?.payload ?? '(none)';
  }

  it('mTLS: a client certificate from config (files relative to the project) is presented; without one the broker refuses', async () => {
    const cfg = BrokerSchema.parse({ type: 'kafka', brokers: [secure!.ssl], createTopics: true, ssl: { ca: `${secure!.dir}/ca.pem`, cert: `${secure!.dir}/client.pem`, key: `${secure!.dir}/client-key.pem` } });
    const d = new KafkaBusDriver('mtls', kafkaOptions(cfg as never, '/'));
    try {
      expect(await roundTrip(d)).toMatch(/^hello-/);
    } finally {
      await d.close();
    }
    const noCert = new KafkaBusDriver('nocert', { brokers: [secure!.ssl], ssl: { ca: secure!.ca }, connectionTimeoutMs: 3000 });
    try {
      await expect(noCert.publish({ type: 'topic', name: topic }, { payload: 'x' })).rejects.toThrow();
    } finally {
      await noCert.close();
    }
    // An unknown CA is not trusted (verification is never switched off).
    const otherCa = new KafkaBusDriver('noca', { brokers: [secure!.ssl], ssl: { cert: secure!.clientCert, key: secure!.clientKey }, connectionTimeoutMs: 3000 });
    try {
      await expect(otherCa.publish({ type: 'topic', name: topic }, { payload: 'x' })).rejects.toMatchObject({ code: 'BUS_TLS', message: expect.stringMatching(/self[- ]signed|certificate|unable to verify/i) });
    } finally {
      await otherCa.close();
    }
  }, 90_000);

  it('SASL PLAIN and SCRAM-SHA-256 over TLS; a wrong password is an authentication error', async () => {
    for (const sasl of [{ mechanism: 'plain', username: 'alice', password: 'alice-secret' }, { mechanism: 'scram-sha-256', username: 'bob', password: 'bob-secret' }] as const) {
      const d = new KafkaBusDriver(sasl.mechanism, { brokers: [secure!.saslSsl], ssl: { ca: secure!.ca }, sasl, createTopics: true });
      try {
        expect(await roundTrip(d), sasl.mechanism).toMatch(/^hello-/);
      } finally {
        await d.close();
      }
    }
    const bad = new KafkaBusDriver('bad', { brokers: [secure!.saslSsl], ssl: { ca: secure!.ca }, sasl: { mechanism: 'scram-sha-256', username: 'bob', password: 'nope' }, connectionTimeoutMs: 3000 });
    try {
      await expect(bad.publish({ type: 'topic', name: topic }, { payload: 'x' })).rejects.toMatchObject({ code: 'BUS_AUTH', message: expect.stringMatching(/refused the SCRAM-SHA-256 credentials: SASL SCRAM SHA256 authentication failed/) });
    } finally {
      await bad.close();
    }
  }, 120_000);

  it('SASL OAUTHBEARER: client-credentials tokens from EZTest\'s OAuth client, checked by the broker (signature, audience)', async () => {
    const cfg = BrokerSchema.parse({ type: 'kafka', brokers: [secure!.saslSsl], createTopics: true, ssl: { ca: `${secure!.dir}/ca.pem` }, sasl: { mechanism: 'oauthbearer', tokenUrl: `${idp.issuer}/token`, clientId: 'orders-service', clientSecret: 'orders-secret', scope: 'kafka' } });
    const before = idp.tokenRequests.length;
    const d = new KafkaBusDriver('oauth', kafkaOptions(cfg as never, '/'));
    try {
      expect(await roundTrip(d)).toMatch(/^hello-/);
    } finally {
      await d.close();
    }
    const reqs = idp.tokenRequests.slice(before);
    expect(reqs[0]).toMatchObject({ grant_type: 'client_credentials', client_id: 'orders-service', scope: 'kafka' });
    // Tokens are cached: several broker connections, one token request.
    expect(reqs.length).toBe(1);
    // A token for another audience is refused by the broker.
    const wrong = await startMockOidc({ sub: 'x' }, { signingKey: { privateKey: secure!.jwtKey, kid: secure!.jwtKid }, audience: 'someone-else' });
    wrong.registerClient('orders-service', { secret: 'orders-secret' });
    const bad = new KafkaBusDriver('oauth-bad', { brokers: [secure!.saslSsl], ssl: { ca: secure!.ca }, connectionTimeoutMs: 3000, sasl: { mechanism: 'oauthbearer', tokenProvider: new OAuth2TokenProvider({ tokenUrl: `${wrong.issuer}/token`, clientId: 'orders-service', clientSecret: 'orders-secret' }) } });
    try {
      await expect(bad.publish({ type: 'topic', name: topic }, { payload: 'x' })).rejects.toMatchObject({ code: 'BUS_AUTH', message: expect.stringMatching(/closed the connection during SASL OAUTHBEARER authentication: the token was most likely rejected/) });
    } finally {
      await bad.close();
      await wrong.close();
    }
  }, 120_000);
});
