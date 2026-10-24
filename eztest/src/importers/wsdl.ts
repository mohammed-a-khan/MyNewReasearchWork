/**
 * WSDL (1.1 or 2.0) -> .ez journeys: one journey per WSDL service, one
 * "Call SOAP operation" step per operation (the preferred SOAP version's
 * binding), each with a request body skeleton written next to the journeys
 * (required elements with typed sample values, optional ones marked). The
 * report carries the `soap.services` configuration block to paste.
 */
import { basename, extname, join, relative } from 'node:path';
import { quoteText } from '../intent/quotes.js';
import { bodySkeleton, loadWsdl, type WsdlModel, type WsdlOperation } from '../surfaces/wsdl.js';
import { JourneyDraft } from './builder.js';
import { assembleReport } from './report.js';
import type { ImporterOptions, ImportReport } from './types.js';

export interface WsdlImportOptions extends ImporterOptions {
  /** Absolute path of the WSDL. */
  absPath: string;
  /** Project directory (paths written into the config snippet and steps are relative to it). */
  cwd: string;
  /** Output directory, relative to cwd (request skeletons go to <outDir>/soap/<service>/). */
  outDir?: string;
  /** Prefer this SOAP version when the WSDL binds both. Default 1.1. */
  soapVersion?: '1.1' | '1.2';
}

function serviceKey(model: WsdlModel, file: string): string {
  const base = (model.name ?? basename(file, extname(file))).replace(/Service$/i, '') || 'service';
  return base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z_]+/, '').toLowerCase() || 'service';
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1).replace(/[^A-Za-z0-9_]/g, '_');
}

/** Import one WSDL file. */
export async function importWsdl(o: WsdlImportOptions): Promise<ImportReport> {
  const file = o.file ?? basename(o.absPath);
  const model = await loadWsdl(o.absPath);
  const ids = o.ids ?? new Set<string>();
  const key = serviceKey(model, file);
  const prefer = o.soapVersion ?? '1.1';
  const wsdlRel = relative(o.cwd, o.absPath).split('\\').join('/') || file;
  const outDir = (o.outDir ?? 'journeys/imported').split('\\').join('/');
  const assets: Array<{ path: string; content: string }> = [];
  const drafts: JourneyDraft[] = [];
  const warnings = model.warnings.map((w) => `${file}: ${w}`);
  for (const svc of model.services) {
    const ops = new Map<string, WsdlOperation>();
    for (const op of model.operations.filter((x) => x.service === svc.name)) {
      const have = ops.get(op.name);
      if (!have || (have.soapVersion !== prefer && op.soapVersion === prefer)) ops.set(op.name, op);
    }
    if (!ops.size) continue;
    const d = new JourneyDraft(`${svc.name}: SOAP operations`, {
      kind: 'wsdl', file, line: 1, ids, tags: ['api', 'soap', ...(o.tags ?? [])], description: `Generated from ${file} (WSDL ${model.version})`,
    });
    d.comment(`configure the service once: soap.services.${key} (see import-report.md); each request body is a skeleton to fill in`);
    for (const op of ops.values()) {
      const src = { line: 1, original: `${svc.name}.${op.name} (SOAP ${op.soapVersion}${op.soapAction ? `, action ${op.soapAction}` : ''})` };
      let skeleton: string;
      try {
        skeleton = bodySkeleton(model, op);
      } catch (e) {
        d.addTodo(src, `no request skeleton: ${(e as Error).message}`);
        continue;
      }
      const assetPath = `soap/${key}/${op.name}.xml`;
      assets.push({ path: assetPath, content: `${op.documentation ? `<!-- ${op.documentation.replace(/--/g, '-')} -->\n` : ''}${skeleton}\n` });
      const capture = lowerFirst(op.name);
      if (!d.step(`Call SOAP operation ${quoteText(op.name)} on ${quoteText(key)} with file ${quoteText(`${outDir}/${assetPath}`)} and store as ${capture}`, src, { action: 'custom' })) continue;
      d.expect(`response ${capture} status is 200`, src);
    }
    drafts.push(d);
  }
  const report = assembleReport(drafts, [file], warnings);
  report.assets = [...(report.assets ?? []), ...assets];
  const port = model.services.flatMap((s) => s.ports).find((p) => p.soapVersion === prefer) ?? model.services[0]?.ports[0];
  report.markdown = [
    ...(report.markdown ?? []),
    '## SOAP service configuration', '',
    `Add this to eztest.config.yaml (docs/soap.md). The request skeletons are in \`${join(outDir, 'soap', key).split('\\').join('/')}/\`: replace the sample values, or call operations with named values instead (\`with PolicyId = "P-100"\`).`, '',
    '```yaml', 'soap:', '  services:', `    ${key}:`, `      wsdl: ${wsdlRel}`, ...(port?.address ? [`      endpoint: ${port.address}`] : []), `      soapVersion: "${prefer}"`, '      validate: both', '```',
  ];
  report.summary = { ...(report.summary ?? {}), wsdl: { version: model.version, service: key, operations: [...new Set(model.operations.map((x) => x.name))].length, journeys: report.journeys.length } };
  return report;
}

/** True for XML text that is a WSDL 1.1 or 2.0 document. */
export function looksLikeWsdl(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<(?:[\w.-]+:)?definitions\b[^>]*http:\/\/schemas\.xmlsoap\.org\/wsdl\//.test(head) || /<(?:[\w.-]+:)?description\b[^>]*http:\/\/www\.w3\.org\/ns\/wsdl/.test(head);
}
