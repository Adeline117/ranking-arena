import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')
)

test('keeps the CommonJS jayson UUID override narrow and executable', () => {
  assert.equal(packageJson.overrides?.jayson?.uuid, '11.1.1')
  assert.equal(packageJson.pnpm?.overrides?.['jayson>uuid'], '11.1.1')
  assert.equal(packageLock.packages?.['node_modules/uuid']?.version, '11.1.1')

  const jayson = require('jayson')
  const id = jayson.Utils.generateId()
  const request = jayson.Utils.request('health', { ok: true }, id)
  assert.equal(request.jsonrpc, '2.0')
  assert.equal(request.id, id)
  assert.match(id, /^[0-9a-f-]{36}$/u)
})

test('keeps Lighthouse on the patched Sentry/OpenTelemetry dependency line', () => {
  assert.equal(packageJson.devDependencies?.lighthouse, '^13.4.1')
  assert.equal(packageLock.packages?.['node_modules/lighthouse']?.version, '13.4.1')
  assert.equal(
    packageLock.packages?.['node_modules/lighthouse']?.dependencies?.['@sentry/node'],
    '^10.0.0'
  )
  assert.equal(packageLock.packages?.['node_modules/@opentelemetry/core']?.version, '2.8.0')
})
