/**
 * The `email` publisher: mails the run summary (email.html, with a plain-text
 * alternative) to a list of recipients over SMTP, with the PDF report (and
 * optionally the Excel workbook or the HTML report) attached.
 *
 *   publishers:
 *     - use: email
 *       host: smtp.example.com
 *       port: 587                       # STARTTLS when offered; 465 = implicit TLS
 *       username: secret://env/SMTP_USER
 *       password: secret://env/SMTP_PASSWORD
 *       from: "Test reports <qa@example.com>"
 *       to: [team@example.com]
 *       attach: [pdf, xlsx]             # pdf (default), xlsx, html, summary; [] for none
 *       when: always                    # always (default) | failed | not-go
 *       reportUrl: https://ci.example.com/artifacts/report.html
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin, PLUGIN_API_VERSION, type EzPlugin } from '../api.js';
import type { PublishContext, PublishResult } from '../registry.js';
import { readReportModel, REPORT_FILES } from '../../report/write.js';
import { emailSubject, renderEmailHtml, renderEmailText } from '../../report/email.js';
import { sendSmtp, type SmtpAttachment } from '../../messaging/smtp-client.js';

const ATTACH: Record<string, { file: string; type: string }> = {
  pdf: { file: REPORT_FILES.pdf, type: 'application/pdf' },
  xlsx: { file: REPORT_FILES.xlsx, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  html: { file: REPORT_FILES.html, type: 'text/html' },
  summary: { file: REPORT_FILES.summary, type: 'text/html' },
};
const MAX_ATTACH = 15 * 1024 * 1024;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(/[,;]\s*/) : []).map((s) => s.trim()).filter(Boolean);

export async function publishEmail(ctx: PublishContext): Promise<PublishResult> {
  const o = ctx.options;
  const m = await readReportModel(ctx.runDir).catch(() => undefined);
  if (!m) return { ok: false, message: 'email: no report model in the run directory (run with the html or json reporter)' };
  const when = String(o.when ?? 'always');
  const bad = m.kpis.failed + m.kpis.errors > 0;
  if ((when === 'failed' && !bad) || (when === 'not-go' && m.verdict.decision !== 'NO_GO')) return { ok: true, message: `email: not sent (when: ${when})` };
  const to = list(o.to);
  if (!to.length) return { ok: false, message: 'email: needs "to" (one or more addresses)' };
  const from = typeof o.from === 'string' && o.from ? o.from : undefined;
  if (!from) return { ok: false, message: 'email: needs "from"' };
  const reportUrl = typeof o.reportUrl === 'string' ? o.reportUrl : undefined;
  const html = renderEmailHtml(m, { reportUrl, runUrl: ctx.runUrl });
  const text = renderEmailText(m, { reportUrl, runUrl: ctx.runUrl });
  const subject = `${typeof o.subjectPrefix === 'string' ? `${o.subjectPrefix} ` : ''}${emailSubject(m)}`;
  const attachments: SmtpAttachment[] = [];
  const skipped: string[] = [];
  for (const kind of o.attach === undefined ? ['pdf'] : list(o.attach)) {
    const a = ATTACH[kind];
    if (!a) {
      skipped.push(`${kind} (unknown; use pdf, xlsx, html or summary)`);
      continue;
    }
    const p = join(ctx.runDir, a.file);
    if (!existsSync(p)) {
      skipped.push(`${a.file} (not written)`);
      continue;
    }
    const size = (await stat(p)).size;
    if (size > MAX_ATTACH || attachments.reduce((n, x) => n + x.content.length, 0) + size > MAX_ATTACH) {
      skipped.push(`${a.file} (${Math.round(size / 1024)} KiB; over the ${MAX_ATTACH / 1024 / 1024} MiB limit)`);
      continue;
    }
    attachments.push({ filename: a.file, contentType: a.type, content: await readFile(p) });
  }
  const message = { from, to, cc: list(o.cc), bcc: list(o.bcc), subject, text, html, attachments };
  if (o.dryRun) return { ok: true, message: `dry run: would mail ${to.length + list(o.cc).length + list(o.bcc).length} recipient(s)`, details: { subject, to, attachments: attachments.map((a) => a.filename), skipped } };
  if (typeof o.host !== 'string' || !o.host) return { ok: false, message: 'email: needs "host" (the SMTP server)' };
  const r = await sendSmtp({
    host: o.host,
    port: Number(o.port ?? 587),
    ...(typeof o.secure === 'boolean' ? { secure: o.secure } : {}),
    ...(o.starttls === false || o.starttls === 'required' ? { starttls: o.starttls } : {}),
    ...(typeof o.username === 'string' ? { username: await ctx.resolveSecret(o.username) } : {}),
    ...(typeof o.password === 'string' ? { password: await ctx.resolveSecret(o.password) } : {}),
    ...(o.insecureTls === true ? { insecureTls: true } : {}),
  }, message);
  return { ok: true, message: `mailed to ${r.recipients} recipient(s)${attachments.length ? ` with ${attachments.map((a) => a.filename).join(', ')}` : ''}${skipped.length ? `; not attached: ${skipped.join(', ')}` : ''}` };
}

export const emailPlugin: EzPlugin = definePlugin({
  name: 'eztest/email',
  apiVersion: PLUGIN_API_VERSION,
  setup(api) {
    api.registerPublisher({ name: 'email', publish: publishEmail });
  },
});
