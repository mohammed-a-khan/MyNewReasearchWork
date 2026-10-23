import { describe, expect, it } from '../support/testkit.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { checkDocument, detectPii, extractPdf, ibanValid, luhnValid, maskPii, renderHtml, toJson } from '../../src/docs/index.js';

async function pdfWith(lines: string[], pages = 1): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Statement');
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((l, i) => page.drawText(l, { x: 50, y: 800 - i * 16, size: 10, font: f }));
  }
  return pdf.save();
}

describe('validators', () => {
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5500005555555559')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234')).toBe(false);
  });
  it('IBAN mod-97 and country length', () => {
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(ibanValid('DE89 3704 0044 0532 0130')).toBe(false);
  });
  it('masks values for evidence', () => {
    expect(maskPii('card', '4111 1111 1111 1111')).toBe('**** **** **** 1111');
    expect(maskPii('ssn', '123-45-6789')).toBe('***-**-6789');
    expect(maskPii('email', 'jane.doe@example.com')).toBe('j***@example.com');
    expect(maskPii('iban', 'DE89370400440532013000')).toBe('DE****************3000');
  });
});

describe('checkDocument', () => {
  it('detects PII (Luhn/IBAN validated) and never stores the raw value', async () => {
    const doc = await extractPdf(
      await pdfWith([
        'Customer SSN: 123-45-6789',
        'Card: 4111 1111 1111 1111',
        'Not a card: 4111 1111 1111 1112',
        'IBAN: DE89 3704 0044 0532 0130 00',
        'Bad IBAN: DE89 3704 0044 0532 0130 01',
        'Contact: jane.doe@example.com',
        'Order 1234567890123',
      ]),
    );
    const hits = detectPii(doc);
    expect(hits.map((h) => `${h.type}:${h.masked}`).sort()).toEqual([
      'card:**** **** **** 1111',
      'email:j***@example.com',
      'iban:DE****************3000',
      'ssn:***-**-6789',
    ]);
    const r = checkDocument(doc, { pii: { detect: ['ssn', 'card', 'iban', 'email'] } });
    expect(r.status).toBe('FAIL');
    const json = toJson(r);
    const html = renderHtml(r);
    for (const secret of ['123-45-6789', '4111 1111 1111 1111', 'DE89 3704', 'jane.doe@']) {
      expect(json).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
  });

  it('verifies masking: masked card passes, full card fails', async () => {
    const good = await extractPdf(await pdfWith(['Paid with card **** **** **** 1234']));
    const rule = { name: 'card', type: 'card' as const, expectMasked: '\\*{4} \\*{4} \\*{4} \\d{4}' };
    expect(checkDocument(good, { masking: [rule] }).status).toBe('PASS');
    const bad = await extractPdf(await pdfWith(['Paid with card 5500 0055 5555 5559']));
    const r = checkDocument(bad, { masking: [rule] });
    expect(r.status).toBe('FAIL');
    expect(r.findings.filter((f) => !f.passed).map((f) => f.message)).toEqual([expect.stringMatching(/no correctly masked card/), 'card is not masked']);
  });

  it('page range, metadata, required clauses, forbidden placeholders', async () => {
    const doc = await extractPdf(
      await pdfWith(['Dear {{customer_name}},', 'This agreement is governed by the laws of', 'the State of New York.', 'TODO: add signature'], 2),
    );
    const r = checkDocument(doc, {
      pages: { min: 1, max: 1 },
      requiredMetadata: ['title', 'author'],
      requiredText: ['governed by the laws of the State of New York', 'Limitation of liability'],
      forbidPlaceholders: true,
      forbiddenText: ['lorem ipsum'],
    });
    const failed = r.findings.filter((f) => !f.passed).map((f) => f.check);
    expect(failed).toEqual(['forbidden:TODO', 'forbidden:placeholder {{', 'metadata:author', 'pages', 'required:Limitation of liability']);
    expect(r.findings.find((f) => f.check === 'required:governed by the laws of the State of New York')!.passed).toBe(true);
    expect(r.status).toBe('FAIL');
  });

  it('nothing passes on empty input', async () => {
    const doc = await extractPdf(await pdfWith(['hello']));
    expect(checkDocument(doc, {}).status).toBe('FAIL');
    const blank = await extractPdf(await pdfWith([]));
    const r = checkDocument(blank, { forbidPlaceholders: true });
    expect(r.status).toBe('FAIL');
    expect(r.findings[0].check).toBe('text-layer');
  });
});
