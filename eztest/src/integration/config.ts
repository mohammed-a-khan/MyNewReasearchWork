/**
 * Configuration for integration steps. Passwords, tokens and keys may be
 * secret references (secret://store/key or ENC(...)); the engine resolves
 * them through the Identity Vault and adds the values to the masker.
 *
 *   messaging:
 *     lookbackMs: 60000
 *     brokers:
 *       bus:    { type: kafka, brokers: [localhost:9092] }
 *       rabbit: { type: amqp, url: "amqp://guest:${RABBIT_PW}@localhost:5672" }
 *       iot:    { type: mqtt, url: mqtt://localhost:1883 }
 *       qm1:    { type: ibmmq, url: https://mq:9443, queueManager: QM1, username: app, password: secret://env/MQ_PW }
 *   grpc:
 *     services:
 *       orders: { address: localhost:50051, proto: protos/orders.proto }
 *   files:
 *     sftp:
 *       partner: { host: sftp.example.com, username: ez, password: secret://env/SFTP_PW }
 *     ssh:
 *       batch-host: { host: batch.example.com, username: ops, privateKey: keys/ops, allowCommands: ["./close-day.sh *"] }
 *   batch:
 *     jobs:
 *       close-day: { ssh: batch-host, command: "./close-day.sh ${date}", successExitCode: 0 }
 */
import { z } from 'zod';

const secret = z.string().min(1);

export const BrokerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kafka'),
    brokers: z.array(z.string().min(1)).min(1),
    clientId: z.string().optional(),
    ssl: z.boolean().optional(),
    sasl: z.object({ mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']), username: z.string().min(1), password: secret }).optional(),
    groupPrefix: z.string().optional(),
    /** Create missing topics (default false: publishing to or waiting on a missing topic is an error). */
    createTopics: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('amqp'), url: z.string().min(1), exchangeType: z.enum(['topic', 'direct', 'fanout', 'headers']).optional(),
    /** Declare missing queues (durable) before using them (default false: a missing queue is an error). */
    declare: z.boolean().optional(),
    /** Older name of `declare`. */
    assertQueues: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('mqtt'), url: z.string().min(1), username: z.string().optional(), password: secret.optional(), clientId: z.string().optional(),
    protocolVersion: z.union([z.literal(4), z.literal(5)]).optional(), qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({
    type: z.literal('ibmmq'), url: z.string().url(), queueManager: z.string().min(1), username: z.string().optional(), password: secret.optional(),
    ca: z.string().optional(), insecure: z.boolean().optional(), waitMs: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('memory') }),
]);
export type BrokerConfig = z.infer<typeof BrokerSchema>;

export const MessagingSchema = z.object({
  /** Waits without a listener look this far back (Kafka seeks by time). Default 60 s. */
  lookbackMs: z.number().int().min(0).default(60_000),
  /** Default wait for "Wait for a message" without "within". */
  timeoutMs: z.number().int().positive().default(30_000),
  brokers: z.record(z.string().regex(/^[A-Za-z_][\w.-]*$/), BrokerSchema).default({}),
});
export type MessagingConfig = z.infer<typeof MessagingSchema>;

export const GrpcServiceSchema = z.object({
  /** host:port */
  address: z.string().min(1),
  /** .proto files (relative to the project). */
  proto: z.union([z.string().min(1), z.array(z.string().min(1))]),
  /** Import paths for the proto files. */
  includeDirs: z.array(z.string()).default([]),
  tls: z.boolean().default(false),
  /** PEM CA for TLS. */
  ca: z.string().optional(),
  /** Metadata sent with every call (values may be secret references). */
  metadata: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});
export const GrpcSchema = z.object({ services: z.record(z.string(), GrpcServiceSchema).default({}) });
export type GrpcConfig = z.infer<typeof GrpcSchema>;

export const SftpServerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
  username: z.string().min(1),
  password: secret.optional(),
  /** Private key file (relative to the project). */
  privateKey: z.string().optional(),
  passphrase: secret.optional(),
  /** Expected host key SHA-256 fingerprint (base64, as `ssh-keygen -lf` prints after "SHA256:"); checked instead of known_hosts. */
  hostKeySha256: z.string().optional(),
  /** known_hosts file host keys are checked against (relative to the project). Default .eztest/known_hosts. */
  knownHosts: z.string().optional(),
  /** Accept and record the key of a host known_hosts does not list yet. Default false: an unknown host is refused. */
  trustOnFirstUse: z.boolean().optional(),
  /** Base directory remote paths are relative to. */
  root: z.string().optional(),
});
export const SshHostSchema = SftpServerSchema.extend({
  /** Commands allowed on this host: exact text or glob patterns ("./close-day.sh *"). Nothing else runs. */
  allowCommands: z.array(z.string().min(1)).default([]),
});
export const FilesSchema = z.object({
  sftp: z.record(z.string(), SftpServerSchema).default({}),
  ssh: z.record(z.string(), SshHostSchema).default({}),
  /** Local folders file-drop steps may read and write (relative to the project); default: the project directory only. */
  allowFolders: z.array(z.string()).default([]),
  pollMs: z.number().int().positive().default(1000),
});
export type FilesConfig = z.infer<typeof FilesSchema>;

export const BatchJobSchema = z.union([
  z.object({
    /** Run over SSH on this host (files.ssh); the command must be allow-listed there. */
    ssh: z.string().min(1),
    command: z.string().min(1),
    successExitCode: z.number().int().default(0),
    /**
     * Optional completion check: after the command succeeds, wait (within the step's time) for a
     * new file matching `pattern` (glob, ${var}s allowed) in `dir` on the files.sftp server `sftp`.
     */
    doneFile: z.object({ sftp: z.string(), dir: z.string(), pattern: z.string() }).optional(),
  }),
  z.object({
    /** Start the job with an HTTP call ("POST /jobs/close-day") and poll a status URL. */
    start: z.string().min(1),
    body: z.unknown().optional(),
    /** JSONPath of the job id in the start response (used as ${jobId} in statusUrl). */
    idPath: z.string().default('$.id'),
    statusUrl: z.string().min(1),
    statusPath: z.string().default('$.status'),
    success: z.array(z.string()).default(['SUCCEEDED', 'COMPLETED', 'DONE', 'SUCCESS']),
    failure: z.array(z.string()).default(['FAILED', 'ERROR', 'CANCELLED', 'ABORTED']),
    pollMs: z.number().int().positive().default(2000),
    /** Identity Vault role for the calls. */
    asRole: z.string().optional(),
  }),
]);
export const BatchSchema = z.object({ jobs: z.record(z.string(), BatchJobSchema).default({}) });
export type BatchConfig = z.infer<typeof BatchSchema>;
