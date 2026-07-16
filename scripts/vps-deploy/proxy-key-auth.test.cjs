const assert = require('node:assert/strict')
const test = require('node:test')
const { loadProxyKeyConfig, verifyProxyKey } = require('./proxy-key-auth.cjs')

test('supports the legacy key during the compatibility rollout', () => {
  const config = loadProxyKeyConfig({ PROXY_KEY: 'legacy-transition-key' })
  assert.deepEqual(config.accepted, ['legacy-transition-key'])
  assert.equal(config.preferred, 'legacy-transition-key')
})

test('accepts current and next while clients prefer next', () => {
  const config = loadProxyKeyConfig({
    PROXY_KEY_CURRENT: 'current-transition-key',
    PROXY_KEY_NEXT: 'next-64-hex-character-key',
  })

  assert.deepEqual(config.accepted, ['current-transition-key', 'next-64-hex-character-key'])
  assert.equal(config.preferred, 'next-64-hex-character-key')
  assert.equal(verifyProxyKey('current-transition-key', config.accepted), true)
  assert.equal(verifyProxyKey('next-64-hex-character-key', config.accepted), true)
  assert.equal(verifyProxyKey('wrong-key', config.accepted), false)
})

test('deduplicates equal rotation keys', () => {
  const config = loadProxyKeyConfig({
    PROXY_KEY_CURRENT: 'same-transition-key',
    PROXY_KEY_NEXT: 'same-transition-key',
  })
  assert.deepEqual(config.accepted, ['same-transition-key'])
})

test('fails closed without a configured key', () => {
  assert.throws(() => loadProxyKeyConfig({}), /PROXY_KEY_CURRENT/)
  assert.equal(verifyProxyKey(undefined, ['configured-key']), false)
  assert.equal(verifyProxyKey(['configured-key'], ['configured-key']), false)
  assert.equal(verifyProxyKey('x'.repeat(513), ['configured-key']), false)
})
