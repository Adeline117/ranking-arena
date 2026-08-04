import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const packageManifest = require('../../package.json')
const lockPackages = require('../../package-lock.json').packages

test('the jayson UUID patch is scoped and keeps Solana runtime compatibility', () => {
  assert.deepEqual(packageManifest.overrides.jayson, { uuid: '11.1.1' })
  assert.equal(packageManifest.pnpm.overrides['jayson>uuid'], '11.1.1')
  assert.equal(lockPackages['node_modules/uuid']?.version, '11.1.1')
  assert.equal(lockPackages['node_modules/rpc-websockets/node_modules/uuid']?.version, '14.0.0')

  const requireFromJayson = createRequire(require.resolve('jayson/package.json'))
  assert.equal(requireFromJayson('uuid/package.json').version, '11.1.1')
  assert.equal(typeof requireFromJayson('uuid').v4, 'function')

  const request = require('jayson').Utils.request('health', { ready: true })
  assert.equal(request.method, 'health')
  assert.deepEqual(request.params, { ready: true })
  assert.match(request.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  const { Connection, PublicKey } = require('@solana/web3.js')
  assert.equal(
    new PublicKey('11111111111111111111111111111111').toBase58(),
    '11111111111111111111111111111111'
  )
  assert.equal(
    new Connection('https://api.mainnet-beta.solana.com').rpcEndpoint,
    'https://api.mainnet-beta.solana.com'
  )
})
