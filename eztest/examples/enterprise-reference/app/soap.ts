/**
 * The legacy policy administration system, still SOAP 1.1 only
 * (urn:larkspur:policyadmin:v1). Operations: GetPolicyDetails,
 * GetClaimsSummary. Unknown policies are soap:Client faults.
 */
import { createServer, type Server } from 'node:http';
import type { Row } from './db.ts';
import { esc, readBody, send } from './http.ts';
import type { Services } from './services.ts';
import { urls } from './settings.ts';

const NS = 'urn:larkspur:policyadmin:v1';
const envelope = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:pa="${NS}"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const fault = (code: 'soap:Client' | 'soap:Server', reason: string, detail: string) =>
  envelope(`<soap:Fault><faultcode>${code}</faultcode><faultstring>${esc(reason)}</faultstring><detail><pa:ErrorCode>${esc(detail)}</pa:ErrorCode></detail></soap:Fault>`);
const tag = (xml: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${name}>\\s*([^<]*?)\\s*</(?:[\\w-]+:)?${name}>`).exec(xml)?.[1];

const wsdl = () => `<?xml version="1.0" encoding="utf-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="${NS}" targetNamespace="${NS}" name="PolicyAdministration">
  <message name="GetPolicyDetailsRequest"><part name="PolicyNumber" type="xsd:string"/></message>
  <message name="GetPolicyDetailsResponse"><part name="Policy" type="tns:Policy"/></message>
  <message name="GetClaimsSummaryRequest"><part name="CustomerId" type="xsd:string"/></message>
  <message name="GetClaimsSummaryResponse"><part name="Summary" type="tns:ClaimsSummary"/></message>
  <portType name="PolicyAdministrationPort">
    <operation name="GetPolicyDetails"><input message="tns:GetPolicyDetailsRequest"/><output message="tns:GetPolicyDetailsResponse"/></operation>
    <operation name="GetClaimsSummary"><input message="tns:GetClaimsSummaryRequest"/><output message="tns:GetClaimsSummaryResponse"/></operation>
  </portType>
  <binding name="PolicyAdministrationBinding" type="tns:PolicyAdministrationPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetPolicyDetails"><soap:operation soapAction="${NS}#GetPolicyDetails"/></operation>
    <operation name="GetClaimsSummary"><soap:operation soapAction="${NS}#GetClaimsSummary"/></operation>
  </binding>
  <service name="PolicyAdministrationService"><port name="PolicyAdministrationPort" binding="tns:PolicyAdministrationBinding"><soap:address location="${urls.soap()}/legacy/PolicyAdministration"/></port></service>
</definitions>`;

export function startSoap(svc: Services, port: number, host: string): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/legacy/PolicyAdministration') return send(res, 404, 'not found', 'text/plain');
    if (req.method === 'GET' && url.searchParams.has('wsdl')) return send(res, 200, wsdl(), 'text/xml; charset=utf-8');
    if (req.method !== 'POST') return send(res, 405, 'POST a SOAP 1.1 envelope', 'text/plain');
    const xml = (await readBody(req)).toString('utf8');
    const reply = (status: number, body: string) => send(res, status, body, 'text/xml; charset=utf-8');
    if (!/schemas\.xmlsoap\.org\/soap\/envelope/.test(xml)) return reply(500, fault('soap:Client', 'Only SOAP 1.1 envelopes are supported', 'VERSION_MISMATCH'));
    const action = String(req.headers.soapaction ?? '').replace(/"/g, '');
    const op = /<(?:[\w-]+:)?Body>\s*<(?:[\w-]+:)?(\w+)/.exec(xml)?.[1] ?? '';
    if (action && !action.endsWith(op)) return reply(500, fault('soap:Client', `SOAPAction "${action}" does not match the body element ${op}`, 'ACTION_MISMATCH'));
    if (op === 'GetPolicyDetails') {
      const no = tag(xml, 'PolicyNumber');
      const p = no ? svc.policy(no) : undefined;
      if (!p) return reply(500, fault('soap:Client', `Policy ${no ?? '(none)'} does not exist`, 'POLICY_NOT_FOUND'));
      const c = svc.customer(String(p.customer_id))!;
      return reply(
        200,
        envelope(
          `<pa:GetPolicyDetailsResponse><pa:Policy><pa:PolicyNumber>${esc(p.id)}</pa:PolicyNumber><pa:Product>${esc(p.product)}</pa:Product><pa:Status>${esc(p.status)}</pa:Status>` +
            `<pa:SumInsured>${Number(p.sum_insured).toFixed(2)}</pa:SumInsured><pa:Excess>${Number(p.deductible).toFixed(2)}</pa:Excess><pa:AnnualPremium>${Number(p.annual_premium).toFixed(2)}</pa:AnnualPremium>` +
            `<pa:Holder><pa:CustomerId>${esc(c.id)}</pa:CustomerId><pa:Name>${esc(c.full_name)}</pa:Name><pa:Region>${esc(c.region)}</pa:Region></pa:Holder>` +
            `<pa:Period><pa:Start>${esc(p.start_date)}</pa:Start><pa:End>${esc(p.end_date)}</pa:End></pa:Period></pa:Policy></pa:GetPolicyDetailsResponse>`,
        ),
      );
    }
    if (op === 'GetClaimsSummary') {
      const id = tag(xml, 'CustomerId');
      if (!id || !svc.customer(id)) return reply(500, fault('soap:Client', `Customer ${id ?? '(none)'} does not exist`, 'CUSTOMER_NOT_FOUND'));
      const rows = svc.db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(payout_amount), 0) AS paid FROM claims WHERE customer_id = ? GROUP BY status ORDER BY status').all(id) as Row[];
      const total = rows.reduce((s, r) => s + Number(r.n), 0);
      const settled = rows.find((r) => r.status === 'SETTLED');
      return reply(
        200,
        envelope(
          `<pa:GetClaimsSummaryResponse><pa:Summary><pa:CustomerId>${esc(id)}</pa:CustomerId><pa:TotalClaims>${total}</pa:TotalClaims>` +
            `<pa:SettledAmount>${Number(settled?.paid ?? 0).toFixed(2)}</pa:SettledAmount>` +
            rows.map((r) => `<pa:ByStatus><pa:Status>${esc(r.status)}</pa:Status><pa:Count>${r.n}</pa:Count></pa:ByStatus>`).join('') +
            `</pa:Summary></pa:GetClaimsSummaryResponse>`,
        ),
      );
    }
    return reply(500, fault('soap:Client', `Unknown operation ${op || '(empty body)'}`, 'UNKNOWN_OPERATION'));
  });
  server.listen(port, host);
  return server;
}
