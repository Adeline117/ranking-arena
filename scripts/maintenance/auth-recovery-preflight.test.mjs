import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import { promisify } from 'node:util'

import pg from 'pg'

import {
  AUTH_RECOVERY_PREFLIGHT_CONTRACT,
  assessDatabase,
  buildCatalogFingerprint,
  buildForeignKeyOrphanSql,
  classifyAuthTable,
  compareSourceAndTarget,
  inspectDatabase,
  quoteIdentifier,
  runCli,
  validateExplicitDatabaseUrl,
} from './auth-recovery-preflight.mjs'

const execFileAsync = promisify(execFile)

function fixtureColumn(name, dataType = 'uuid', ordinal = 1) {
  return {
    name,
    ordinal,
    data_type: dataType,
    not_null: true,
    identity_kind: '',
    generated_kind: '',
    has_default: false,
    default_fingerprint: null,
  }
}

function fixtureTable(name, overrides = {}) {
  const { classification, managed_excluded: managedExcluded } = classifyAuthTable(name)
  return {
    name,
    owner: 'supabase_auth_admin',
    kind: 'table',
    rls_enabled: false,
    force_rls: false,
    can_select: true,
    row_count: '0',
    classification,
    managed_excluded: managedExcluded,
    columns: [fixtureColumn('id')],
    constraints: [
      {
        name: `${name}_pkey`,
        type: 'primary_key',
        columns: ['id'],
        definition_fingerprint: 'fixture-primary-key-fingerprint',
        deferrable: false,
        initially_deferred: false,
        validated: true,
      },
    ],
    ...overrides,
  }
}

function fixtureForeignKey(overrides = {}) {
  return {
    name: 'identities_user_id_fkey',
    source_schema: 'auth',
    source_table: 'identities',
    source_columns: ['user_id'],
    target_schema: 'auth',
    target_table: 'users',
    target_columns: ['id'],
    match_type: 'simple',
    update_action: 'no_action',
    delete_action: 'cascade',
    deferrable: false,
    initially_deferred: false,
    validated: true,
    source_can_select: true,
    target_can_select: true,
    orphan_count: '0',
    ...overrides,
  }
}

function fixtureDatabase(overrides = {}) {
  const schemaMigrations = fixtureTable('schema_migrations', {
    row_count: '1',
    columns: [fixtureColumn('version', 'text')],
  })
  const users = fixtureTable('users', { row_count: '3' })
  const identities = fixtureTable('identities', {
    row_count: '3',
    columns: [fixtureColumn('id'), fixtureColumn('user_id', 'uuid', 2)],
  })
  return {
    postgres: {
      server_version: '17.8',
      server_version_num: '170008',
      major_version: 17,
      transaction_read_only: true,
    },
    backup_role: {
      can_select_all_auth_tables: true,
      bypass_rls: true,
      rls_visibility_complete: true,
    },
    auth: {
      classification_version: 'auth-account-recovery.v1',
      tables: [identities, schemaMigrations, users],
      foreign_keys: [fixtureForeignKey()],
      managed_migration_ledger: {
        row_count: '1',
        content_fingerprint: 'a'.repeat(64),
      },
    },
    app_to_auth_users: { foreign_keys: [] },
    ...overrides,
  }
}

test('classifies reviewed auth tables and leaves new tables unknown', () => {
  assert.deepEqual(classifyAuthTable('users'), {
    classification: 'durable',
    managed_excluded: false,
  })
  assert.deepEqual(classifyAuthTable('sessions'), {
    classification: 'ephemeral',
    managed_excluded: false,
  })
  assert.deepEqual(classifyAuthTable('schema_migrations'), {
    classification: 'ephemeral',
    managed_excluded: true,
  })
  assert.deepEqual(classifyAuthTable('future_auth_table'), {
    classification: 'unknown',
    managed_excluded: false,
  })
})

test('quotes catalog identifiers and rejects invalid values', () => {
  assert.equal(quoteIdentifier('odd"name'), '"odd""name"')
  assert.throws(() => quoteIdentifier(''), /INVALID_CATALOG_IDENTIFIER/)
  assert.throws(() => quoteIdentifier('bad\0name'), /INVALID_CATALOG_IDENTIFIER/)
})

test('catalog fingerprint is deterministic and excludes row counts and privileges', () => {
  const database = fixtureDatabase()
  const first = buildCatalogFingerprint({
    tables: database.auth.tables,
    auth_foreign_keys: database.auth.foreign_keys,
  })
  const second = buildCatalogFingerprint({
    tables: database.auth.tables
      .map((table) => ({ ...table, row_count: '999', can_select: false }))
      .reverse(),
    auth_foreign_keys: database.auth.foreign_keys.map((foreignKey) => ({
      ...foreignKey,
      orphan_count: '999',
      source_can_select: false,
    })),
  })
  assert.equal(first, second)

  const driftedTables = database.auth.tables.map((table) =>
    table.name === 'users'
      ? { ...table, columns: [...table.columns, fixtureColumn('drifted', 'text', 2)] }
      : table
  )
  assert.notEqual(
    first,
    buildCatalogFingerprint({
      tables: driftedTables,
      auth_foreign_keys: database.auth.foreign_keys,
    })
  )
})

test('builds aggregate-only orphan SQL for simple and full foreign keys', () => {
  const simple = buildForeignKeyOrphanSql(fixtureForeignKey())
  assert.match(simple, /^SELECT pg_catalog\.count\(\*\)::text AS orphan_count/)
  assert.match(simple, /FROM "auth"\."identities" AS source_row/)
  assert.match(simple, /FROM "auth"\."users" AS target_row/)
  assert.doesNotMatch(simple, /SELECT \*/)

  const full = buildForeignKeyOrphanSql(
    fixtureForeignKey({
      source_columns: ['tenant_id', 'user_id'],
      target_columns: ['tenant_id', 'id'],
      match_type: 'full',
    })
  )
  assert.match(full, /NOT \(source_row\."tenant_id" IS NOT NULL AND/)
  assert.throws(
    () => buildForeignKeyOrphanSql(fixtureForeignKey({ target_columns: [] })),
    /INVALID_FOREIGN_KEY_SHAPE/
  )
})

test('fails closed for unknown non-empty tables, denied SELECT, RLS and orphans', () => {
  const unknown = fixtureTable('future_auth_table', { row_count: '1' })
  const denied = fixtureTable('mfa_factors', {
    can_select: false,
    row_count: null,
    rls_enabled: true,
  })
  const appForeignKey = fixtureForeignKey({
    name: 'profiles_id_fkey',
    source_schema: 'public',
    source_table: 'profiles',
    source_rls_enabled: true,
    orphan_count: '2',
  })
  const database = fixtureDatabase({
    backup_role: {
      can_select_all_auth_tables: false,
      bypass_rls: false,
      rls_visibility_complete: false,
    },
    auth: {
      classification_version: 'auth-account-recovery.v1',
      tables: [...fixtureDatabase().auth.tables, denied, unknown],
      foreign_keys: [fixtureForeignKey()],
    },
    app_to_auth_users: { foreign_keys: [appForeignKey] },
  })
  const assessed = assessDatabase(database)
  const codes = new Set(assessed.failures.map((entry) => entry.code))
  assert.equal(assessed.safe, false)
  assert.ok(codes.has('UNKNOWN_AUTH_TABLE_NONEMPTY'))
  assert.ok(codes.has('AUTH_TABLE_SELECT_DENIED'))
  assert.ok(codes.has('AUTH_RLS_VISIBILITY_UNPROVEN'))
  assert.ok(codes.has('FOREIGN_KEY_RLS_VISIBILITY_UNPROVEN'))
  assert.ok(codes.has('FOREIGN_KEY_ORPHANS_PRESENT'))
})

test('target comparison detects column drift and a non-empty restore target', () => {
  const source = assessDatabase(fixtureDatabase())
  const targetDatabase = fixtureDatabase()
  targetDatabase.auth.tables = targetDatabase.auth.tables.map((table) => {
    if (table.name === 'users') {
      return {
        ...table,
        row_count: '1',
        columns: [...table.columns, fixtureColumn('target_only', 'text', 2)],
      }
    }
    return { ...table, row_count: '0' }
  })
  const target = assessDatabase(targetDatabase, 'target')
  const comparison = compareSourceAndTarget(source, target)
  const codes = new Set(comparison.failures.map((entry) => entry.code))
  assert.equal(comparison.status, 'incompatible')
  assert.ok(codes.has('TARGET_AUTH_COLUMN_DRIFT'))
  assert.ok(codes.has('TARGET_AUTH_CATALOG_MISMATCH'))
  assert.ok(codes.has('TARGET_AUTH_TABLE_NOT_EMPTY'))
})

test('target comparison binds the managed migration ledger and app-to-auth foreign keys', () => {
  const appForeignKey = fixtureForeignKey({
    name: 'profiles_id_fkey',
    source_schema: 'public',
    source_table: 'profiles',
  })
  const source = assessDatabase({
    ...fixtureDatabase(),
    app_to_auth_users: { foreign_keys: [appForeignKey] },
  })
  const target = assessDatabase({
    ...fixtureDatabase(),
    auth: {
      ...fixtureDatabase().auth,
      managed_migration_ledger: {
        row_count: '1',
        content_fingerprint: 'b'.repeat(64),
      },
    },
    app_to_auth_users: { foreign_keys: [] },
  })
  const comparison = compareSourceAndTarget(source, target)
  const codes = new Set(comparison.failures.map((entry) => entry.code))

  assert.equal(comparison.status, 'incompatible')
  assert.ok(codes.has('TARGET_AUTH_MIGRATION_LEDGER_DRIFT'))
  assert.ok(codes.has('TARGET_APP_AUTH_FOREIGN_KEY_DRIFT'))
  assert.ok(codes.has('TARGET_AUTH_CATALOG_MISMATCH'))
})

test('requires only the explicit source variable and emits JSON on configuration failure', async () => {
  let output = ''
  const code = await runCli({
    env: { DATABASE_URL: 'postgresql://must-not-be-used.invalid/database' },
    clientFactory: () => assert.fail('missing explicit source must not create a client'),
    write: (value) => {
      output += value
    },
  })
  assert.equal(code, 2)
  const parsed = JSON.parse(output)
  assert.equal(parsed.contract, AUTH_RECOVERY_PREFLIGHT_CONTRACT)
  assert.equal(parsed.safe_to_capture_auth_data, false)
  assert.equal(parsed.safe_to_attempt_scratch_restore, null)
  assert.equal(parsed.restore_certified, false)
  assert.equal(parsed.safe_to_restore, null)
  assert.equal(parsed.failures[0].code, 'SOURCE_DATABASE_URL_REQUIRED')
  assert.doesNotMatch(output, /must-not-be-used/)
})

test('requires TLS for remote URLs but permits an explicit local PG17 fixture URL', () => {
  assert.equal(
    validateExplicitDatabaseUrl('postgresql://reader@127.0.0.1:5432/source', 'SOURCE_DATABASE_URL'),
    'postgresql://reader@127.0.0.1:5432/source'
  )
  assert.throws(
    () =>
      validateExplicitDatabaseUrl('postgresql://reader@example.com/source', 'SOURCE_DATABASE_URL'),
    /SOURCE_DATABASE_URL_TLS_REQUIRED/
  )
  assert.doesNotThrow(() =>
    validateExplicitDatabaseUrl(
      'postgresql://reader@example.com/source?sslmode=verify-full',
      'SOURCE_DATABASE_URL'
    )
  )
  assert.throws(
    () =>
      validateExplicitDatabaseUrl(
        'postgresql://reader@example.com/source?sslmode=require&host=elsewhere',
        'SOURCE_DATABASE_URL'
      ),
    /SOURCE_DATABASE_URL_AMBIGUOUS/
  )
})

function findPg17BinDirectory() {
  const candidates = [
    process.env.PG17_BINDIR,
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/lib/postgresql/17/bin',
  ].filter(Boolean)
  for (const directory of candidates) {
    try {
      accessSync(join(directory, 'initdb'), constants.X_OK)
      const version = execFileSync(join(directory, 'postgres'), ['--version'], {
        encoding: 'utf8',
      })
      if (/PostgreSQL\) 17\./.test(version)) return directory
    } catch {
      // Try the next known PostgreSQL 17 installation.
    }
  }
  return null
}

async function reserveTcpPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()))
  })
  if (!port) throw new Error('could not reserve a PostgreSQL fixture port')
  return port
}

async function query(connectionString, sql) {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

async function createAuthSchema(connectionString) {
  await query(
    connectionString,
    `
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      CREATE TABLE auth.schema_migrations(version text PRIMARY KEY);
      CREATE TABLE auth.users(
        id uuid PRIMARY KEY,
        email text,
        encrypted_password text
      );
      CREATE TABLE auth.identities(
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
      );
      CREATE TABLE auth.future_auth_table(id uuid PRIMARY KEY);
      ALTER TABLE auth.schema_migrations OWNER TO supabase_auth_admin;
      ALTER TABLE auth.users OWNER TO supabase_auth_admin;
      ALTER TABLE auth.identities OWNER TO supabase_auth_admin;
      ALTER TABLE auth.future_auth_table OWNER TO supabase_auth_admin;
      GRANT USAGE ON SCHEMA auth TO backup_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA auth TO backup_reader;
    `
  )
}

async function createAppAuthForeignKey(connectionString) {
  await query(
    connectionString,
    `
      CREATE TABLE public.user_profiles(
        id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
      );
      GRANT SELECT ON public.user_profiles TO backup_reader;
    `
  )
}

test('PG17 fixture proves read-only counts, privacy, orphan and target-drift gates', async (t) => {
  const binDirectory = findPg17BinDirectory()
  if (!binDirectory) {
    t.skip('PostgreSQL 17 server binaries are unavailable')
    return
  }

  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'arena-auth-preflight-pg17-'))
  const dataDirectory = join(fixtureDirectory, 'data')
  const port = await reserveTcpPort()
  let started = false
  t.after(async () => {
    if (started) {
      await execFileAsync(join(binDirectory, 'pg_ctl'), [
        '-D',
        dataDirectory,
        '-m',
        'immediate',
        '-w',
        'stop',
      ]).catch(() => undefined)
    }
    await rm(fixtureDirectory, { force: true, recursive: true })
  })

  await execFileAsync(join(binDirectory, 'initdb'), [
    '-D',
    dataDirectory,
    '--auth=trust',
    '--username=postgres',
    '--no-locale',
  ])
  await execFileAsync(join(binDirectory, 'pg_ctl'), [
    '-D',
    dataDirectory,
    '-l',
    join(fixtureDirectory, 'postgres.log'),
    '-o',
    `-p ${port} -h 127.0.0.1`,
    '-w',
    'start',
  ])
  started = true

  const adminDatabase = `postgresql://postgres@127.0.0.1:${port}/postgres`
  await query(
    adminDatabase,
    'CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE backup_reader LOGIN BYPASSRLS;'
  )
  await execFileAsync(join(binDirectory, 'createdb'), [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'postgres',
    'source',
  ])
  await execFileAsync(join(binDirectory, 'createdb'), [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'postgres',
    'target',
  ])

  const sourceAdmin = `postgresql://postgres@127.0.0.1:${port}/source`
  const targetAdmin = `postgresql://postgres@127.0.0.1:${port}/target`
  const sourceReader = `postgresql://backup_reader@127.0.0.1:${port}/source`
  const targetReader = `postgresql://backup_reader@127.0.0.1:${port}/target`
  await createAuthSchema(sourceAdmin)
  await createAuthSchema(targetAdmin)
  await createAppAuthForeignKey(sourceAdmin)
  await createAppAuthForeignKey(targetAdmin)
  await query(
    sourceAdmin,
    `
      INSERT INTO auth.schema_migrations VALUES ('source-managed-version');
      INSERT INTO auth.users VALUES (
        '11111111-1111-4111-8111-111111111111',
        'private-user@example.invalid',
        'private-password-hash'
      );
      INSERT INTO auth.identities VALUES (
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111'
      );
      INSERT INTO auth.future_auth_table VALUES (
        '33333333-3333-4333-8333-333333333333'
      );
      INSERT INTO public.user_profiles VALUES (
        '11111111-1111-4111-8111-111111111111'
      );
    `
  )
  await query(targetAdmin, "INSERT INTO auth.schema_migrations VALUES ('source-managed-version')")

  const unknownInspection = assessDatabase(await inspectDatabase(sourceReader), 'source')
  assert.equal(unknownInspection.postgres.major_version, 17)
  assert.equal(unknownInspection.postgres.transaction_read_only, true)
  assert.ok(
    unknownInspection.failures.some((entry) => entry.code === 'UNKNOWN_AUTH_TABLE_NONEMPTY')
  )

  const serialized = JSON.stringify(unknownInspection)
  assert.doesNotMatch(serialized, /private-user@example/)
  assert.doesNotMatch(serialized, /private-password-hash/)
  assert.doesNotMatch(serialized, /source-managed-version/)
  assert.match(serialized, /encrypted_password/)

  await query(sourceAdmin, 'DELETE FROM auth.future_auth_table')
  const source = assessDatabase(await inspectDatabase(sourceReader), 'source')
  const target = assessDatabase(await inspectDatabase(targetReader), 'target')
  assert.equal(source.safe, true)
  assert.equal(target.safe, true)
  assert.equal(compareSourceAndTarget(source, target).status, 'compatible')

  let compatibleOutput = ''
  const compatibleExitCode = await runCli({
    env: {
      SOURCE_DATABASE_URL: sourceReader,
      TARGET_DATABASE_URL: targetReader,
    },
    write: (value) => {
      compatibleOutput += value
    },
  })
  const compatibleReport = JSON.parse(compatibleOutput)
  assert.equal(compatibleExitCode, 0)
  assert.equal(compatibleReport.safe_to_capture_auth_data, true)
  assert.equal(compatibleReport.safe_to_attempt_scratch_restore, true)
  assert.equal(compatibleReport.restore_certified, false)
  assert.equal(compatibleReport.safe_to_restore, false)
  assert.ok(
    compatibleReport.required_post_restore_checks.includes('existing_password_login_verified')
  )

  await query(targetAdmin, "UPDATE auth.schema_migrations SET version = 'target-managed-version'")
  const migrationDriftedTarget = assessDatabase(await inspectDatabase(targetReader), 'target')
  const migrationDrift = compareSourceAndTarget(source, migrationDriftedTarget)
  assert.ok(
    migrationDrift.failures.some((entry) => entry.code === 'TARGET_AUTH_MIGRATION_LEDGER_DRIFT')
  )
  assert.ok(migrationDrift.failures.some((entry) => entry.code === 'TARGET_AUTH_CATALOG_MISMATCH'))
  await query(targetAdmin, "UPDATE auth.schema_migrations SET version = 'source-managed-version'")

  await query(
    sourceAdmin,
    `
      SET session_replication_role = replica;
      INSERT INTO public.user_profiles VALUES (
        '44444444-4444-4444-8444-444444444444'
      );
      SET session_replication_role = origin;
    `
  )
  const orphaned = assessDatabase(await inspectDatabase(sourceReader), 'source')
  const appForeignKey = orphaned.app_to_auth_users.foreign_keys[0]
  assert.equal(appForeignKey.orphan_count, '1')
  assert.ok(orphaned.failures.some((entry) => entry.code === 'FOREIGN_KEY_ORPHANS_PRESENT'))
  await query(
    sourceAdmin,
    "DELETE FROM public.user_profiles WHERE id = '44444444-4444-4444-8444-444444444444'"
  )

  await query(targetAdmin, 'ALTER TABLE auth.users ADD COLUMN target_only text')
  const driftedTarget = assessDatabase(await inspectDatabase(targetReader), 'target')
  const drift = compareSourceAndTarget(source, driftedTarget)
  assert.ok(drift.failures.some((entry) => entry.code === 'TARGET_AUTH_COLUMN_DRIFT'))
  assert.ok(drift.failures.some((entry) => entry.code === 'TARGET_AUTH_CATALOG_MISMATCH'))
})
