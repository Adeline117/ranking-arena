import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { captureBaselineReplayTargetCatalog } from './capture-baseline-replay-target-catalog.mjs'
import { SOURCE_CATALOG_KEYS } from './baseline-source-catalog-contract.mjs'

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'arena-target-catalog-test-'))
  const socket = mkdtempSync('/tmp/arena-baseline-pg17-socket.')
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { mode: 0o755 })
  const psql = path.join(bin, 'psql')
  const output = path.join(root, 'catalog.json')
  writeFileSync(psql, '#!/bin/sh\nexit 0\n')
  chmodSync(psql, 0o755)
  return { output, psql, root, socket }
}

function cleanup(value) {
  rmSync(value.root, { force: true, recursive: true })
  rmSync(value.socket, { force: true, recursive: true })
}

test('captures all shared source-catalog queries through the private socket with a minimal environment', () => {
  const value = fixture()
  const calls = []
  const ambientCredentials = {
    DATABASE_URL: 'postgres://must-not-leak.invalid/db',
    GITHUB_TOKEN: `ghp_${'a'.repeat(30)}`,
    PGPASSWORD: 'must-not-leak',
    REDIS_URL: 'redis://default:must-not-leak@cache.invalid:6379/0',
    STRIPE_SECRET_KEY: `sk_live_${'a'.repeat(24)}`,
  }
  const previousEnvironment = new Map(
    Object.keys(ambientCredentials).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, ambientCredentials)
  try {
    const result = captureBaselineReplayTargetCatalog({
      outputPath: value.output,
      psqlPath: value.psql,
      runner(command, args, options) {
        calls.push({ args, command, options })
        return { status: 0, stderr: '', stdout: '[]\n' }
      },
      socketPath: value.socket,
    })
    assert.equal(result.categoryCount, SOURCE_CATALOG_KEYS.length)
    assert.deepEqual(Object.keys(result.catalog), SOURCE_CATALOG_KEYS)
    assert.equal(calls.length, SOURCE_CATALOG_KEYS.length)
    for (const [index, call] of calls.entries()) {
      assert.equal(call.command, realpathSync(value.psql))
      assert.deepEqual(call.args.slice(0, 8), [
        '-h',
        realpathSync(value.socket),
        '-p',
        '5432',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ])
      assert.ok(call.args.includes('-X'))
      assert.ok(call.args.includes('-w'))
      assert.ok(call.args.includes('ON_ERROR_STOP=1'))
      const sql = call.args.at(-1)
      assert.match(sql, /BEGIN READ ONLY;/u)
      assert.match(sql, /SET LOCAL search_path = pg_catalog;/u)
      assert.match(sql, new RegExp(`arena_baseline_catalog:${SOURCE_CATALOG_KEYS[index]}`, 'u'))
      if (SOURCE_CATALOG_KEYS[index] === 'columns') assert.match(sql, /attribute\.attacl/u)
      if (SOURCE_CATALOG_KEYS[index] === 'functions') assert.match(sql, /routine\.proowner/u)
      if (SOURCE_CATALOG_KEYS[index] === 'views') {
        assert.match(sql, /relation\.relowner/u)
        assert.match(sql, /relation\.reloptions/u)
      }
      assert.doesNotMatch(sql, /\$1/u)
      assert.equal(call.options.env.DATABASE_URL, undefined)
      assert.equal(call.options.env.PGHOST, undefined)
      assert.equal(call.options.env.PGPASSWORD, undefined)
      assert.equal(call.options.env.REDIS_URL, undefined)
      assert.equal(call.options.env.GITHUB_TOKEN, undefined)
      assert.equal(call.options.env.STRIPE_SECRET_KEY, undefined)
      assert.equal(call.options.timeout, 65_000)
      assert.equal(call.options.killSignal, 'SIGKILL')
    }
    assert.deepEqual(JSON.parse(readFileSync(value.output, 'utf8')), result.catalog)
    assert.equal(lstatSync(value.output).mode & 0o777, 0o600)
  } finally {
    for (const [key, previous] of previousEnvironment) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
    cleanup(value)
  }
})

test('canonicalizes rows and rejects malformed output before publishing', async (t) => {
  for (const scenario of ['invalid JSON', 'query failure', 'timeout', 'wrong row shape']) {
    await t.test(scenario, () => {
      const value = fixture()
      try {
        let call = 0
        assert.throws(
          () =>
            captureBaselineReplayTargetCatalog({
              outputPath: value.output,
              psqlPath: value.psql,
              runner() {
                call += 1
                if (scenario === 'invalid JSON') return { status: 0, stdout: '{' }
                if (scenario === 'query failure') return { status: 9, stdout: '' }
                if (scenario === 'timeout') {
                  return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
                }
                return {
                  status: 0,
                  stdout: call === 1 ? '[{"unexpected":true}]' : '[]',
                }
              },
              socketPath: value.socket,
            }),
          /returned invalid JSON|query failed|catalogue contract failed/
        )
        assert.equal(lstatOrNull(value.output), null)
      } finally {
        cleanup(value)
      }
    })
  }
})

test('rejects PostgreSQL, Redis, GitHub, and Stripe secrets before publishing', async (t) => {
  for (const [name, secret] of [
    ['PostgreSQL', 'postgres://user:password@db.invalid/app'],
    ['Redis', 'redis://default:password@cache.invalid:6379/0'],
    ['GitHub', `ghp_${'a'.repeat(30)}`],
    ['Stripe', `sk_live_${'a'.repeat(24)}`],
  ]) {
    await t.test(name, () => {
      const value = fixture()
      let call = 0
      try {
        assert.throws(
          () =>
            captureBaselineReplayTargetCatalog({
              outputPath: value.output,
              psqlPath: value.psql,
              runner() {
                const key = SOURCE_CATALOG_KEYS[call++]
                if (key !== 'functions') return { status: 0, stdout: '[]' }
                return {
                  status: 0,
                  stdout: JSON.stringify([
                    {
                      configuration: null,
                      definition: `CREATE FUNCTION arena.leak() RETURNS text LANGUAGE sql AS 'SELECT ''${secret}''';`,
                      identityArguments: '',
                      kind: 'f',
                      language: 'sql',
                      leakproof: false,
                      name: 'leak',
                      owner: 'postgres',
                      result: 'text',
                      schema: 'arena',
                      securityDefiner: false,
                      volatility: 'v',
                    },
                  ]),
                }
              },
              socketPath: value.socket,
            }),
          /contains credential-like data/
        )
        assert.equal(lstatOrNull(value.output), null)
      } finally {
        cleanup(value)
      }
    })
  }
})

test('fails closed when the socket, output parent, psql parent, or psql changes between queries', async (t) => {
  for (const scenario of [
    'socket permissions',
    'output parent permissions',
    'psql parent permissions',
    'psql bytes',
  ]) {
    await t.test(scenario, () => {
      const value = fixture()
      let calls = 0
      try {
        assert.throws(
          () =>
            captureBaselineReplayTargetCatalog({
              outputPath: value.output,
              psqlPath: value.psql,
              runner() {
                calls += 1
                if (calls === 7) {
                  if (scenario === 'socket permissions') chmodSync(value.socket, 0o755)
                  if (scenario === 'output parent permissions') chmodSync(value.root, 0o777)
                  if (scenario === 'psql parent permissions') {
                    chmodSync(path.dirname(value.psql), 0o777)
                  }
                  if (scenario === 'psql bytes') {
                    writeFileSync(value.psql, '#!/bin/sh\nprintf changed\\n\n')
                  }
                }
                return { status: 0, stdout: '[]' }
              },
              socketPath: value.socket,
            }),
          /changed during target catalogue capture|psql physical parent must/
        )
        assert.equal(lstatOrNull(value.output), null)
      } finally {
        chmodSync(value.root, 0o700)
        chmodSync(value.socket, 0o700)
        chmodSync(path.dirname(value.psql), 0o755)
        cleanup(value)
      }
    })
  }
})

test('rejects unsafe initial socket, output-parent, psql-parent, and psql permissions before spawning', async (t) => {
  for (const scenario of ['socket', 'output parent', 'psql parent', 'psql']) {
    await t.test(scenario, () => {
      const value = fixture()
      let spawned = false
      try {
        if (scenario === 'socket') chmodSync(value.socket, 0o750)
        if (scenario === 'output parent') chmodSync(value.root, 0o720)
        if (scenario === 'psql parent') chmodSync(path.dirname(value.psql), 0o775)
        if (scenario === 'psql') chmodSync(value.psql, 0o775)
        assert.throws(
          () =>
            captureBaselineReplayTargetCatalog({
              outputPath: value.output,
              psqlPath: value.psql,
              runner() {
                spawned = true
                return { status: 0, stdout: '[]' }
              },
              socketPath: value.socket,
            }),
          /mode 0700|not group\/world writable|non-writable regular file/
        )
        assert.equal(spawned, false)
        assert.equal(lstatOrNull(value.output), null)
      } finally {
        chmodSync(value.root, 0o700)
        chmodSync(value.socket, 0o700)
        chmodSync(path.dirname(value.psql), 0o755)
        cleanup(value)
      }
    })
  }
})

test('rejects a socket outside the exact disposable harness namespace', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arena-target-catalog-test-'))
  const socket = path.join(root, 'socket')
  const psql = path.join(root, 'psql')
  mkdirSync(socket)
  writeFileSync(psql, '#!/bin/sh\nexit 0\n')
  chmodSync(psql, 0o755)
  try {
    assert.throws(
      () =>
        captureBaselineReplayTargetCatalog({
          outputPath: path.join(root, 'catalog.json'),
          psqlPath: psql,
          runner: () => ({ status: 0, stdout: '[]' }),
          socketPath: socket,
        }),
      /harness prefix/
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

function lstatOrNull(file) {
  try {
    return lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
