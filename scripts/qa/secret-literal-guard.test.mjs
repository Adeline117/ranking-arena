import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText } from './secret-literal-guard.mjs'

// Fixtures are assembled at runtime so this file never contains a literal the
// guard (or GitHub push protection) would flag.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (payload) =>
  [b64({ alg: 'HS256', typ: 'JWT' }), b64(payload), 'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc'].join('.')

test('flags a Supabase service_role JWT and reports its line', () => {
  const text = `line one\nconst KEY = '${jwt({ iss: 'supabase', role: 'service_role' })}'\n`
  assert.deepEqual(scanText(text), [{ line: 2, kind: 'Supabase service_role JWT' }])
})

test('allows the public anon JWT', () => {
  assert.deepEqual(scanText(`'${jwt({ iss: 'supabase', role: 'anon' })}'`), [])
})

test('flags sb_secret_ keys but not publishable keys', () => {
  const secret = 'sb_' + 'secret_' + 'Q7f2kLm9Zp4Rt8Wv1Xy6Bn3C'
  const publishable = 'sb_' + 'publishable_' + 'Q7f2kLm9Zp4Rt8Wv1Xy6Bn3C'
  assert.equal(scanText(secret).length, 1)
  assert.deepEqual(scanText(publishable), [])
})

test('flags a Stripe live key but not a documentation placeholder', () => {
  const live = 'sk_' + 'live_' + '51Hq8Lm2Zp4Rt8Wv1Xy6Bn3Cd9'
  const placeholder = 'sk_' + 'live_' + 'xxxxxxxxxxxxxxxxxxxxxxxx'
  assert.equal(scanText(live)[0].kind, 'Stripe live secret key')
  assert.deepEqual(scanText(placeholder), [])
  assert.deepEqual(scanText('whsec_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), [])
})

test('flags a PEM key body but not an elided example', () => {
  const row = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun'
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${row}\n${row}\n${row}\n-----END RSA PRIVATE KEY-----`
  const elided = '-----BEGIN RSA PRIVATE KEY-----\nKh9NV...\n-----END RSA PRIVATE KEY-----'
  assert.equal(scanText(pem)[0].kind, 'PEM private key')
  assert.deepEqual(scanText(elided), [])
})
