/**
 * A SOAP test server for the policy service fixture. Like a strict real
 * service it checks what it receives: the SOAPAction, the schema, WS-Security
 * (UsernameToken, Timestamp, X.509 signature over Body and Timestamp by a
 * trusted client certificate), and answers with signed responses. MTOM
 * requests are reassembled before the checks.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyWsSecurity, checkUsernameToken, childElements, findElements, findOperation, firstChild, isMultipartRelated, loadWsdl, parseMtom, parseXml, textContent, validateEnvelope,
  verifyWsSecurity, type WsdlModel,
} from '../../src/surfaces/index.js';

export const FIXTURES = join(__dirname, 'fixtures', 'soap');

export interface KeyPair {
  key: string;
  cert: string;
  keyFile: string;
  certFile: string;
}

/** A self-signed RSA certificate made with openssl (as the other TLS tests do). */
export function makeCert(cn: string): KeyPair {
  const dir = mkdtempSync(join(tmpdir(), 'ezsoap-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-subj', `/CN=${cn}`], { cwd: dir, stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), keyFile: join(dir, 'key.pem'), certFile: join(dir, 'cert.pem') };
}

export interface SoapServerOptions {
  /** Require a UsernameToken with one of these passwords. */
  users?: Record<string, string>;
  /** Require a signature by this client certificate over Body and Timestamp. */
  clientCert?: string;
  /** Sign responses with this key/certificate. */
  server?: KeyPair;
  /** Tamper with the signed response after signing (for negative tests). */
  tamper?: boolean;
}

export interface SoapTestServer {
  url: string;
  requests: Array<{ action?: string; contentType?: string; xml: string; attachments: number }>;
  close(): Promise<void>;
}

const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

function fault(ns: string, code: string, reason: string): string {
  return ns === SOAP12
    ? `<env:Envelope xmlns:env="${SOAP12}"><env:Body><env:Fault><env:Code><env:Value>env:${code}</env:Value></env:Code><env:Reason><env:Text xml:lang="en">${reason}</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`
    : `<soap:Envelope xmlns:soap="${SOAP11}"><soap:Body><soap:Fault><faultcode>soap:${code}</faultcode><faultstring>${reason}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
}

export async function startSoapServer(o: SoapServerOptions = {}): Promise<SoapTestServer> {
  const model: WsdlModel = await loadWsdl(join(FIXTURES, 'policy.wsdl'));
  const requests: SoapTestServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] ?? '');
      let xml: string;
      let attachments = 0;
      if (isMultipartRelated(ct)) {
        const m = parseMtom(raw, ct);
        xml = m.envelopeXml;
        attachments = m.attachments.length;
      } else xml = raw.toString('utf8');
      const action = req.headers.soapaction ? String(req.headers.soapaction).replace(/"/g, '') : /action="([^"]*)"/.exec(ct)?.[1];
      requests.push({ action, contentType: ct, xml, attachments });
      const env = parseXml(xml).root;
      const ns = env.ns;
      const send = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': ns === SOAP12 ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8' });
        res.end(body);
      };
      try {
        if (o.users) {
          const u = checkUsernameToken(xml, o.users);
          if (!u.ok) return send(500, fault(ns, ns === SOAP12 ? 'Sender' : 'Client', `Authentication failed: ${u.error}`));
        }
        if (o.clientCert) {
          const v = verifyWsSecurity(xml, { trustedCertificates: [o.clientCert], requireSignature: true, requireTimestamp: true, requireParts: ['Body', 'Timestamp'] });
          if (!v.ok) return send(500, fault(ns, ns === SOAP12 ? 'Sender' : 'Client', `Security check failed: ${v.errors.join('; ')}`));
        }
        const body = firstChild(env, 'Body', ns)!;
        const call = childElements(body)[0];
        const op = findOperation(model, call.local, { soapVersion: ns === SOAP12 ? '1.2' : '1.1' });
        if (action !== op.soapAction) return send(500, fault(ns, ns === SOAP12 ? 'Sender' : 'Client', `Wrong SOAPAction "${action}"`));
        const check = validateEnvelope(model, op, xml, 'input');
        if (!check.valid) return send(500, fault(ns, ns === SOAP12 ? 'Sender' : 'Client', `Schema: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`));
        const val = (local: string) => textContent(findElements(call, (e) => e.local === local)[0] ?? ({ type: 'text', value: '' } as never));
        let out: string;
        if (call.local === 'GetPolicy') {
          const id = val('PolicyId');
          if (id === 'P-404') return send(500, fault(ns, ns === SOAP12 ? 'Receiver' : 'Server', `Policy ${id} not found`));
          const cov = val('IncludeCoverage') === 'true' ? '<p:Coverage code="fire">250000.00</p:Coverage><p:Coverage code="flood">50000.00</p:Coverage>' : '';
          out = `<p:GetPolicyResponse xmlns:p="urn:example:policy" xmlns:c="urn:example:common"><p:Policy version="3"><p:Id>${id}</p:Id><p:Holder><c:Name>Jane Roe</c:Name><c:Email>jane@example.com</c:Email></p:Holder><p:Status>Active</p:Status><p:StartDate>2024-03-01</p:StartDate><p:Premium>1250.00</p:Premium>${cov}</p:Policy></p:GetPolicyResponse>`;
        } else if (call.local === 'SearchPolicies') {
          const n = Number(val('MaxResults') || '2');
          out = `<p:SearchPoliciesResponse xmlns:p="urn:example:policy">${Array.from({ length: Math.min(n, 3) }, (_, i) => `<p:PolicyId>P-10${i}0</p:PolicyId>`).join('')}</p:SearchPoliciesResponse>`;
        } else {
          const data = Buffer.from(val('Content').replace(/\s+/g, ''), 'base64');
          out = `<p:UploadDocumentResponse xmlns:p="urn:example:policy"><p:Size>${data.length}</p:Size><p:Sha256>${createHash('sha256').update(data).digest('hex')}</p:Sha256></p:UploadDocumentResponse>`;
        }
        let envelope = `<s:Envelope xmlns:s="${ns}"><s:Body>${out}</s:Body></s:Envelope>`;
        if (o.server) envelope = applyWsSecurity(envelope, { timestamp: 300, signature: { privateKey: o.server.key, certificate: o.server.cert } });
        if (o.tamper) envelope = envelope.replace('1250.00', '1.00');
        send(200, envelope);
      } catch (e) {
        send(500, fault(ns, ns === SOAP12 ? 'Receiver' : 'Server', (e as Error).message.replace(/[<&]/g, ' ')));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/policy`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
