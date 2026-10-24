/**
 * Amazon MSK IAM authentication for Kafka (SASL mechanism AWS_MSK_IAM): the
 * client sends a JSON payload holding a SigV4-presigned "kafka-cluster:Connect"
 * request for the broker host; the broker checks the signature with IAM.
 * Signed with EZTest's own SigV4 (src/identity/aws-sigv4.ts); no AWS SDK.
 *
 * Payload fields (version 2020_10_22): version, host, user-agent, action, and
 * the lower-cased X-Amz-* query parameters of the presigned request.
 */
import { presignUrl, type AwsCredentials } from '../../identity/aws-sigv4.js';

export const MSK_IAM_MECHANISM = 'AWS_MSK_IAM';
export const MSK_IAM_ACTION = 'kafka-cluster:Connect';

export interface MskIamPayloadOptions {
  host: string;
  region: string;
  credentials: AwsCredentials;
  date?: Date;
  userAgent?: string;
  expiresSeconds?: number;
}

/** The JSON authentication payload for one broker host. */
export function mskIamPayload(o: MskIamPayloadOptions): Record<string, string> {
  const url = new URL(`https://${o.host}/`);
  url.searchParams.set('Action', MSK_IAM_ACTION);
  const { url: signed } = presignUrl({ method: 'GET', url, region: o.region, service: 'kafka-cluster', credentials: o.credentials, date: o.date, expiresSeconds: o.expiresSeconds ?? 900 });
  const out: Record<string, string> = { version: '2020_10_22', host: o.host, 'user-agent': o.userAgent ?? 'eztest', action: MSK_IAM_ACTION };
  signed.searchParams.forEach((v, k) => {
    if (k.toLowerCase().startsWith('x-amz-')) out[k.toLowerCase()] = v;
  });
  return out;
}

type SaslAuthenticate = (o: { request: { encode(): Buffer | Promise<Buffer> }; response?: { decode(b: Buffer): unknown; parse(d: unknown): unknown } }) => Promise<unknown>;

/** A kafkajs custom authentication provider (sasl.authenticationProvider) for AWS_MSK_IAM. */
export function mskIamAuthenticationProvider(o: { region: string; credentials: () => Promise<AwsCredentials> | AwsCredentials; userAgent?: string }) {
  return ({ host, saslAuthenticate }: { host: string; port: number; logger?: unknown; saslAuthenticate: SaslAuthenticate }) => ({
    authenticate: async (): Promise<void> => {
      const payload = mskIamPayload({ host, region: o.region, credentials: await o.credentials(), userAgent: o.userAgent });
      await saslAuthenticate({
        request: { encode: () => Buffer.from(JSON.stringify(payload), 'utf8') },
        response: {
          decode: (b: Buffer) => b,
          parse: (b: unknown) => {
            const text = Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '');
            try {
              return text ? JSON.parse(text) : {};
            } catch {
              return { raw: text };
            }
          },
        },
      });
    },
  });
}
