# SOAP services

EZTest calls SOAP services from their WSDL. It builds requests from the WSDL's schema, validates requests and responses against it, adds WS-Security (UsernameToken, Timestamp, X.509 signatures), checks signed responses, and sends binary content as MTOM attachments. Everything here is EZTest's own code, written from the W3C and OASIS specifications: the WSDL reader (on fast-xml-parser), the XML DOM, canonicalization, XML Signature, the XSD validator and MTOM. Crypto comes from `node:crypto`.

For a quick call without a WSDL, the API step still takes a raw body: `Call SOAP action "GetOrder" on /soap with body "<GetOrder><Id>1</Id></GetOrder>"` ([ez-language.md](ez-language.md)).

## Import a WSDL

```bash
eztest import wsdl wsdl/policy.wsdl
```

This writes, per WSDL service, a journey with one `Call SOAP operation` step per operation, a request body skeleton per operation (`journeys/imported/soap/<service>/<Operation>.xml`), and `import-report.md` with the configuration block to paste. Skeletons have the required elements with typed sample values (first enumeration value, a date for `xs:date`, `0` for numbers), optional elements marked `<!-- optional -->`, and choices named `<!-- choice: A | B -->`. WSDL 1.1 and WSDL 2.0 are read, with `wsdl:import`, inline schemas and their `xs:import` / `xs:include`. A WSDL with both SOAP 1.1 and 1.2 bindings uses SOAP 1.1 unless the service config says `soapVersion: "1.2"`.

## Configure the service

```yaml
soap:
  services:
    policy:
      wsdl: wsdl/policy.wsdl              # file (relative to the project) or URL
      endpoint: https://policy.test.example.com/ws   # default: the address in the WSDL
      soapVersion: "1.1"                  # which binding, when the WSDL has both
      validate: both                      # both | request | response | off
      headers: { x-client: eztest }       # extra HTTP headers (values may be secret references)
      timeoutMs: 30000
      security:
        username: svc-test
        password: secret://env/POLICY_PW
        passwordType: digest              # text (default) | digest
        timestamp: 300                    # add a Timestamp valid 300 s (true = 300)
        sign: { key: keys/client.key.pem, certificate: keys/client.cert.pem }   # parts: [Body, Timestamp] by default
        verify: { certificates: [keys/policy-server.cert.pem], require: true }
      mtom: { elements: [Content] }       # send these base64 elements as MTOM attachments
```

The password and the key may be secret references (`secret://...`); their values are masked in evidence.

## Steps

```text
Call SOAP operation "GetPolicy" on "policy" with PolicyId = "P-100", IncludeCoverage = true and store as policy
  Expect response policy status is 200
  Expect response policy "$.GetPolicyResponse.Policy.Status" equals "Active"
Call SOAP operation "SearchPolicies" on policy with '{"Status": "Active", "MaxResults": 5}' and store as found
Call SOAP operation "GetPolicy" on policy with file "requests/get-policy.xml"
Call SOAP operation "GetPolicy" on policy with body "<p:GetPolicy xmlns:p='urn:example:policy'><p:PolicyId>P-1</p:PolicyId></p:GetPolicy>"
Call SOAP operation "GetPolicy" on policy with PolicyId = "P-404" allowing faults and store as missing
```

- **Named values** (`PolicyId = "P-100"`) fill the operation's request skeleton. A name is an element's local name, or a dotted path when the name is not unique (`Holder.Name`). Optional elements nobody gave a value are left out; a required element without a value is an error that names it. For a choice, give a value to the option you want. A JSON object (`with '{"Holder": {"Name": "Ann"}}'`) works the same way, nested objects becoming paths.
- **`with file`** sends the file's body content, or the whole envelope when the file has one (as the imported skeletons do once filled in). **`with body`** sends the XML given.
- The response is kept under the `store as` name (default `response`): `status`, `headers`, `body` (the Body content as an object, namespace prefixes removed, values as text), `fault`, `xml` (the raw envelope), `valid` (request and response validation), `security` (signature checks) and `attachments` (MTOM). JSONPath expectations read `body`.
- A SOAP fault fails the step with the fault code and reason, unless the step says `allowing faults`.
- Request and response are stored as network evidence, masked.

## Validation (XSD)

With `validate: both` (the default), the request is checked against the WSDL's schemas before it is sent (an invalid request never leaves), and the response after it arrives. Every problem is reported with its path, for example `/Envelope/Body/GetPolicyResponse/Policy/Premium: Value 12.345 has more than 2 fraction digits`.

**The supported XSD subset**, which covers what SOAP services commonly use:

- schema documents: `targetNamespace`, `elementFormDefault`, `attributeFormDefault`, `xs:import` and `xs:include` (chameleon includes too), several schemas at once;
- elements: global and local declarations, `ref`, `minOccurs` / `maxOccurs`, `nillable` with `xsi:nil`, `default` and `fixed`, `abstract`, `xsi:type` naming a derived type;
- complex types: `sequence`, `choice`, `all`, named model groups (`xs:group`), `xs:any` with namespace constraints and `processContents`, mixed and empty content, `simpleContent` and `complexContent` by `extension` or `restriction`, attributes with `use`, attribute groups, `xs:anyAttribute`;
- simple types: `restriction` with `enumeration`, `pattern`, `length`, `minLength`, `maxLength`, `minInclusive`, `maxInclusive`, `minExclusive`, `maxExclusive`, `totalDigits`, `fractionDigits`, `whiteSpace`; `list`; `union`;
- built-in types: strings and tokens, names (`Name`, `NCName`, `QName`, `ID`, ...), all numeric types with their ranges, `boolean`, dates and times (`date` checks that the day exists), `duration`, the `g*` types, `base64Binary`, `hexBinary`, `anyURI`, `NMTOKENS` and the other list types.

**Not supported**, and reported when a schema uses them (in the WSDL import warnings and `XsdSchemaSet.unsupported`), never silently passed as valid: substitution groups, identity constraints (`xs:key`, `xs:keyref`, `xs:unique`), `xs:redefine` and `xs:override`, XSD 1.1 assertions, notations. Content models are matched greedily, which is exact for schemas that follow the Unique Particle Attribution rule (as valid schemas must). Patterns use XSD's regular expressions translated to JavaScript ones; `\i` and `\c` are supported, Unicode block escapes (`\p{IsBasicLatin}`) are not.

## WS-Security

`security` in the service config adds a `wsse:Security` header (with `mustUnderstand`):

- **UsernameToken**: `passwordType: text` sends the password; `digest` sends `Base64(SHA-1(nonce + created + password))` with a random 16-byte nonce and the creation time.
- **Timestamp**: `wsu:Created` and `wsu:Expires`.
- **X.509 signature**: the certificate as a `BinarySecurityToken`, and an XML Signature over the Body and the Timestamp (each given a `wsu:Id`), referenced through a `SecurityTokenReference`. Exclusive canonicalization (`xml-exc-c14n#`), SHA-256 digests, RSA-SHA256.

**Signed responses** (`verify`): the signature must be valid, cover the envelope's own Body and Timestamp (a signed element moved elsewhere, as in signature wrapping, does not count, and duplicate ids are refused), be made by one of the trusted `certificates`, and the Timestamp must be current (5 minutes of clock skew allowed). `require: false` accepts unsigned responses. An unsigned SOAP fault is reported as the fault. Verification accepts SHA-1, SHA-256 and SHA-512 digests, RSA-SHA1/256/512 signatures, and exclusive or inclusive canonicalization, with or without comments.

The same functions are available in code (`@eztech/eztest/surfaces`): `applyWsSecurity`, `verifyWsSecurity`, `checkUsernameToken` (the receiving side, for service stand-ins), `signXml`, `verifyXmlSignature` and `canonicalize`.

**How it is tested.** Canonicalization against the examples of the W3C Canonical XML 1.0 and Exclusive XML Canonicalization recommendations, and against libxml2 (`xmllint --c14n` / `--exc-c14n`) where it is installed. Signatures by a SOAP test server that verifies them like a strict service, and independently with Python's lxml (libxml2) recomputing the digests and the canonical SignedInfo, and OpenSSL checking the RSA signature. Tampering, untrusted signers, signature wrapping and expired timestamps are rejected.

## MTOM / XOP

`mtom.elements` names the elements whose base64 content is sent as binary MIME parts (`multipart/related; type="application/xop+xml"`, with `xop:Include` in the envelope). MTOM responses are put back together: `xop:Include` is replaced by the part's content as base64, and `attachments` lists the parts. Limits: one level of multipart/related, parts held in memory, Content-Transfer-Encoding binary, 8bit or base64. When WS-Security signs an MTOM request, the signature covers the envelope before optimisation (the base64 text), which is what receivers that verify after reassembly expect; receivers that verify the optimised form are not supported.

## Not supported

SOAP encoding (`use="encoded"`; requests are built as literal, with a warning), WS-Addressing headers (add them with `with file` or `headers`), WS-ReliableMessaging, WS-SecureConversation and SAML tokens, XML Encryption, and HTTP or MIME bindings other than MTOM.
