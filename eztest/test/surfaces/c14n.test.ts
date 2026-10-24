/**
 * Canonicalization against the examples of the W3C Canonical XML 1.0 and
 * Exclusive XML Canonicalization 1.0 recommendations, and (where installed)
 * cross-checked against libxml2's implementation (xmllint) as an independent
 * reference.
 */
import { describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, findElements, parseXml, serializeXml } from '../../src/surfaces/index.js';

const elem = (xml: string, local: string) => findElements(parseXml(xml).root, (e) => e.local === local)[0];

function xmllint(args: string[], xml: string): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'c14n-'));
    const f = join(dir, 'in.xml');
    writeFileSync(f, xml);
    return execFileSync('xmllint', [...args, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

// Canonical XML 1.0, 3.1: PIs, comments, and outside of document element.
const SPEC_3_1 = `<?xml version="1.0"?>

<?xml-stylesheet   href="doc.xsl"
   type="text/xsl"   ?>

<!DOCTYPE doc SYSTEM "doc.dtd">

<doc>Hello, world!<!-- Comment 1 --></doc>

<?pi-without-data     ?>

<!-- Comment 2 -->

<!-- Comment 3 -->`;

// 3.2: whitespace in document content (unchanged).
const SPEC_3_2 = `<doc>
   <clean>   </clean>
   <dirty>   A   B   </dirty>
   <mixed>
      A
      <clean>   </clean>
      B
      <dirty>   A   B   </dirty>
      C
   </mixed>
</doc>`;

// 3.3: start and end tags. The spec's e9 gets attr="default" from a DTD; EZTest does not read DTDs, so it is written out here.
const SPEC_3_3 = `<doc>
   <e1   />
   <e2   ></e2>
   <e3   name = "elem3"   id="elem3"   />
   <e4   name="elem4"   id="elem4"   ></e4>
   <e5 a:attr="out" b:attr="sorted" attr2="all" attr="I'm"
      xmlns:b="http://www.ietf.org"
      xmlns:a="http://www.w3.org"
      xmlns="http://example.org"/>
   <e6 xmlns="" xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="" xmlns:a="http://www.w3.org">
            <e9 xmlns="" xmlns:a="http://www.ietf.org" attr="default"/>
         </e8>
      </e7>
   </e6>
</doc>`;
const SPEC_3_3_OUT = `<doc>
   <e1></e1>
   <e2></e2>
   <e3 id="elem3" name="elem3"></e3>
   <e4 id="elem4" name="elem4"></e4>
   <e5 xmlns="http://example.org" xmlns:a="http://www.w3.org" xmlns:b="http://www.ietf.org" attr="I'm" attr2="all" b:attr="sorted" a:attr="out"></e5>
   <e6 xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="">
            <e9 xmlns:a="http://www.ietf.org" attr="default"></e9>
         </e8>
      </e7>
   </e6>
</doc>`;

// 3.4: character modifications and character references (the DTD-typed parts are left out).
const SPEC_3_4 = `<doc>
   <text>First line&#x0d;&#10;Second line</text>
   <value>&#x32;</value>
   <compute><![CDATA[value>"0" && value<"10" ?"valid":"error"]]></compute>
   <compute expr='value>"0" &amp;&amp; value&lt;"10" ?"valid":"error"'>valid</compute>
   <norm attr=' &apos;   &#x20;&#13;&#xa;&#9;   &apos; '/>
</doc>`;
const SPEC_3_4_OUT = `<doc>
   <text>First line&#xD;
Second line</text>
   <value>2</value>
   <compute>value&gt;"0" &amp;&amp; value&lt;"10" ?"valid":"error"</compute>
   <compute expr="value>&quot;0&quot; &amp;&amp; value&lt;&quot;10&quot; ?&quot;valid&quot;:&quot;error&quot;">valid</compute>
   <norm attr=" '    &#xD;&#xA;&#x9;   ' "></norm>
</doc>`;

// Exclusive XML Canonicalization 1.0, section 2.2: the same subtree in two different contexts.
const EXC_A = `<n0:local xmlns:n0="foo:bar" xmlns:n3="ftp://example.org">
  <n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n0:local>`;
const EXC_B = `<n2:pdu xmlns:n1="http://example.com"
           xmlns:n2="http://foo.example"
           xml:lang="fr"
           xml:space="retain">
  <n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n2:pdu>`;
const EXC_OUT = `<n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"></n3:stuff>
  </n1:elem2>`;

describe('Canonical XML 1.0 (W3C examples)', () => {
  it('3.1 PIs, comments and content outside the document element', () => {
    const doc = parseXml(SPEC_3_1);
    expect(canonicalize(doc, { exclusive: false })).toBe('<?xml-stylesheet href="doc.xsl"\n   type="text/xsl"   ?>\n<doc>Hello, world!</doc>\n<?pi-without-data?>');
    expect(canonicalize(doc, { exclusive: false, withComments: true })).toBe('<?xml-stylesheet href="doc.xsl"\n   type="text/xsl"   ?>\n<doc>Hello, world!<!-- Comment 1 --></doc>\n<?pi-without-data?>\n<!-- Comment 2 -->\n<!-- Comment 3 -->');
  });

  it('3.2 whitespace in content is kept', () => {
    expect(canonicalize(parseXml(SPEC_3_2), { exclusive: false })).toBe(SPEC_3_2);
  });

  it('3.3 start and end tags, attribute and namespace order, superfluous declarations', () => {
    expect(canonicalize(parseXml(SPEC_3_3), { exclusive: false })).toBe(SPEC_3_3_OUT);
  });

  it('3.4 character references, CDATA, attribute-value normalisation', () => {
    expect(canonicalize(parseXml(SPEC_3_4), { exclusive: false })).toBe(SPEC_3_4_OUT);
  });

  it('3.6 UTF-8: a character reference becomes the character', () => {
    expect(canonicalize(parseXml('<?xml version="1.0" encoding="ISO-8859-1"?>\n<doc>&#169;</doc>'), { exclusive: false })).toBe('<doc>©</doc>');
  });

  it('inclusive canonicalization of a subtree pulls in ancestor namespaces and xml: attributes', () => {
    expect(canonicalize(elem(EXC_A, 'elem2'), { exclusive: false })).toBe(`<n1:elem2 xmlns:n0="foo:bar" xmlns:n1="http://example.net" xmlns:n3="ftp://example.org" xml:lang="en">
    <n3:stuff></n3:stuff>
  </n1:elem2>`);
    expect(canonicalize(elem(EXC_B, 'elem2'), { exclusive: false })).toBe(`<n1:elem2 xmlns:n1="http://example.net" xmlns:n2="http://foo.example" xml:lang="en" xml:space="retain">
    <n3:stuff xmlns:n3="ftp://example.org"></n3:stuff>
  </n1:elem2>`);
  });
});

describe('Exclusive XML Canonicalization 1.0 (W3C example 2.2)', () => {
  it('a subtree canonicalizes the same in both contexts', () => {
    expect(canonicalize(elem(EXC_A, 'elem2'))).toBe(EXC_OUT);
    expect(canonicalize(elem(EXC_B, 'elem2'))).toBe(EXC_OUT);
  });

  it('InclusiveNamespaces PrefixList and the default namespace', () => {
    const x = `<a:r xmlns:a="urn:a" xmlns:b="urn:b" xmlns="urn:d"><a:s b:x="1"><t/></a:s><a:u/></a:r>`;
    expect(canonicalize(elem(x, 's'))).toBe('<a:s xmlns:a="urn:a" xmlns:b="urn:b" b:x="1"><t xmlns="urn:d"></t></a:s>');
    expect(canonicalize(elem(x, 'u'), { inclusivePrefixes: ['b', '#default'] })).toBe('<a:u xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b"></a:u>');
    // xmlns="" is emitted only when an output ancestor rendered a default namespace.
    const y = `<r xmlns="urn:d"><s xmlns=""><t/></s></r>`;
    expect(canonicalize(elem(y, 's'))).toBe('<s><t></t></s>');
    expect(canonicalize(parseXml(y).root)).toBe('<r xmlns="urn:d"><s xmlns=""><t></t></s></r>');
  });

  it('the excluded subtree (enveloped signature) is left out', () => {
    const d = parseXml('<r><a>1</a><Signature xmlns="urn:sig"><x/></Signature><b>2</b></r>');
    expect(canonicalize(d.root, { exclude: (n) => n.type === 'element' && n.local === 'Signature' })).toBe('<r><a>1</a><b>2</b></r>');
  });
});

describe('cross-check with libxml2 (xmllint) where installed', () => {
  const docs = [SPEC_3_2, SPEC_3_3, SPEC_3_4, EXC_A, EXC_B,
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:x="urn:unused"><soap:Body xmlns:wsu="urn:wsu" wsu:Id="b"><m:Get xmlns:m="urn:m" z="2" a="1">&lt;&amp;&gt; "q" \'a\'</m:Get></soap:Body></soap:Envelope>'];
  for (const [i, xml] of docs.entries()) {
    it(`document ${i + 1}: exclusive and inclusive match xmllint`, () => {
      const exc = xmllint(['--exc-c14n'], xml);
      const inc = xmllint(['--c14n'], xml);
      if (exc === undefined || inc === undefined) return; // xmllint not installed: the spec vectors above still apply
      expect(canonicalize(parseXml(xml))).toBe(exc);
      expect(canonicalize(parseXml(xml), { exclusive: false })).toBe(inc);
    });
  }

  it('serialises what it parsed', () => {
    const x = '<a:r xmlns:a="urn:a" k="&quot;&amp;&lt;"><!--c--><?p d?>t&amp;<b/></a:r>';
    expect(serializeXml(parseXml(x))).toBe(x);
  });
});
