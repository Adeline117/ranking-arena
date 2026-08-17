const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('legacy arena proxy is a local V1 tombstone', () => {
  const result = spawnSync(process.execPath, ['arena-proxy.mjs', '--any-legacy-argument'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {},
  })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^\[RETIRED\] V1 legacy proxy execution is not published\.\n$/)
})
