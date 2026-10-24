/**
 * The SOAP stack: WSDL 1.1/2.0 import, XSD validation, request skeletons,
 * WS-Security (UsernameToken, Timestamp, X.509 signatures; verified by the
 * test server and cross-checked with libxml2 + OpenSSL where installed), MTOM,
 * the service client against a strict SOAP test server, the step and the
 * importer.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Step } from '../../src/core/index.js';
import { importFiles } from '../../src/importers/index.js';
import { parseIntent } from '../../src/intent/index.js';
import { stepToText } from '../../src/intent/ezscript.js';
import {
  applyWsSecurity, bodySkeleton, buildMtom, canonicalize, checkUsernameToken, fillSkeleton, findElements, findOperation, loadWsdl, parseMtom, parseXml, passwordDigest,
  requestSkeleton, serializeXml, SoapServiceClient, validateEnvelope, verifyWsSecurity, XsdSchemaSet, type WsdlModel,
} from '../../src/surfaces/index.js';
import { createSoapStepHandler } from '../../src/surfaces/soap-step.js';
import { FIXTURES, makeCert, startSoapServer, type KeyPair, type SoapTestServer } from './soap-server.js';

const WSDL = join(FIXTURES, 'policy.wsdl');
const env11 = (body: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;

let model: WsdlModel;
beforeAll(async () => {
  model = await loadWsdl(WSDL);
});

describe('WSDL import', () => {
  it('WSDL 1.1: services, SOAP 1.1 and 1.2 bindings, actions, endpoints, messages and imported schemas', () => {
    expect(model.version).toBe('1.1');
    expect(model.targetNamespace).toBe('urn:example:policy');
    expect(model.services).toEqual([{ name: 'PolicyService', ports: [
      { name: 'PolicySoap11Port', binding: 'PolicySoap11', address: 'http://localhost:8080/policy', soapVersion: '1.1' },
      { name: 'PolicySoap12Port', binding: 'PolicySoap12', address: 'http://localhost:8080/policy12', soapVersion: '1.2' },
    ] }]);
    expect(model.operations.map((o) => `${o.name}@${o.soapVersion}`)).toEqual(['GetPolicy@1.1', 'SearchPolicies@1.1', 'UploadDocument@1.1', 'GetPolicy@1.2', 'SearchPolicies@1.2', 'UploadDocument@1.2']);
    const get = findOperation(model, 'GetPolicy');
    expect(get).toMatchObject({ soapAction: 'urn:example:policy/GetPolicy', style: 'document', endpoint: 'http://localhost:8080/policy', documentation: 'Read one policy by id.' });
    expect(get.input).toEqual([{ name: 'parameters', element: { ns: 'urn:example:policy', local: 'GetPolicy' } }]);
    expect(get.faults[0]).toMatchObject({ name: 'PolicyFault', parts: [{ element: { local: 'PolicyFault' } }] });
    expect(findOperation(model, 'GetPolicy', { soapVersion: '1.2' }).endpoint).toBe('http://localhost:8080/policy12');
    // The imported common.xsd is loaded (Person is used by Policy).
    expect(model.schemas.types.has('{urn:example:common}Person')).toBe(true);
    expect(() => findOperation(model, 'DeletePolicy')).toThrow(/operations: GetPolicy, SearchPolicies, UploadDocument/);
  });

  it('WSDL 2.0: interface, SOAP binding (wsoap:version, wsoap:action) and endpoint', async () => {
    const m = await loadWsdl(join(FIXTURES, 'claims20.wsdl'));
    expect(m.version).toBe('2.0');
    expect(m.operations).toHaveLength(1);
    expect(m.operations[0]).toMatchObject({ name: 'OpenClaim', soapVersion: '1.2', soapAction: 'urn:example:claims/OpenClaim', endpoint: 'http://localhost:8080/claims', input: [{ element: { ns: 'urn:example:claims', local: 'OpenClaim' } }] });
    expect(requestSkeleton(m, m.operations[0])).toContain('<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope">');
  });

  it('request skeletons: typed samples, optional elements marked, choices named', () => {
    const s = requestSkeleton(model, findOperation(model, 'SearchPolicies'));
    expect(s).toContain('<!-- choice: HolderName | Status -->');
    expect(s).toContain('<!-- optional -->');
    expect(s).toContain('<tns:MaxResults>1</tns:MaxResults>');
    // The skeleton (samples filled in) is a valid request.
    const body = bodySkeleton(model, findOperation(model, 'GetPolicy')).replace('>?<', '>P-100<');
    expect(validateEnvelope(model, findOperation(model, 'GetPolicy'), env11(body), 'input')).toEqual({ valid: true, errors: [] });
  });

  it('fills skeletons from named values, prunes unused optional elements and reports what is missing', () => {
    const op = findOperation(model, 'SearchPolicies');
    const filled = fillSkeleton(bodySkeleton(model, op, { allChoices: true }), { Status: 'Lapsed' });
    expect(filled).toBe('<tns:SearchPolicies xmlns:tns="urn:example:policy"><tns:Status>Lapsed</tns:Status></tns:SearchPolicies>');
    expect(validateEnvelope(model, op, env11(filled), 'input').valid).toBe(true);
    const get = findOperation(model, 'GetPolicy');
    expect(() => fillSkeleton(bodySkeleton(model, get, { allChoices: true }), {})).toThrow(/needs values for: GetPolicy\.PolicyId/);
    expect(() => fillSkeleton(bodySkeleton(model, get, { allChoices: true }), { PolicyNo: '1' })).toThrow(/no element "PolicyNo".*PolicyId/);
  });
});

describe('XSD validation', () => {
  it('reports every problem with its path', () => {
    const op = findOperation(model, 'GetPolicy');
    const bad = env11(`<GetPolicyResponse xmlns="urn:example:policy" xmlns:c="urn:example:common"><Policy version="0"><Id>P-1</Id><Holder><c:Name></c:Name></Holder><Status>Gone</Status><StartDate>2024-02-30</StartDate><Premium>-1.555</Premium><Coverage>10</Coverage><Extra/></Policy></GetPolicyResponse>`);
    const r = validateEnvelope(model, op, bad, 'output');
    expect(r.valid).toBe(false);
    const by = Object.fromEntries(r.errors.map((e) => [e.path.replace('/Envelope/Body/GetPolicyResponse/Policy', ''), e.message]));
    expect(by['/@version']).toMatch(/must be positive/);
    expect(by['/Id']).toMatch(/does not match the pattern P-\\d\{3,6\}/);
    expect(by['/Holder/Name']).toMatch(/shorter than 1/);
    expect(by['/Status']).toMatch(/not one of "Active", "Lapsed", "Cancelled"/);
    expect(by['/StartDate']).toMatch(/not a real date/);
    expect(by['/Premium']).toMatch(/less than the minimum 0|more than 2 fraction digits/);
    expect(by['/Coverage']).toMatch(/Missing required attribute code/);
    expect(by['/Extra']).toMatch(/Unexpected element <Extra>/);
    // Missing required content names what was expected.
    const r2 = validateEnvelope(model, op, env11('<p:GetPolicyResponse xmlns:p="urn:example:policy"><p:Policy><p:Id>P-100</p:Id></p:Policy></p:GetPolicyResponse>'), 'output');
    expect(r2.errors[0]).toMatchObject({ message: expect.stringMatching(/incomplete: missing <Holder>/) });
    // Wrong body element / namespace.
    const r3 = validateEnvelope(model, op, env11('<GetPolicy xmlns="urn:other"><PolicyId>P-100</PolicyId></GetPolicy>'), 'input');
    expect(r3.errors[0].message).toMatch(/Expected <GetPolicy> in urn:example:policy, found <GetPolicy> in urn:other/);
  });

  it('all, choice, any, lists, unions, nillable, xsi:type, complexContent extension and attribute groups', async () => {
    const set = new XsdSchemaSet();
    await set.addSchemaText(`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
      <xs:simpleType name="Codes"><xs:list itemType="xs:int"/></xs:simpleType>
      <xs:simpleType name="IntOrNone"><xs:union memberTypes="xs:int"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="none"/></xs:restriction></xs:simpleType></xs:union></xs:simpleType>
      <xs:attributeGroup name="Audit"><xs:attribute name="by" type="xs:string" use="required"/></xs:attributeGroup>
      <xs:complexType name="Base"><xs:sequence><xs:element name="A" type="xs:string"/></xs:sequence><xs:attributeGroup ref="t:Audit"/></xs:complexType>
      <xs:complexType name="Derived"><xs:complexContent><xs:extension base="t:Base"><xs:sequence><xs:element name="B" type="xs:int"/></xs:sequence></xs:extension></xs:complexContent></xs:complexType>
      <xs:element name="Root"><xs:complexType><xs:sequence>
        <xs:element name="Set"><xs:complexType><xs:all><xs:element name="X" type="xs:int"/><xs:element name="Y" type="xs:int" minOccurs="0"/></xs:all></xs:complexType></xs:element>
        <xs:element name="Codes" type="t:Codes"/>
        <xs:element name="Limit" type="t:IntOrNone"/>
        <xs:element name="Note" type="xs:string" nillable="true"/>
        <xs:element name="Item" type="t:Base" maxOccurs="3"/>
        <xs:any namespace="##other" processContents="lax" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>`);
    const ok = parseXml(`<Root xmlns="urn:t" xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Set><Y>2</Y><X>1</X></Set><Codes> 1 2  3 </Codes><Limit>none</Limit><Note xsi:nil="true"/><Item by="me"><A>a</A></Item><Item by="me" xsi:type="t:Derived"><A>a</A><B>7</B></Item><o:Ext xmlns:o="urn:o">free</o:Ext></Root>`).root;
    expect(set.validate(ok)).toEqual({ valid: true, errors: [] });
    const bad = parseXml(`<Root xmlns="urn:t" xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Set><Y>2</Y></Set><Codes>1 x</Codes><Limit>many</Limit><Note>a</Note><Item><A>a</A></Item><Item by="me" xsi:type="t:Derived"><A>a</A><B>seven</B></Item><Ext>no</Ext></Root>`).root;
    const msgs = set.validate(bad).errors.map((e) => `${e.path}: ${e.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/Root\/Set: Element Set is incomplete/),
      expect.stringMatching(/\/Root\/Codes: Value "x" is not a valid int/),
      expect.stringMatching(/\/Root\/Limit: Value "many" matches none of the union/),
      expect.stringMatching(/\/Root\/Item\[1\]: Missing required attribute by/),
      expect.stringMatching(/\/Root\/Item\[2\]\/B: Value "seven" is not a valid int/),
      expect.stringMatching(/\/Root\/Ext: Unexpected element <Ext>/),
    ]));
    expect(set.unsupported).toEqual([]);
  });

  it('names the schema features it does not enforce', async () => {
    const set = new XsdSchemaSet();
    await set.addSchemaText(`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:k"><xs:element name="R"><xs:complexType><xs:sequence><xs:element name="I" type="xs:string" maxOccurs="unbounded"/></xs:sequence></xs:complexType><xs:unique name="u"><xs:selector xpath="I"/><xs:field xpath="."/></xs:unique></xs:element></xs:schema>`);
    expect(set.unsupported).toEqual(['unique']);
  });
});

describe('WS-Security', () => {
  let client: KeyPair;
  let other: KeyPair;
  beforeAll(() => {
    client = makeCert('eztest-client');
    other = makeCert('someone-else');
  });
  const request = env11('<p:GetPolicy xmlns:p="urn:example:policy"><p:PolicyId>P-100</p:PolicyId></p:GetPolicy>');

  it('UsernameToken: password text and digest (Base64(SHA-1(nonce + created + password)))', () => {
    expect(passwordDigest(Buffer.from('nonce-bytes').toString('base64'), '2024-01-01T00:00:00Z', 'secret')).toBe(
      Buffer.from(require('node:crypto').createHash('sha1').update(Buffer.concat([Buffer.from('nonce-bytes'), Buffer.from('2024-01-01T00:00:00Z'), Buffer.from('secret')])).digest()).toString('base64'));
    const text = applyWsSecurity(request, { username: { username: 'svc', password: 'pw' } });
    expect(text).toContain('#PasswordText">pw</wsse:Password>');
    expect(text).toContain('s:mustUnderstand="1"');
    expect(checkUsernameToken(text, { svc: 'pw' })).toEqual({ ok: true, username: 'svc' });
    expect(checkUsernameToken(text, { svc: 'other' }).ok).toBe(false);
    const digest = applyWsSecurity(request, { username: { username: 'svc', password: 'pw', passwordType: 'digest' } });
    expect(digest).not.toContain('>pw<');
    expect(digest).toMatch(/<wsse:Nonce EncodingType="[^"]+#Base64Binary">[A-Za-z0-9+/=]{24}<\/wsse:Nonce><wsu:Created>/);
    expect(checkUsernameToken(digest, { svc: 'pw' })).toEqual({ ok: true, username: 'svc' });
    expect(checkUsernameToken(digest, { svc: 'pw' }, { now: () => new Date(Date.now() + 3600_000) }).error).toMatch(/stale/);
  });

  it('signs Body and Timestamp (exc-c14n, SHA-256, RSA-SHA256) and verifies them', () => {
    const signed = applyWsSecurity(request, { timestamp: 300, signature: { privateKey: client.key, certificate: client.cert } });
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"');
    expect(signed).toContain('<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>');
    const v = verifyWsSecurity(signed, { trustedCertificates: [client.cert], requireSignature: true });
    expect(v).toMatchObject({ ok: true, signed: true, signatureValid: true, trusted: true, signedParts: ['Body', 'Timestamp'], timestamp: { fresh: true } });
    expect(v.certificate!.subject).toContain('CN=eztest-client');
    // Re-serialising (e.g. after a hop through another XML stack) keeps it valid: canonical forms are stable.
    expect(verifyWsSecurity(serializeXml(parseXml(signed)), { trustedCertificates: [client.cert] }).ok).toBe(true);
  });

  it('detects tampering, untrusted signers, signature wrapping and expired timestamps', () => {
    const signed = applyWsSecurity(request, { timestamp: 300, signature: { privateKey: client.key, certificate: client.cert } });
    const changed = verifyWsSecurity(signed.replace('P-100', 'P-999'), { trustedCertificates: [client.cert] });
    expect(changed.ok).toBe(false);
    expect(changed.errors.join(' ')).toMatch(/digest mismatch/);
    const untrusted = verifyWsSecurity(signed, { trustedCertificates: [other.cert] });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.errors.join(' ')).toMatch(/not a trusted one/);
    // Wrapping: the signed Body is moved into the header and a forged Body takes its place.
    const doc = parseXml(signed);
    const body = findElements(doc.root, (e) => e.local === 'Body')[0];
    const header = findElements(doc.root, (e) => e.local === 'Header')[0];
    const forged = parseXml(env11('<p:GetPolicy xmlns:p="urn:example:policy"><p:PolicyId>P-666</p:PolicyId></p:GetPolicy>')).root.children[0] as typeof body;
    doc.root.children = doc.root.children.map((c) => (c === body ? forged : c));
    forged.parent = doc.root;
    header.children.push(body);
    body.parent = header;
    const wrapped = verifyWsSecurity(serializeXml(doc), { trustedCertificates: [client.cert] });
    expect(wrapped.ok).toBe(false);
    expect(wrapped.errors).toContain('The signature does not cover the Body');
    const later = verifyWsSecurity(signed, { trustedCertificates: [client.cert], now: () => new Date(Date.now() + 3600_000) });
    expect(later.ok).toBe(false);
    expect(later.timestamp!.fresh).toBe(false);
    expect(verifyWsSecurity(request, { requireSignature: true }).errors).toContain('The message is not signed (no ds:Signature in the Security header)');
  });

  it('is independently verifiable: libxml2 canonicalization and OpenSSL signature check (where installed)', () => {
    const signed = applyWsSecurity(request, { timestamp: 300, signature: { privateKey: client.key, certificate: client.cert } });
    const dir = mkdtempSync(join(tmpdir(), 'ezsig-'));
    writeFileSync(join(dir, 'msg.xml'), signed);
    writeFileSync(join(dir, 'cert.pem'), client.cert);
    // Python's lxml (libxml2) canonicalizes Body, Timestamp and SignedInfo; OpenSSL checks the RSA signature.
    const script = [
      'import sys, hashlib, base64', 'from lxml import etree',
      'd = etree.parse(sys.argv[1])', "ns = {'ds': 'http://www.w3.org/2000/09/xmldsig#'}",
      "out = []",
      "for ref in d.findall('.//ds:Reference', ns):",
      "    i = ref.get('URI')[1:]",
      "    el = d.xpath('//*[@*[local-name()=\"Id\"]=$i]', i=i)[0]",
      "    c = etree.tostring(el, method='c14n', exclusive=True)",
      "    out.append(base64.b64encode(hashlib.sha256(c).digest()).decode() == ref.find('ds:DigestValue', ns).text)",
      "si = d.find('.//ds:SignedInfo', ns)",
      "open(sys.argv[2], 'wb').write(etree.tostring(si, method='c14n', exclusive=True))",
      "open(sys.argv[3], 'wb').write(base64.b64decode(d.find('.//ds:SignatureValue', ns).text))",
      "print(all(out) and len(out) == 2)",
    ].join('\n');
    writeFileSync(join(dir, 'check.py'), script);
    let digestsOk: string;
    try {
      digestsOk = execFileSync('python3', ['-I', join(dir, 'check.py'), join(dir, 'msg.xml'), join(dir, 'si.bin'), join(dir, 'sig.bin')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return; // python3 with lxml not installed: the W3C c14n vectors and xmllint checks still apply
    }
    expect(digestsOk).toBe('True');
    // Our SignedInfo canonical form equals libxml2's.
    const ours = canonicalize(findElements(parseXml(signed).root, (e) => e.local === 'SignedInfo')[0]);
    expect(readFileSync(join(dir, 'si.bin'), 'utf8')).toBe(ours);
    execFileSync('openssl', ['x509', '-in', join(dir, 'cert.pem'), '-pubkey', '-noout', '-out', join(dir, 'pub.pem')]);
    const verified = execFileSync('openssl', ['dgst', '-sha256', '-verify', join(dir, 'pub.pem'), '-signature', join(dir, 'sig.bin'), join(dir, 'si.bin')], { encoding: 'utf8' });
    expect(verified.trim()).toBe('Verified OK');
  });
});

describe('MTOM / XOP', () => {
  it('moves base64 content into a binary MIME part and puts it back', () => {
    const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    const xml = env11(`<p:UploadDocument xmlns:p="urn:example:policy"><p:PolicyId>P-100</p:PolicyId><p:FileName>a.bin</p:FileName><p:Content>${data.toString('base64')}</p:Content></p:UploadDocument>`);
    const m = buildMtom(xml, { binaryElements: ['Content'], contentTypes: { Content: 'application/pdf' } });
    expect(m.contentType).toMatch(/^multipart\/related; type="application\/xop\+xml"; start="<root\.[^>]+>"; start-info="text\/xml"; boundary="MIMEBoundary_/);
    expect(m.attachments).toHaveLength(1);
    expect(Buffer.from(m.attachments[0].data).equals(data)).toBe(true);
    // The binary travels raw (not base64) in the message.
    expect(Buffer.from(m.body).includes(data)).toBe(true);
    expect(Buffer.from(m.body).toString('latin1')).toContain('<xop:Include xmlns:xop="http://www.w3.org/2004/08/xop/include" href="cid:');
    const back = parseMtom(m.body, m.contentType);
    expect(back.envelopeXml).toContain(`<p:Content>${data.toString('base64')}</p:Content>`);
    expect(back.attachments[0].contentType).toBe('application/pdf');
  });
});

describe('SOAP service client against a strict test server', () => {
  let server: SoapTestServer;
  let clientKeys: KeyPair;
  let serverKeys: KeyPair;
  let dir: string;
  beforeAll(async () => {
    clientKeys = makeCert('eztest-client');
    serverKeys = makeCert('policy-server');
    server = await startSoapServer({ users: { svc: 'pw-123' }, clientCert: clientKeys.cert, server: serverKeys });
    dir = mkdtempSync(join(tmpdir(), 'ezsoapcfg-'));
    writeFileSync(join(dir, 'client.key.pem'), clientKeys.key);
    writeFileSync(join(dir, 'client.cert.pem'), clientKeys.cert);
    writeFileSync(join(dir, 'server.cert.pem'), serverKeys.cert);
  });
  afterAll(async () => {
    await server?.close();
  });

  const svc = (extra: Record<string, unknown> = {}) => new SoapServiceClient('policy', {
    wsdl: WSDL, endpoint: server.url,
    security: { username: 'svc', password: 'pw-123', passwordType: 'digest', timestamp: 300, sign: { key: 'client.key.pem', certificate: 'client.cert.pem' }, verify: { certificates: ['server.cert.pem'], require: true } },
    ...extra,
  }, { baseDir: dir });

  it('calls an operation with named values: signed request accepted, signed response verified and validated', async () => {
    const r = await svc().call('GetPolicy', { params: { PolicyId: 'P-100', IncludeCoverage: 'true' } });
    expect(r.status).toBe(200);
    expect(r.validation.request!.valid).toBe(true);
    expect(r.validation.response!.valid).toBe(true);
    expect(r.security).toMatchObject({ ok: true, signed: true, trusted: true, signedParts: ['Body', 'Timestamp'] });
    expect((r.body.GetPolicyResponse as { Policy: { Id: string; Premium: string } }).Policy).toMatchObject({ Id: 'P-100', Premium: '1250.00' });
    const sent = server.requests[server.requests.length - 1];
    expect(sent.action).toBe('urn:example:policy/GetPolicy');
    expect(sent.xml).toContain('#PasswordDigest');
    expect(sent.xml).toContain('<ds:Signature');
  });

  it('SOAP 1.2 binding, choices and JSON-style values', async () => {
    const r = await svc({ soapVersion: '1.2' }).call('SearchPolicies', { params: { Status: 'Active', MaxResults: '2' } });
    expect(r.body.SearchPoliciesResponse).toEqual({ PolicyId: ['P-1000', 'P-1010'] });
    const sent = server.requests[server.requests.length - 1];
    expect(sent.contentType).toBe('application/soap+xml; charset=utf-8; action="urn:example:policy/SearchPolicies"');
    expect(sent.xml).toContain('http://www.w3.org/2003/05/soap-envelope');
  });

  it('faults, invalid requests, tampered responses and missing credentials fail with clear messages', async () => {
    await expect(svc().call('GetPolicy', { params: { PolicyId: 'P-404' } })).rejects.toThrow(/SOAP fault from GetPolicy: soap:Server: Policy P-404 not found/);
    const allowed = await svc().call('GetPolicy', { params: { PolicyId: 'P-404' }, allowFault: true });
    expect(allowed.fault).toMatchObject({ reason: 'Policy P-404 not found' });
    // Invalid values never leave the client.
    const before = server.requests.length;
    await expect(svc().call('GetPolicy', { params: { PolicyId: 'X1' } })).rejects.toThrow(/request does not match the schema: \/Envelope\/Body\/GetPolicy\/PolicyId: Value "X1" does not match the pattern/);
    expect(server.requests.length).toBe(before);
    // Without the signature the strict server refuses.
    const unsigned = new SoapServiceClient('policy', { wsdl: WSDL, endpoint: server.url, security: { username: 'svc', password: 'pw-123' } }, { baseDir: dir });
    await expect(unsigned.call('GetPolicy', { params: { PolicyId: 'P-100' } })).rejects.toThrow(/Security check failed: .*The message is not signed/);
    const wrongPw = new SoapServiceClient('policy', { wsdl: WSDL, endpoint: server.url, security: { username: 'svc', password: 'nope', sign: { key: 'client.key.pem', certificate: 'client.cert.pem' } } }, { baseDir: dir });
    await expect(wrongPw.call('GetPolicy', { params: { PolicyId: 'P-100' } })).rejects.toThrow(/Authentication failed: wrong password/);
    const evil = await startSoapServer({ server: serverKeys, tamper: true });
    try {
      const c = new SoapServiceClient('policy', { wsdl: WSDL, endpoint: evil.url, security: { verify: { certificates: ['server.cert.pem'] } } }, { baseDir: dir });
      await expect(c.call('GetPolicy', { params: { PolicyId: 'P-100' } })).rejects.toThrow(/response failed WS-Security checks: digest mismatch/);
    } finally {
      await evil.close();
    }
  });

  it('MTOM upload: the server receives the attachment and the exact bytes', async () => {
    const data = Buffer.from('%PDF-1.4 fake document with binary \u0000\u0001ÿ bytes', 'latin1');
    const r = await svc({ mtom: { elements: ['Content'] } }).call('UploadDocument', { params: { PolicyId: 'P-100', FileName: 'claim.pdf', Content: data.toString('base64') } });
    const sent = server.requests[server.requests.length - 1];
    expect(sent.contentType).toMatch(/^multipart\/related/);
    expect(sent.attachments).toBe(1);
    expect(r.body.UploadDocumentResponse).toEqual({ Size: String(data.length), Sha256: require('node:crypto').createHash('sha256').update(data).digest('hex') });
  });

  it('the step: parses, prints back, runs and keeps the response for assertions', async () => {
    const s = Step.parse(parseIntent('Call SOAP operation "GetPolicy" on "policy" with PolicyId = "${pid}", IncludeCoverage = true and store as policy'));
    expect(s).toMatchObject({ action: 'custom', handler: 'eztest.soap', captureAs: 'policy', args: { service: 'policy', operation: 'GetPolicy', params: { PolicyId: '${pid}', IncludeCoverage: 'true' } } });
    expect(stepToText(s)).toBe('Call SOAP operation "GetPolicy" on "policy" with PolicyId = "${pid}", IncludeCoverage = "true" and store as policy');
    expect(Step.parse(parseIntent('Call SOAP operation GetPolicy on policy with \'{"PolicyId": "P-1"}\' allowing faults')).args).toMatchObject({ json: '{"PolicyId": "P-1"}', allowFault: true });
    expect(Step.parse(parseIntent('Call SOAP operation "GetPolicy" on policy with file "req/get.xml"')).args).toMatchObject({ file: 'req/get.xml' });
    // The raw-envelope API step keeps its meaning.
    expect(Step.parse(parseIntent('Call SOAP action "GetOrder" on /soap with body "<GetOrder/>"')).action).toBe('api');
    const handler = createSoapStepHandler({ services: { policy: { wsdl: WSDL, endpoint: server.url, security: { username: 'svc', password: 'secret://env/PW', passwordType: 'text', sign: { key: 'client.key.pem', certificate: 'client.cert.pem' }, verify: { certificates: ['server.cert.pem'] } } } } }, {
      baseDir: dir, resolveSecret: async (ref) => (ref === 'secret://env/PW' ? 'pw-123' : ''), addSecret: (v) => secrets.push(v),
    });
    const secrets: string[] = [];
    const ledger = new Map<string, unknown>();
    const stored: Array<{ kind: string; path: string; text: string }> = [];
    const ctx = {
      interpolate: (t: string) => t.replace('${pid}', 'P-200'), journey: { id: 'J' }, ledger: { get: (k: string) => ledger.get(k), set: (k: string, v: unknown) => ledger.set(k, v) },
      evidence: { store: async (kind: string, path: string, data: string) => { stored.push({ kind, path, text: data }); return { id: 'E-1' }; } },
      session: { mask: (t: string) => t.split('pw-123').join('***') },
    } as never;
    const out = await handler(undefined, s, ctx);
    expect(secrets).toEqual(['pw-123']);
    const v = out.policy as { status: number; body: { GetPolicyResponse: { Policy: { Id: string } } }; security: { ok: boolean }; valid: { request: boolean; response: boolean } };
    expect(v.status).toBe(200);
    expect(v.body.GetPolicyResponse.Policy.Id).toBe('P-200');
    expect(v.valid).toEqual({ request: true, response: true });
    expect(v.security.ok).toBe(true);
    expect(stored[0].kind).toBe('network');
    expect(stored[0].path).toMatch(/^soap\/J\/.+\.json$/);
    expect(stored[0].text).not.toContain('pw-123');
    expect(stored[0].text).toContain('***');
  });
});

describe('eztest import wsdl', () => {
  it('writes one journey per service with request skeletons and the config to paste', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ezwsdl-'));
    writeFileSync(join(cwd, 'policy.wsdl'), readFileSync(WSDL));
    writeFileSync(join(cwd, 'common.xsd'), readFileSync(join(FIXTURES, 'common.xsd')));
    const r = await importFiles([join(cwd, 'policy.wsdl')], { cwd, outDir: 'journeys/imported' });
    expect(r.journeys).toHaveLength(1);
    const lines = r.journeys[0].steps.map((s) => s.intent);
    expect(lines).toEqual([
      'Call SOAP operation "GetPolicy" on "policy" with file "journeys/imported/soap/policy/GetPolicy.xml" and store as getPolicy',
      'Call SOAP operation "SearchPolicies" on "policy" with file "journeys/imported/soap/policy/SearchPolicies.xml" and store as searchPolicies',
      'Call SOAP operation "UploadDocument" on "policy" with file "journeys/imported/soap/policy/UploadDocument.xml" and store as uploadDocument',
    ]);
    expect(r.assets!.map((a) => a.path)).toEqual(['soap/policy/GetPolicy.xml', 'soap/policy/SearchPolicies.xml', 'soap/policy/UploadDocument.xml']);
    expect(r.assets![0].content).toContain('<!-- Read one policy by id. -->');
    expect(r.markdown!.join('\n')).toContain('soap:\n  services:\n    policy:\n      wsdl: policy.wsdl\n      endpoint: http://localhost:8080/policy');
  });
});
