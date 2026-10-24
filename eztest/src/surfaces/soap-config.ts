/**
 * Configuration of SOAP services (eztest.config `soap:`):
 *
 *   soap:
 *     services:
 *       policy:
 *         wsdl: wsdl/policy.wsdl
 *         endpoint: https://policy.test.example.com/ws
 *         soapVersion: "1.1"
 *         validate: both
 *         security:
 *           username: svc-test
 *           password: secret://env/POLICY_PW
 *           passwordType: digest
 *           timestamp: 300
 *           sign: { key: keys/client.key.pem, certificate: keys/client.cert.pem }
 *           verify: { certificates: [keys/policy-server.cert.pem], require: true }
 *         mtom: { elements: [Content] }
 */
import { z } from 'zod';

export const SoapServiceSchema = z.object({
  wsdl: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  service: z.string().optional(),
  port: z.string().optional(),
  soapVersion: z.enum(['1.1', '1.2']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  validate: z.enum(['both', 'request', 'response', 'off']).optional(),
  security: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    passwordType: z.enum(['text', 'digest']).optional(),
    timestamp: z.union([z.boolean(), z.number().int().positive()]).optional(),
    sign: z.object({ key: z.string().min(1), certificate: z.string().min(1), parts: z.array(z.enum(['Body', 'Timestamp', 'UsernameToken'])).optional() }).optional(),
    verify: z.object({ certificates: z.array(z.string().min(1)).optional(), require: z.boolean().optional() }).optional(),
  }).optional(),
  mtom: z.object({ elements: z.array(z.string().min(1)).min(1) }).optional(),
});

export const SoapConfigSchema = z.object({
  services: z.record(z.string().regex(/^[A-Za-z_][\w.-]*$/), SoapServiceSchema).default({}),
});
export type SoapConfig = z.infer<typeof SoapConfigSchema>;
