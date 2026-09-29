import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt, validateClaims, displayName, ssoProviders } from '../js/auth.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;

const now = Date.parse('2026-09-23T12:00:00Z');
const good = {
  iss: 'https://sso.example.com/realms/acme',
  aud: 'taskflow',
  sub: 'user-1',
  nonce: 'n1',
  exp: now / 1000 + 3600,
};
const opts = { issuer: 'https://sso.example.com/realms/acme/', clientId: 'taskflow', nonce: 'n1', now };

test('decodeJwt reads the payload, including non-ASCII names', () => {
  assert.deepEqual(decodeJwt(jwt({ name: 'Zoë Ñúñez', sub: 'x' })), { name: 'Zoë Ñúñez', sub: 'x' });
  assert.throws(() => decodeJwt('not-a-jwt'));
});

test('validateClaims accepts a matching token', () => {
  assert.deepEqual(validateClaims(good, opts), []);
  assert.deepEqual(validateClaims({ ...good, aud: ['other', 'taskflow'] }, opts), []);
});

test('validateClaims rejects wrong issuer, audience, nonce, expiry and subject', () => {
  assert.deepEqual(validateClaims({ ...good, iss: 'https://evil.example.com' }, opts), ['issuer mismatch']);
  assert.deepEqual(validateClaims({ ...good, aud: 'someone-else' }, opts), ['audience mismatch']);
  assert.deepEqual(validateClaims({ ...good, nonce: 'n2' }, opts), ['nonce mismatch']);
  assert.deepEqual(validateClaims({ ...good, exp: now / 1000 - 3600 }, opts), ['token expired']);
  assert.deepEqual(validateClaims({ ...good, sub: '' }, opts), ['missing subject']);
});

test('validateClaims supports the Entra multi-tenant {tenantid} issuer', () => {
  const entra = { ...opts, issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
  const iss = 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0';
  assert.deepEqual(validateClaims({ ...good, iss }, entra), []);
  assert.deepEqual(validateClaims({ ...good, iss: 'https://login.microsoftonline.com/a/b/v2.0' }, entra), ['issuer mismatch']);
});

test('displayName falls back through the usual claims', () => {
  assert.equal(displayName({ name: 'Ada Lovelace' }), 'Ada Lovelace');
  assert.equal(displayName({ given_name: 'Ada', family_name: 'L' }), 'Ada L');
  assert.equal(displayName({ preferred_username: 'ada@corp' }), 'ada@corp');
  assert.equal(displayName({}), 'Signed-in user');
});

test('ssoProviders ignores incomplete entries', () => {
  assert.deepEqual(ssoProviders(), [], 'none configured by default');
  const list = [{ id: 'a', issuer: 'https://x', clientId: 'c' }, { id: 'b', issuer: 'https://y' }, null];
  assert.deepEqual(ssoProviders(list).map((p) => p.id), ['a']);
});
