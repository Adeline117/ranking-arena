import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { rootCertificates } from 'node:tls'

import pg from 'pg'

import { validateSourceCatalogRowContracts } from '../qa/baseline-source-catalog-contract.mjs'
import { validateAppSchemaSqlSafety } from '../qa/baseline-sql-safety.mjs'

import {
  CAPTURE_CA_FILE_NAME,
  CAPTURE_OPT_IN_NAME,
  CAPTURE_SOURCE_URL_NAME,
  SOURCE_CATALOG_CONTRACT,
  _captureContractForTests,
  captureCanonicalBaseline,
  inspectPg17Toolchain,
  validateSourceUrl,
} from './capture-canonical-baseline.mjs'

const SECRET = 'source-password-must-not-enter-argv'
const SOURCE_HOST = 'db.abcdefghijklmnopqrst.supabase.co'
const SOURCE_URL = `postgresql://capture:${SECRET}@${SOURCE_HOST}:5432/postgres?sslmode=verify-full`
const DUMP_TOKEN = 'A'.repeat(63)
const VALID_DUMP = `-- PostgreSQL database dump
\\restrict ${DUMP_TOKEN}
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
SET default_table_access_method = heap;
SET default_tablespace = '';
CREATE SCHEMA "public";
CREATE SCHEMA arena;
CREATE TABLE public.example (id bigint PRIMARY KEY);
\\unrestrict ${DUMP_TOKEN}
-- PostgreSQL database dump complete
`
const NORMALIZED_DUMP = VALID_DUMP.replace(
  'CREATE SCHEMA "public";',
  '-- Arena baseline replay uses the target-provided "public" schema.'
)

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'arena-baseline-capture-test-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const bin = path.join(root, 'pg17-bin')
  const outputParent = path.join(root, 'captures')
  await mkdir(bin)
  await mkdir(outputParent, { mode: 0o700 })
  for (const tool of ['pg_dump', 'psql']) {
    const toolPath = path.join(bin, tool)
    await writeFile(toolPath, '#!/bin/sh\nexit 1\n')
    await chmod(toolPath, 0o700)
  }
  const caPath = path.join(root, 'project-ca.pem')
  await writeFile(caPath, `${rootCertificates[0]}\n`, { mode: 0o600 })
  return {
    bin,
    caPath,
    env: {
      [CAPTURE_CA_FILE_NAME]: caPath,
      [CAPTURE_OPT_IN_NAME]: '1',
      [CAPTURE_SOURCE_URL_NAME]: SOURCE_URL,
      AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret-must-not-reach-tools',
      DATABASE_URL: 'postgresql://ambient:ambient-secret@wrong.test:6543/wrong',
      DIRECT_URL: 'postgresql://ambient:ambient-secret@wrong.test:5432/wrong',
      DYLD_INSERT_LIBRARIES: '/ambient/untrusted.dylib',
      PG17_BIN: bin,
      PGHOST: 'ambient-pg-host.test',
      SUPABASE_ACCESS_TOKEN: 'ambient-supabase-token-must-not-reach-tools',
    },
    outputDir: path.join(outputParent, 'capture-20260804'),
    outputParent,
    root,
  }
}

function fakeClient({
  credentialCatalog = null,
  events,
  failCatalog = false,
  ledgerRows = null,
  onConfiguration,
  onRollback,
  unicodeCatalog = false,
} = {}) {
  let catalogCount = 0
  const functionRow = (name, definition = `CREATE FUNCTION public.${name}() RETURNS void`) => ({
    configuration: null,
    definition,
    identityArguments: '',
    kind: 'f',
    language: 'sql',
    leakproof: false,
    name,
    result: 'void',
    schema: 'public',
    securityDefiner: false,
    volatility: 'v',
  })
  return (configuration) => {
    onConfiguration?.(configuration)
    return {
      async connect() {
        events?.push('client:connect')
      },
      async end() {
        events?.push('client:end')
      },
      async query(sql, values = []) {
        const normalized = String(sql).replace(/\s+/gu, ' ').trim()
        events?.push(`query:${normalized}`)
        if (normalized === 'ROLLBACK' && onRollback) return onRollback()
        if (normalized.includes('pg_export_snapshot')) {
          return {
            rows: [
              {
                server_version_num: '170008',
                snapshot_id: '00000003-0000001B-1',
                transaction_read_only: 'on',
                transaction_timestamp: new Date('2026-08-04T12:34:56.789Z'),
              },
            ],
          }
        }
        if (normalized.includes('arena_baseline_catalog:')) {
          catalogCount += 1
          if (failCatalog && catalogCount === 2) throw new Error('fake catalog failure')
          const label = /arena_baseline_catalog:([A-Za-z]+)/u.exec(normalized)?.[1] ?? 'unknown'
          assert.deepEqual(
            values,
            label === 'extensions' ? [] : [_captureContractForTests.appSchemas]
          )
          if (credentialCatalog !== null && label === 'functions') {
            return { rows: [functionRow('credential_fixture', credentialCatalog)] }
          }
          if (unicodeCatalog && label === 'functions') {
            return { rows: [functionRow('ä'), functionRow('z')] }
          }
          return { rows: [] }
        }
        if (normalized.includes('arena_baseline_ledger')) {
          return {
            rows: ledgerRows ?? [
              {
                name: 'captured_boundary',
                statements: ['SUPER_SECRET_STATEMENT_TEXT', 'second statement'],
                version: '20260804000000',
              },
            ],
          }
        }
        return { rows: [] }
      },
    }
  }
}

function fakeRunner({ events, dumpContents = VALID_DUMP, dumpExitCode = 0, versions = {} } = {}) {
  const calls = []
  const runCommand = async (command, args, options = {}) => {
    const name = path.basename(command)
    calls.push({ args: [...args], command, name, options })
    if (args.length === 1 && args[0] === '--version') {
      events?.push(`spawn:${name}:version`)
      return {
        code: 0,
        overflow: false,
        signal: null,
        stderr: '',
        stdout: `${name} (PostgreSQL) ${versions[name] ?? '17.8'}\n`,
      }
    }
    assert.equal(name, 'pg_dump')
    events?.push('spawn:pg_dump:capture')
    const outputArgument = args.find((argument) => argument.startsWith('--file='))
    assert.ok(outputArgument)
    if (dumpExitCode === 0) await writeFile(outputArgument.slice('--file='.length), dumpContents)
    return {
      code: dumpExitCode,
      overflow: false,
      signal: null,
      stderr: dumpExitCode === 0 ? '' : 'fake failure without connection details',
      stdout: '',
    }
  }
  return { calls, runCommand }
}

test('requires one exact opt-in before URL, filesystem, tools, or client access', async (t) => {
  const setup = await fixture(t)
  const run = fakeRunner()
  let clientCreated = false
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: () => {
        clientCreated = true
      },
      env: { ...setup.env, [CAPTURE_OPT_IN_NAME]: 'yes' },
      outputDir: setup.outputDir,
      runCommand: run.runCommand,
    }),
    /EXACT_CAPTURE_OPT_IN_REQUIRED/u
  )
  assert.equal(clientCreated, false)
  assert.equal(run.calls.length, 0)
})

test('source URL is port-5432-only and requires one exact verify-full option', () => {
  const valid = validateSourceUrl(SOURCE_URL)
  assert.deepEqual(valid, {
    database: 'postgres',
    host: SOURCE_HOST,
    password: SECRET,
    port: 5432,
    user: 'capture',
  })
  assert.ok(Object.isFrozen(valid))
  assert.equal(
    validateSourceUrl(
      `postgresql://postgres.projectref:${SECRET}@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`
    ).host,
    'aws-0-us-west-1.pooler.supabase.com'
  )

  const invalid = [
    `postgresql://capture:${SECRET}@${SOURCE_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://capture:${SECRET}@${SOURCE_HOST}/postgres?sslmode=verify-full`,
    `postgresql://capture:${SECRET}@${SOURCE_HOST}:5432/postgres`,
    `postgresql://capture:${SECRET}@${SOURCE_HOST}:5432/postgres?sslmode=require`,
    `postgresql://capture:${SECRET}@${SOURCE_HOST}:5432/postgres?sslmode=verify-full&sslmode=verify-full`,
    `postgresql://capture:${SECRET}@${SOURCE_HOST}:5432/postgres?sslmode=verify-full&application_name=bypass`,
    `postgresql://capture:${SECRET}@db.example.test:5432/postgres?sslmode=verify-full`,
  ]
  for (const sourceUrl of invalid) assert.throws(() => validateSourceUrl(sourceUrl))
})

test('rejects a relative, malformed, or symlinked CA path before client creation', async (t) => {
  const setup = await fixture(t)
  const caLink = path.join(setup.root, 'ca-link.pem')
  const caParentLink = path.join(setup.root, 'ca-parent-link')
  const invalidCa = path.join(setup.root, 'invalid-ca.pem')
  const looseCa = path.join(setup.root, 'loose-ca.pem')
  await symlink(setup.caPath, caLink)
  await symlink(setup.root, caParentLink)
  await writeFile(
    invalidCa,
    '-----BEGIN CERTIFICATE-----\nNOT-A-CERTIFICATE\n-----END CERTIFICATE-----\n',
    { mode: 0o600 }
  )
  await writeFile(looseCa, `${rootCertificates[0]}\n`, { mode: 0o600 })
  await chmod(looseCa, 0o644)
  for (const caPath of [
    'relative-ca.pem',
    caLink,
    path.join(caParentLink, path.basename(setup.caPath)),
    invalidCa,
    looseCa,
  ]) {
    let clientCreated = false
    await assert.rejects(
      captureCanonicalBaseline({
        clientFactory: () => {
          clientCreated = true
        },
        env: { ...setup.env, [CAPTURE_CA_FILE_NAME]: caPath },
        outputDir: setup.outputDir,
        runCommand: fakeRunner().runCommand,
      }),
      /SOURCE_CA_/u
    )
    assert.equal(clientCreated, false)
  }
})

test('rejects an output path whose parent resolves through a symlink', async (t) => {
  const setup = await fixture(t)
  const outputParentLink = path.join(setup.root, 'captures-link')
  await symlink(setup.outputParent, outputParentLink)
  let clientCreated = false
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: () => {
        clientCreated = true
      },
      env: setup.env,
      outputDir: path.join(outputParentLink, 'capture-through-link'),
      runCommand: fakeRunner().runCommand,
    }),
    /OUTPUT_PARENT_(?:MUST_BE_REAL_DIRECTORY|MUST_NOT_USE_SYMLINKS)/u
  )
  assert.equal(clientCreated, false)
})

test('requires an owner-only output parent before touching tools or the source', async (t) => {
  const setup = await fixture(t)
  await chmod(setup.outputParent, 0o750)
  let clientCreated = false
  const runner = fakeRunner()
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: () => {
        clientCreated = true
      },
      env: setup.env,
      outputDir: setup.outputDir,
      runCommand: runner.runCommand,
    }),
    /OUTPUT_PARENT_MUST_BE_OWNER_ONLY/u
  )
  assert.equal(clientCreated, false)
  assert.equal(runner.calls.length, 0)
})

test('requires pg_dump and psql 17.6+ from one exact toolchain version', async (t) => {
  const setup = await fixture(t)
  await assert.rejects(
    inspectPg17Toolchain(
      setup.bin,
      fakeRunner({ versions: { pg_dump: '17.5', psql: '17.5' } }).runCommand,
      setup.env
    ),
    /PG17_6_OR_NEWER_REQUIRED/u
  )
  await assert.rejects(
    inspectPg17Toolchain(
      setup.bin,
      fakeRunner({ versions: { pg_dump: '17.8', psql: '17.9' } }).runCommand,
      setup.env
    ),
    /PG17_TOOLS_MUST_HAVE_EXACT_VERSION/u
  )
})

test('catalog SQL reads only pg_catalog and the one ledger query reads only its managed table', () => {
  for (const [label, sql] of Object.entries(_captureContractForTests.catalogQueries)) {
    const sources = sql
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(?:FROM|JOIN|LEFT JOIN)\s/iu.test(line))
    assert.ok(sources.length > 0, `${label} must have a catalog source`)
    for (const source of sources) {
      assert.match(source, /^(?:(?:LEFT )?JOIN|FROM) (?:pg_catalog\.|\()/iu, `${label}: ${source}`)
    }
  }
  assert.match(_captureContractForTests.ledgerQuery, /FROM supabase_migrations\.schema_migrations/u)
  assert.equal(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|COPY)\b/iu.test(_captureContractForTests.ledgerQuery),
    false
  )
})

test('captures catalog, ledger digests, and schema dump from one exported read-only snapshot', async (t) => {
  const setup = await fixture(t)
  const events = []
  let observedClientConfiguration
  const runner = fakeRunner({ events })
  const result = await captureCanonicalBaseline({
    clientFactory: fakeClient({
      events,
      onConfiguration: (configuration) => {
        observedClientConfiguration = configuration
      },
      unicodeCatalog: true,
    }),
    env: setup.env,
    outputDir: setup.outputDir,
    runCommand: runner.runCommand,
  })

  assert.equal(result.status, 'source-capture/not-a-candidate')
  assert.equal(result.postgresVersion, '17.8')
  assert.equal(observedClientConfiguration.connectionString, undefined)
  assert.equal(observedClientConfiguration.host, SOURCE_HOST)
  assert.equal(observedClientConfiguration.port, 5432)
  assert.equal(observedClientConfiguration.password, SECRET)
  assert.match(observedClientConfiguration.options, /default_transaction_read_only=on/u)
  assert.match(observedClientConfiguration.options, /search_path=pg_catalog/u)
  assert.equal(observedClientConfiguration.ssl.rejectUnauthorized, true)
  assert.equal(observedClientConfiguration.ssl.servername, SOURCE_HOST)
  assert.equal(typeof observedClientConfiguration.ssl.checkServerIdentity, 'function')
  assert.match(observedClientConfiguration.ssl.ca, /BEGIN CERTIFICATE/u)

  const beginIndex = events.findIndex((event) =>
    event.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  )
  const snapshotIndex = events.findIndex((event) => event.includes('pg_export_snapshot'))
  const ledgerIndex = events.findIndex((event) => event.includes('arena_baseline_ledger'))
  const dumpIndex = events.indexOf('spawn:pg_dump:capture')
  const rollbackIndex = events.findIndex((event) => event === 'query:ROLLBACK')
  const endIndex = events.indexOf('client:end')
  assert.ok(beginIndex >= 0)
  assert.ok(beginIndex < snapshotIndex)
  assert.ok(snapshotIndex < ledgerIndex)
  assert.ok(events.some((event) => event.includes("set_config('search_path', 'pg_catalog', true)")))
  assert.ok(events.some((event) => event.includes("set_config('TimeZone', 'UTC', true)")))
  assert.ok(ledgerIndex < dumpIndex)
  assert.ok(dumpIndex < rollbackIndex)
  assert.ok(rollbackIndex < endIndex)
  assert.equal(
    events.filter((event) => event.includes('arena_baseline_catalog:')).length,
    _captureContractForTests.catalogKeys.length
  )

  const dumpCall = runner.calls.find((call) =>
    call.args.some((argument) => argument.startsWith('--snapshot='))
  )
  assert.ok(dumpCall)
  assert.ok(dumpCall.args.includes('--snapshot=00000003-0000001B-1'))
  for (const argument of [
    '--schema-only',
    '--exclude-extension=*',
    '--no-owner',
    '--no-password',
    '--no-publications',
    '--no-security-labels',
    '--no-subscriptions',
    '--quote-all-identifiers',
    '--strict-names',
  ]) {
    assert.ok(dumpCall.args.includes(argument), `missing pg_dump argument ${argument}`)
  }
  assert.ok(dumpCall.args.includes('--schema=public'))
  assert.ok(dumpCall.args.includes('--schema=arena'))
  assert.equal(dumpCall.options.env.PGSSLMODE, 'verify-full')
  assert.equal(dumpCall.options.env.PGGSSENCMODE, 'disable')
  assert.equal(dumpCall.options.env.PGPORT, '5432')
  assert.equal(dumpCall.options.env.PGCLIENTENCODING, 'UTF8')
  assert.equal(dumpCall.options.env.PGTZ, 'UTC')
  assert.equal(path.basename(dumpCall.options.env.HOME), 'home')
  assert.equal(path.dirname(dumpCall.options.env.HOME), dumpCall.options.env.TMPDIR)
  assert.equal(path.dirname(dumpCall.options.env.PGPASSFILE), dumpCall.options.env.HOME)
  assert.match(dumpCall.options.env.PGOPTIONS, /search_path=pg_catalog/u)
  assert.equal(dumpCall.options.env.PGPASSWORD, SECRET)
  assert.notEqual(dumpCall.options.env.PGSSLROOTCERT, setup.caPath)
  assert.equal(dumpCall.options.env[CAPTURE_SOURCE_URL_NAME], undefined)
  assert.equal(dumpCall.options.env.DATABASE_URL, undefined)
  assert.equal(dumpCall.options.env.DIRECT_URL, undefined)
  assert.equal(dumpCall.options.env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(dumpCall.options.env.DYLD_INSERT_LIBRARIES, undefined)
  assert.equal(dumpCall.options.env.SUPABASE_ACCESS_TOKEN, undefined)
  for (const call of runner.calls) {
    assert.equal(
      call.args.some((argument) => argument.includes(SECRET)),
      false
    )
    assert.equal(
      call.args.some((argument) => argument.includes(SOURCE_URL)),
      false
    )
    assert.equal(call.stdout?.includes?.(SECRET) ?? false, false)
  }

  const entries = (await readdir(setup.outputDir)).sort()
  assert.deepEqual(entries, ['app-schema.sql', 'source-catalog.json'])
  for (const entry of entries) {
    assert.equal((await lstat(path.join(setup.outputDir, entry))).mode & 0o077, 0)
  }
  assert.equal(
    await readFile(path.join(setup.outputDir, 'app-schema.sql'), 'utf8'),
    NORMALIZED_DUMP
  )
  const sourceCatalogText = await readFile(
    path.join(setup.outputDir, 'source-catalog.json'),
    'utf8'
  )
  assert.equal(sourceCatalogText.includes('SUPER_SECRET_STATEMENT_TEXT'), false)
  assert.equal(sourceCatalogText.includes(SOURCE_URL), false)
  const sourceCatalog = JSON.parse(sourceCatalogText)
  assert.equal(sourceCatalog.contract, SOURCE_CATALOG_CONTRACT)
  assert.equal(sourceCatalog.postgresMajor, 17)
  assert.equal(sourceCatalog.capturedAt, '2026-08-04T12:34:56.789Z')
  assert.equal(sourceCatalog.ledger.length, 1)
  assert.match(sourceCatalog.ledger[0].statementsSha256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(
    Object.keys(sourceCatalog.catalog).sort(),
    [..._captureContractForTests.catalogKeys].sort()
  )
  assert.deepEqual(
    sourceCatalog.catalog.functions.map((row) => row.name),
    ['z', 'ä']
  )
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
})

test('an output directory that appears during capture is never overwritten or removed', async (t) => {
  for (const scenario of ['empty', 'nonempty']) {
    await t.test(scenario, async (subtest) => {
      const setup = await fixture(subtest)
      const events = []
      const runner = fakeRunner({ events })
      const sentinel = path.join(setup.outputDir, 'concurrent-owner.txt')
      let appearedIdentity = null
      const runCommand = async (command, args, options) => {
        const result = await runner.runCommand(command, args, options)
        if (args.some((argument) => argument.startsWith('--snapshot='))) {
          await mkdir(setup.outputDir, { mode: 0o700 })
          if (scenario === 'nonempty') {
            await writeFile(sentinel, 'must survive\n', { mode: 0o600 })
          }
          const metadata = await lstat(setup.outputDir)
          appearedIdentity = { dev: metadata.dev, ino: metadata.ino }
        }
        return result
      }

      await assert.rejects(
        captureCanonicalBaseline({
          clientFactory: fakeClient({ events }),
          env: setup.env,
          outputDir: setup.outputDir,
          runCommand,
        }),
        /OUTPUT_DIR_APPEARED_DURING_CAPTURE/u
      )
      const afterMetadata = await lstat(setup.outputDir)
      assert.deepEqual({ dev: afterMetadata.dev, ino: afterMetadata.ino }, appearedIdentity)
      assert.deepEqual(
        await readdir(setup.outputDir),
        scenario === 'nonempty' ? ['concurrent-owner.txt'] : []
      )
      if (scenario === 'nonempty') {
        assert.equal(await readFile(sentinel, 'utf8'), 'must survive\n')
      }
      assert.equal(
        (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
        false
      )
    })
  }
})

test('invalid captured SQL fails closed and removes all staging without publishing', async (t) => {
  const setup = await fixture(t)
  const events = []
  const runner = fakeRunner({
    dumpContents: VALID_DUMP.replace(
      'CREATE TABLE public.example (id bigint PRIMARY KEY);',
      'COPY public.example FROM STDIN;'
    ),
    events,
  })
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      runCommand: runner.runCommand,
    }),
    /COPY|restriction|safe SQL/u
  )
  await assert.rejects(readFile(path.join(setup.outputDir, 'app-schema.sql')))
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
  assert.ok(events.some((event) => event === 'query:ROLLBACK'))
  assert.ok(events.includes('client:end'))
})

test('public schema normalization requires the one exact PG17 quoted statement', () => {
  assert.equal(
    _captureContractForTests.normalizeTargetProvidedPublicSchema(VALID_DUMP),
    NORMALIZED_DUMP
  )
  assert.throws(
    () =>
      _captureContractForTests.normalizeTargetProvidedPublicSchema(
        VALID_DUMP.replace('CREATE SCHEMA "public";\n', '')
      ),
    /APP_SCHEMA_REQUIRES_EXACTLY_ONE_PUBLIC_SCHEMA_CREATE/u
  )
  assert.throws(
    () =>
      _captureContractForTests.normalizeTargetProvidedPublicSchema(
        VALID_DUMP.replace(
          'CREATE SCHEMA "public";',
          'CREATE SCHEMA "public";\nCREATE SCHEMA "public";'
        )
      ),
    /APP_SCHEMA_REQUIRES_EXACTLY_ONE_PUBLIC_SCHEMA_CREATE/u
  )
})

test('credential-like function definitions fail closed before source catalog publication', async (t) => {
  const credentialLikeValues = [
    'https://projectref.supabase.co/rest/v1',
    'AKIAABCDEFGHIJKLMNOP',
    'https://hooks.slack.com/services/example',
    '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH',
  ]
  for (const credentialLikeValue of credentialLikeValues) {
    await t.test(credentialLikeValue.split(':')[0], async () => {
      const setup = await fixture(t)
      const events = []
      await assert.rejects(
        captureCanonicalBaseline({
          clientFactory: fakeClient({ credentialCatalog: credentialLikeValue, events }),
          env: setup.env,
          outputDir: setup.outputDir,
          runCommand: fakeRunner({ events }).runCommand,
        }),
        /SOURCE_CATALOG_CONTAINS_CREDENTIAL_LIKE_DATA/u
      )
      await assert.rejects(readdir(setup.outputDir))
      assert.equal(
        (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
        false
      )
      assert.ok(events.some((event) => event === 'query:ROLLBACK'))
    })
  }
})

test('the exact source URL, host, and password cannot enter either artifact', async (t) => {
  for (const scenario of ['catalog password', 'schema password']) {
    await t.test(scenario, async () => {
      const setup = await fixture(t)
      const events = []
      const dumpContents =
        scenario === 'schema password'
          ? VALID_DUMP.replace(
              `\\unrestrict ${DUMP_TOKEN}`,
              `COMMENT ON TABLE public.example IS '${SECRET}';\n\\unrestrict ${DUMP_TOKEN}`
            )
          : VALID_DUMP
      await assert.rejects(
        captureCanonicalBaseline({
          clientFactory: fakeClient({
            credentialCatalog: scenario === 'catalog password' ? SECRET : null,
            events,
          }),
          env: setup.env,
          outputDir: setup.outputDir,
          runCommand: fakeRunner({ dumpContents, events }).runCommand,
        }),
        /(?:APP_SCHEMA|SOURCE_CATALOG)_CONTAINS_SOURCE_CONNECTION_DATA/u
      )
      await assert.rejects(readdir(setup.outputDir))
    })
  }
})

test('CLI error classification never exposes uppercase remote error messages', () => {
  assert.equal(
    _captureContractForTests.safeCliErrorCode(new Error('REMOTE_DATABASE_SECRET_ABC123')),
    'CAPTURE_FAILED'
  )
  assert.equal(
    _captureContractForTests.safeCliErrorCode(new Error('CAPTURE_CLEANUP_FAILED')),
    'CAPTURE_CLEANUP_FAILED'
  )
})

test('a closed stdout pipe cannot turn a committed CLI result into an error exit', async () => {
  const moduleUrl = new URL('./capture-canonical-baseline.mjs', import.meta.url).href
  const script = `
    import { runCli } from ${JSON.stringify(moduleUrl)}
    const code = await runCli({
      argv: ['--output-dir', '/unused-by-committed-stub'],
      captureBaseline: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { artifactCount: 2 }
      },
    })
    process.exitCode = code
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.destroy()
  const [code, signal] = await once(child, 'close')
  assert.equal(code, 0, stderr)
  assert.equal(signal, null)
  assert.equal(stderr, '')
})

test('malformed or duplicate modern ledger rows fail before pg_dump and publication', async (t) => {
  const invalidLedgers = [
    [
      {
        name: 'invalid_statements',
        statements: [null],
        version: '20260804000000',
      },
    ],
    [
      { name: 'one', statements: [], version: '20260804000000' },
      { name: 'two', statements: [], version: '20260804000000' },
    ],
    [{ name: 'legacy_only', statements: [], version: '001' }],
  ]
  for (const ledgerRows of invalidLedgers) {
    await t.test(ledgerRows[0].name, async () => {
      const setup = await fixture(t)
      const events = []
      const runner = fakeRunner({ events })
      await assert.rejects(
        captureCanonicalBaseline({
          clientFactory: fakeClient({ events, ledgerRows }),
          env: setup.env,
          outputDir: setup.outputDir,
          runCommand: runner.runCommand,
        }),
        /CAPTURE_LEDGER_/u
      )
      assert.equal(events.includes('spawn:pg_dump:capture'), false)
      await assert.rejects(readdir(setup.outputDir))
    })
  }
})

test('nullable reconciled ledger statements remain distinct from an observed empty array', async (t) => {
  const setup = await fixture(t)
  const ledgerRows = [
    { name: 'reconciled_without_body', statements: null, version: '00057' },
    { name: 'observed_empty_body', statements: [], version: '20260804000000' },
  ]
  await captureCanonicalBaseline({
    clientFactory: fakeClient({ ledgerRows }),
    env: setup.env,
    outputDir: setup.outputDir,
    runCommand: fakeRunner().runCommand,
  })

  const sourceCatalog = JSON.parse(
    await readFile(path.join(setup.outputDir, 'source-catalog.json'), 'utf8')
  )
  const digest = (value) =>
    createHash('sha256')
      .update(JSON.stringify({ kind: 'sql-statements', value }))
      .digest('hex')
  assert.deepEqual(sourceCatalog.ledger, [
    {
      name: 'observed_empty_body',
      statementsSha256: digest([]),
      version: '20260804000000',
    },
    {
      name: 'reconciled_without_body',
      statementsSha256: digest(null),
      version: '00057',
    },
  ])
  assert.notEqual(
    sourceCatalog.ledger[0].statementsSha256,
    sourceCatalog.ledger[1].statementsSha256
  )
})

test('catalog or pg_dump failure rolls back and leaves neither output nor temp roots', async (t) => {
  for (const failure of ['catalog', 'pg_dump']) {
    await t.test(failure, async () => {
      const setup = await fixture(t)
      const events = []
      const runner = fakeRunner({ dumpExitCode: failure === 'pg_dump' ? 1 : 0, events })
      await assert.rejects(
        captureCanonicalBaseline({
          clientFactory: fakeClient({ events, failCatalog: failure === 'catalog' }),
          env: setup.env,
          outputDir: setup.outputDir,
          runCommand: runner.runCommand,
        }),
        (error) => {
          assert.equal(error.message.includes(SECRET), false)
          assert.equal(error.message.includes(SOURCE_URL), false)
          return true
        }
      )
      await assert.rejects(readdir(setup.outputDir))
      assert.equal(
        (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
        false
      )
      assert.ok(events.some((event) => event === 'query:ROLLBACK'))
      assert.ok(events.includes('client:end'))
    })
  }
})

test('the real child-process runner bounds a hung pg_dump and cleans the exported snapshot', async (t) => {
  const setup = await fixture(t)
  const tool = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' "PostgreSQL 17.8"
  exit 0
fi
trap '' TERM
exec /bin/sleep 10
`
  for (const name of ['pg_dump', 'psql']) {
    await writeFile(path.join(setup.bin, name), tool)
    await chmod(path.join(setup.bin, name), 0o700)
  }
  const events = []
  const startedAt = Date.now()
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      pgDumpTimeoutMs: 50,
      toolKillGraceMs: 50,
    }),
    /PG_DUMP_SCHEMA_CAPTURE_FAILED/u
  )
  assert.ok(Date.now() - startedAt >= 80)
  assert.ok(Date.now() - startedAt < 2_000)
  await assert.rejects(readdir(setup.outputDir))
  assert.ok(events.some((event) => event === 'query:ROLLBACK'))
  assert.ok(events.includes('client:end'))
})

test('an abort signal terminates capture through the same rollback and cleanup path', async (t) => {
  const setup = await fixture(t)
  const events = []
  const controller = new AbortController()
  const baseRunner = fakeRunner({ events })
  const runCommand = async (command, args, options) => {
    if (args.length === 1 && args[0] === '--version') {
      return baseRunner.runCommand(command, args, options)
    }
    return new Promise((resolve) => {
      options.signal.addEventListener(
        'abort',
        () =>
          resolve({
            code: 1,
            overflow: false,
            signal: 'SIGTERM',
            stderr: '',
            stdout: '',
            timedOut: false,
          }),
        { once: true }
      )
      setTimeout(() => controller.abort(), 5)
    })
  }
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      runCommand,
      signal: controller.signal,
    }),
    /CAPTURE_INTERRUPTED/u
  )
  await assert.rejects(readdir(setup.outputDir))
  // Abort owns one disconnect; PostgreSQL rolls the open read-only transaction
  // back as part of closing the session, so cleanup must not race a second end.
  assert.equal(events.filter((event) => event === 'client:end').length, 1)
})

test('an abort during error rollback reuses the one client close promise', async (t) => {
  const setup = await fixture(t)
  const events = []
  const controller = new AbortController()
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({
        events,
        onRollback: async () => {
          controller.abort()
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { rows: [] }
        },
      }),
      env: setup.env,
      outputDir: setup.outputDir,
      runCommand: fakeRunner({ dumpExitCode: 1, events }).runCommand,
      signal: controller.signal,
    }),
    /PG_DUMP_SCHEMA_CAPTURE_FAILED/u
  )
  assert.equal(events.filter((event) => event === 'client:end').length, 1)
  await assert.rejects(readdir(setup.outputDir))
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
})

test('a real child that ignores SIGTERM is killed and closed before abort cleanup returns', async (t) => {
  const setup = await fixture(t)
  const markerPath = path.join(setup.root, 'pg-dump.pid')
  const quotedMarkerPath = `'${markerPath.replaceAll("'", "'\\''")}'`
  const pgDumpTool = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' "PostgreSQL 17.8"
  exit 0
fi
trap '' TERM
printf '%s\n' "$$" > ${quotedMarkerPath}
exec /bin/sleep 10
`
  const psqlTool = `#!/bin/sh
printf '%s\n' "PostgreSQL 17.8"
`
  await writeFile(path.join(setup.bin, 'pg_dump'), pgDumpTool)
  await writeFile(path.join(setup.bin, 'psql'), psqlTool)
  await chmod(path.join(setup.bin, 'pg_dump'), 0o700)
  await chmod(path.join(setup.bin, 'psql'), 0o700)

  const events = []
  const controller = new AbortController()
  const capture = captureCanonicalBaseline({
    clientFactory: fakeClient({ events }),
    env: setup.env,
    outputDir: setup.outputDir,
    pgDumpTimeoutMs: 5_000,
    signal: controller.signal,
    toolKillGraceMs: 50,
  })

  let childPid = null
  const markerDeadline = Date.now() + 5_000
  while (Date.now() < markerDeadline) {
    try {
      childPid = Number((await readFile(markerPath, 'utf8')).trim())
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1)
  const abortedAt = Date.now()
  controller.abort()
  await assert.rejects(capture, /CAPTURE_INTERRUPTED/u)
  assert.ok(Date.now() - abortedAt >= 40)
  assert.throws(
    () => process.kill(childPid, 0),
    (error) => error?.code === 'ESRCH'
  )
  assert.equal(events.filter((event) => event === 'client:end').length, 1)
  await assert.rejects(readdir(setup.outputDir))
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
})

test('an abort during runtime cleanup cannot cross the final publish gate', async (t) => {
  const setup = await fixture(t)
  const controller = new AbortController()
  const events = []
  const removeTemporaryRoot = async (target, destination, identity) => {
    await _captureContractForTests.safeRemove(target, destination, identity)
    if (target && path.basename(target).startsWith('.arena-baseline-capture-runtime-')) {
      controller.abort()
    }
  }

  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      removeTemporaryRoot,
      runCommand: fakeRunner({ events }).runCommand,
      signal: controller.signal,
    }),
    /CAPTURE_INTERRUPTED/u
  )
  await assert.rejects(readdir(setup.outputDir))
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
})

test('a signal after the final gate loses to a successful marker commit', async (t) => {
  const setup = await fixture(t)
  const controller = new AbortController()
  const result = await captureCanonicalBaseline({
    clientFactory: fakeClient(),
    commitOutputMarker: async (markerPath) => {
      controller.abort()
      await unlink(markerPath)
    },
    env: setup.env,
    outputDir: setup.outputDir,
    runCommand: fakeRunner().runCommand,
    signal: controller.signal,
  })

  assert.equal(result.status, 'source-capture/not-a-candidate')
  assert.deepEqual((await readdir(setup.outputDir)).sort(), [
    'app-schema.sql',
    'source-catalog.json',
  ])
  assert.equal(_captureContractForTests.directExitCode(0, 'SIGTERM'), 0)
  assert.equal(_captureContractForTests.directExitCode(2, 'SIGINT'), 130)
  assert.equal(_captureContractForTests.directExitCode(2, 'SIGTERM'), 143)
})

test('a failed marker commit removes the owned partial output without publishing', async (t) => {
  const setup = await fixture(t)
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient(),
      commitOutputMarker: async () => {
        throw new Error('simulated marker commit failure')
      },
      env: setup.env,
      outputDir: setup.outputDir,
      runCommand: fakeRunner().runCommand,
    }),
    /simulated marker commit failure/u
  )
  await assert.rejects(readdir(setup.outputDir))
  assert.equal(
    (await readdir(setup.outputParent)).some((name) => name.startsWith('.arena-')),
    false
  )
})

test('cleanup preserves a temporary root whose inode was replaced', async (t) => {
  const setup = await fixture(t)
  const events = []
  let replacementPath = null
  let swapped = false
  const removeTemporaryRoot = async (target, destination, identity) => {
    if (!swapped && path.basename(target).startsWith('.arena-baseline-capture-runtime-')) {
      swapped = true
      replacementPath = target
      await rm(target, { force: true, recursive: true })
      await mkdir(target, { mode: 0o700 })
      await writeFile(path.join(target, 'replacement-owner.txt'), 'preserve\n', { mode: 0o600 })
    }
    await _captureContractForTests.safeRemove(target, destination, identity)
  }

  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      removeTemporaryRoot,
      runCommand: fakeRunner({ events }).runCommand,
    }),
    /CAPTURE_CLEANUP_FAILED/u
  )
  assert.equal(
    await readFile(path.join(replacementPath, 'replacement-owner.txt'), 'utf8'),
    'preserve\n'
  )
  await assert.rejects(readdir(setup.outputDir))
})

test('cleanup failure is explicit and never replaced with the child-process error text', async (t) => {
  const setup = await fixture(t)
  const events = []
  await assert.rejects(
    captureCanonicalBaseline({
      clientFactory: fakeClient({ events }),
      env: setup.env,
      outputDir: setup.outputDir,
      removeTemporaryRoot: async () => {
        throw new Error(`cleanup failed near ${SECRET}`)
      },
      runCommand: fakeRunner({ dumpExitCode: 1, events }).runCommand,
    }),
    (error) => {
      assert.equal(error.message, 'CAPTURE_CLEANUP_FAILED')
      assert.equal(error.message.includes(SECRET), false)
      return true
    }
  )
  assert.ok(events.some((event) => event === 'query:ROLLBACK'))
  assert.ok(events.includes('client:end'))
})

test(
  'real PostgreSQL 17 catalog and dump semantics are available as an explicit local check',
  { skip: process.env.ARENA_REAL_BASELINE_CAPTURE_PG17_TEST !== '1' },
  async () => {
    const pgBin = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
    const shortTempParent = await realpath('/tmp')
    const root = await realpath(await mkdtemp(path.join(shortTempParent, 'arena-capture-pg17-')))
    const dataDir = path.join(root, 'data')
    const socketDir = path.join(root, 'socket')
    const privateHome = path.join(root, 'home')
    const dumpPath = path.join(root, 'app-schema.sql')
    await mkdir(socketDir, { mode: 0o700 })
    await mkdir(privateHome, { mode: 0o700 })

    const run = (name, args, options = {}) =>
      spawnSync(path.join(pgBin, name), args, {
        encoding: 'utf8',
        env: { HOME: privateHome, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        ...options,
      })
    let client = null
    let startAttempted = false
    let serverStarted = false
    let preserve = false
    try {
      const init = run('initdb', [
        '-D',
        dataDir,
        '-U',
        'postgres',
        '--auth=trust',
        '--no-locale',
        '--encoding=UTF8',
      ])
      assert.equal(init.status, 0, init.stderr)
      startAttempted = true
      const start = run('pg_ctl', [
        '-D',
        dataDir,
        '-l',
        path.join(root, 'postgres.log'),
        '-o',
        `-F -k ${socketDir} -p 5432 -c listen_addresses=''`,
        '-w',
        'start',
      ])
      assert.equal(start.status, 0, start.stderr)
      serverStarted = true

      client = new pg.Client({
        database: 'postgres',
        host: socketDir,
        port: 5432,
        user: 'postgres',
      })
      await client.connect()
      for (const statement of [
        'CREATE SCHEMA arena',
        'CREATE TABLE public.app_table(id integer PRIMARY KEY, payload text)',
        'CREATE TABLE arena.scope_table(id integer PRIMARY KEY)',
        'CREATE TYPE arena.composite_v1 AS (id bigint, label text)',
        'CREATE DOMAIN arena.positive_int AS integer DEFAULT 1 CHECK (VALUE > 0)',
        "CREATE TYPE public.mood AS ENUM ('calm', 'alert')",
        'CREATE EXTENSION pgcrypto WITH SCHEMA public',
        'CREATE PUBLICATION relation_pub FOR TABLE public.app_table (id) WHERE (id > 0) WITH (publish_via_partition_root = true)',
        'CREATE PUBLICATION schema_pub FOR TABLES IN SCHEMA arena',
        'CREATE PUBLICATION all_pub FOR ALL TABLES',
      ]) {
        await client.query(statement)
      }
      await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)")

      const catalog = {}
      for (const key of _captureContractForTests.catalogKeys) {
        const values = key === 'extensions' ? [] : [_captureContractForTests.appSchemas]
        catalog[key] = (
          await client.query(_captureContractForTests.catalogQueries[key], values)
        ).rows
      }
      validateSourceCatalogRowContracts(catalog)

      assert.deepEqual(catalog.publications.map((row) => row.membershipKind).sort(), [
        'allTables',
        'relation',
        'schema',
      ])
      const relationPublication = catalog.publications.find(
        (row) => row.membershipKind === 'relation'
      )
      assert.deepEqual(relationPublication.columns, ['id'])
      assert.equal(relationPublication.rowFilter, 'id > 0')
      assert.equal(relationPublication.viaPartitionRoot, true)
      assert.ok(
        catalog.constraints.some(
          (row) => row.objectKind === 'domain' && row.domain === 'positive_int'
        )
      )
      assert.deepEqual(catalog.types.map((row) => `${row.schema}.${row.name}`).sort(), [
        'arena.composite_v1',
        'arena.positive_int',
        'public.mood',
      ])
      assert.equal(
        catalog.types.find((row) => row.name === 'composite_v1').compositeAttributes.length,
        2
      )

      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const snapshotId = (await client.query('SELECT pg_catalog.pg_export_snapshot() AS id'))
        .rows[0].id
      const dump = run('pg_dump', [
        ..._captureContractForTests.pgDumpArguments(snapshotId, dumpPath),
        `--host=${socketDir}`,
        '--port=5432',
        '--username=postgres',
        '--dbname=postgres',
      ])
      assert.equal(dump.status, 0, dump.stderr)
      const rawDump = await readFile(dumpPath, 'utf8')
      assert.equal(
        rawDump.split('\n').filter((line) => line === 'CREATE SCHEMA "public";').length,
        1
      )
      assert.equal(rawDump.includes('CREATE PUBLICATION'), false)
      assert.equal(rawDump.includes('CREATE EXTENSION'), false)
      const normalizedDump = _captureContractForTests.normalizeTargetProvidedPublicSchema(rawDump)
      assert.equal(normalizedDump.includes('CREATE SCHEMA "public";'), false)
      validateAppSchemaSqlSafety(normalizedDump, { label: 'real PG17 captured app-schema.sql' })
      await client.query('ROLLBACK')
    } finally {
      await client?.end().catch(() => undefined)
      if (startAttempted) {
        const stop = run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'])
        if (stop.status === 0) {
          serverStarted = false
        } else {
          const status = run('pg_ctl', ['-D', dataDir, 'status'])
          preserve = status.status === 0 || status.error !== undefined
        }
      }
      if (serverStarted || preserve) {
        process.stderr.write(`Real PG17 capture check preserved uncertain state at ${root}\n`)
      } else {
        await rm(root, { force: true, recursive: true })
      }
    }
  }
)
