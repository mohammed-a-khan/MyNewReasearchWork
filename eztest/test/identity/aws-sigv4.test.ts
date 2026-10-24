/**
 * EZTest's own AWS Signature Version 4 against the examples AWS publishes in
 * its documentation (the IAM ListUsers walkthrough with its signing key and
 * canonical-request hash, the "get-vanilla" request, and the S3 presigned
 * URL example).
 */
import { describe, expect, it } from '../support/testkit.js';
import { awsCredentials, presignUrl, sha256Hex, signRequest, signingKey } from '../../src/identity/aws-sigv4.js';

const date = new Date('2015-08-30T12:36:00Z');
const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('AWS SigV4 (documented examples)', () => {
  it('IAM ListUsers: signing key, canonical request hash and signature', () => {
    expect(signingKey(creds.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
    const r = signRequest({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, region: 'us-east-1', service: 'iam', credentials: creds, date });
    expect(sha256Hex(r.parts.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(r.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('get-vanilla', () => {
    const r = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', credentials: creds, date });
    expect(r.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('S3 presigned URL (query-string signature)', () => {
    const r = presignUrl({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', service: 's3', credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, date: new Date('2013-05-24T00:00:00Z'), expiresSeconds: 86400, payloadHash: 'UNSIGNED-PAYLOAD' });
    expect(r.url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(r.url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  });

  it('a session token is sent and signed; credentials come from the environment', () => {
    const r = signRequest({ method: 'POST', url: 'https://secretsmanager.eu-west-1.amazonaws.com/', body: '{}', region: 'eu-west-1', service: 'secretsmanager', credentials: { ...creds, sessionToken: 'tok' }, date });
    expect(r.headers['x-amz-security-token']).toBe('tok');
    expect(r.parts.signedHeaders).toBe('host;x-amz-date;x-amz-security-token');
    expect(awsCredentials({}, { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toEqual({ accessKeyId: 'a', secretAccessKey: 'b' });
    expect(() => awsCredentials({}, {})).toThrow(/AWS credentials are not set/);
  });
});
