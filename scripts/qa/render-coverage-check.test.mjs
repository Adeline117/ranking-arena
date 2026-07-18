import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SCRIPT = 'scripts/qa/render-coverage-check.mjs'

function envWithoutDatabase() {
  const env = { ...process.env }
  delete env.DATABASE_URL
  return env
}

test('render coverage has no eager pg dependency on the offline skip path', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  assert.doesNotMatch(source, /^import pg from 'pg'/m)
  assert.match(source, /const \{ default: pg \} = await import\('pg'\)/)
})

test('local mode may skip without DATABASE_URL', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    env: { ...envWithoutDatabase(), REQUIRE_DATABASE_URL: '0' },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /SKIPPED/)
})

test('scheduled mode fails when DATABASE_URL is missing', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    env: { ...envWithoutDatabase(), REQUIRE_DATABASE_URL: '1' },
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires DATABASE_URL/)
})

test('a configured but unreachable database fails closed', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://127.0.0.1:1/postgres?connect_timeout=1&sslmode=disable',
      REQUIRE_DATABASE_URL: '1',
    },
    encoding: 'utf8',
    timeout: 5_000,
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /infrastructure\/contract error/)
})
