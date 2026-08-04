#!/usr/bin/env node

/**
 * Read-only structural preflight for a future Supabase Auth recovery set.
 *
 * This command deliberately does not read dotenv or DATABASE_URL. It only
 * connects when SOURCE_DATABASE_URL is explicit; TARGET_DATABASE_URL is
 * optional and, when present, is inspected independently. Every catalog and
 * count query runs inside a repeatable-read, read-only transaction with local
 * timeouts. Output contains structure, aggregate counts, and one-way
 * fingerprints only, never user rows. This preflight can authorize a scratch
 * restore attempt; it cannot certify recovery before runtime auth checks pass.
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

export const AUTH_RECOVERY_PREFLIGHT_CONTRACT = 'arena.auth-recovery-preflight.v1'
export const AUTH_RECOVERY_CLASSIFICATION_VERSION = 'auth-account-recovery.v1'
export const PREFLIGHT_STATEMENT_TIMEOUT_MS = 15_000
export const PREFLIGHT_LOCK_TIMEOUT_MS = 5_000

const REQUIRED_AUTH_TABLES = Object.freeze(['users', 'identities'])
const REQUIRED_MANAGED_AUTH_TABLES = Object.freeze(['schema_migrations'])
const EXPECTED_AUTH_OWNER = 'supabase_auth_admin'

// These are recovery-policy classes, not claims about how Supabase internally
// treats the lifetime of every row. "durable" is eligible for a future
// account-recovery sidecar. "ephemeral" is excluded by default and forces
// re-authentication. Any unreviewed non-empty table is a hard stop.
const DURABLE_AUTH_TABLES = new Set([
  'users',
  'identities',
  'mfa_factors',
  'sso_providers',
  'sso_domains',
])
const EPHEMERAL_AUTH_TABLES = new Set([
  'flow_state',
  'mfa_amr_claims',
  'mfa_challenges',
  'one_time_tokens',
  'refresh_tokens',
  'sessions',
])
const MANAGED_EXCLUDED_AUTH_TABLES = new Set(['instances', 'schema_migrations'])

const TABLES_SQL = `
  SELECT
    relation.oid::text AS table_oid,
    relation.relname AS table_name,
    relation.relkind AS relation_kind,
    pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
    relation.relrowsecurity AS rls_enabled,
    relation.relforcerowsecurity AS force_rls,
    pg_catalog.has_table_privilege(
      CURRENT_USER,
      relation.oid,
      'SELECT'
    ) AS can_select
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'auth'
    AND relation.relkind IN ('r', 'p')
  ORDER BY relation.relname
`

const COLUMNS_SQL = `
  SELECT
    attribute.attrelid::text AS table_oid,
    attribute.attnum::integer AS ordinal,
    attribute.attname AS column_name,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
    attribute.attnotnull AS not_null,
    attribute.attidentity AS identity_kind,
    attribute.attgenerated AS generated_kind,
    pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid
   AND default_value.adnum = attribute.attnum
  WHERE namespace.nspname = 'auth'
    AND relation.relkind IN ('r', 'p')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  ORDER BY relation.relname, attribute.attnum
`

const CONSTRAINTS_SQL = `
  SELECT
    constraint_row.conrelid::text AS table_oid,
    constraint_row.conname AS constraint_name,
    constraint_row.contype AS constraint_type,
    constraint_row.condeferrable AS deferrable,
    constraint_row.condeferred AS initially_deferred,
    constraint_row.convalidated AS validated,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition,
    ARRAY(
      SELECT attribute.attname
      FROM pg_catalog.unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attribute_number, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attribute_number
      ORDER BY key_column.position
    )::text[] AS columns
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'auth'
    AND relation.relkind IN ('r', 'p')
    AND constraint_row.contype IN ('p', 'u', 'c', 'x')
  ORDER BY relation.relname, constraint_row.conname
`

const FOREIGN_KEYS_SQL = `
  SELECT
    constraint_row.oid::text AS constraint_oid,
    constraint_row.conname AS constraint_name,
    source_namespace.nspname AS source_schema,
    source_relation.relname AS source_table,
    target_namespace.nspname AS target_schema,
    target_relation.relname AS target_table,
    ARRAY(
      SELECT attribute.attname
      FROM pg_catalog.unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attribute_number, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attribute_number
      ORDER BY key_column.position
    )::text[] AS source_columns,
    ARRAY(
      SELECT attribute.attname
      FROM pg_catalog.unnest(constraint_row.confkey)
        WITH ORDINALITY AS key_column(attribute_number, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.confrelid
       AND attribute.attnum = key_column.attribute_number
      ORDER BY key_column.position
    )::text[] AS target_columns,
    constraint_row.confmatchtype AS match_type,
    constraint_row.confupdtype AS update_action,
    constraint_row.confdeltype AS delete_action,
    constraint_row.condeferrable AS deferrable,
    constraint_row.condeferred AS initially_deferred,
    constraint_row.convalidated AS validated,
    source_relation.relrowsecurity AS source_rls_enabled,
    target_relation.relrowsecurity AS target_rls_enabled,
    pg_catalog.has_table_privilege(
      CURRENT_USER,
      constraint_row.conrelid,
      'SELECT'
    ) AS source_can_select,
    pg_catalog.has_table_privilege(
      CURRENT_USER,
      constraint_row.confrelid,
      'SELECT'
    ) AS target_can_select
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS source_relation
    ON source_relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS source_namespace
    ON source_namespace.oid = source_relation.relnamespace
  JOIN pg_catalog.pg_class AS target_relation
    ON target_relation.oid = constraint_row.confrelid
  JOIN pg_catalog.pg_namespace AS target_namespace
    ON target_namespace.oid = target_relation.relnamespace
  WHERE constraint_row.contype = 'f'
    AND (
      source_namespace.nspname = 'auth'
      OR (
        source_namespace.nspname IN ('arena', 'public')
        AND target_namespace.nspname = 'auth'
        AND target_relation.relname = 'users'
      )
    )
  ORDER BY
    source_namespace.nspname,
    source_relation.relname,
    constraint_row.conname
`

const CONSTRAINT_TYPE_NAMES = Object.freeze({
  c: 'check',
  p: 'primary_key',
  u: 'unique',
  x: 'exclusion',
})

const FK_ACTION_NAMES = Object.freeze({
  a: 'no_action',
  c: 'cascade',
  d: 'set_default',
  n: 'set_null',
  r: 'restrict',
})

const FK_MATCH_NAMES = Object.freeze({
  f: 'full',
  p: 'partial',
  s: 'simple',
})

class PreflightConfigurationError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export function classifyAuthTable(tableName) {
  if (DURABLE_AUTH_TABLES.has(tableName)) {
    return { classification: 'durable', managed_excluded: false }
  }
  if (MANAGED_EXCLUDED_AUTH_TABLES.has(tableName)) {
    return { classification: 'ephemeral', managed_excluded: true }
  }
  if (EPHEMERAL_AUTH_TABLES.has(tableName)) {
    return { classification: 'ephemeral', managed_excluded: false }
  }
  return { classification: 'unknown', managed_excluded: false }
}

export function quoteIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new PreflightConfigurationError('INVALID_CATALOG_IDENTIFIER')
  }
  return `"${value.replaceAll('"', '""')}"`
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256Fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function normalizeColumns(columns) {
  return [...columns]
    .map((column) => ({
      name: column.name,
      ordinal: Number(column.ordinal),
      data_type: column.data_type,
      not_null: Boolean(column.not_null),
      identity_kind: column.identity_kind || '',
      generated_kind: column.generated_kind || '',
      has_default: Boolean(column.has_default),
      default_fingerprint: column.default_fingerprint ?? null,
    }))
    .sort((left, right) => left.ordinal - right.ordinal)
}

function normalizeConstraints(constraints) {
  return [...constraints]
    .map((constraint) => ({
      name: constraint.name,
      type: constraint.type,
      columns: [...constraint.columns],
      definition_fingerprint: constraint.definition_fingerprint,
      deferrable: Boolean(constraint.deferrable),
      initially_deferred: Boolean(constraint.initially_deferred),
      validated: Boolean(constraint.validated),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function normalizeForeignKey(foreignKey) {
  return {
    name: foreignKey.name,
    source_schema: foreignKey.source_schema,
    source_table: foreignKey.source_table,
    source_columns: [...foreignKey.source_columns],
    target_schema: foreignKey.target_schema,
    target_table: foreignKey.target_table,
    target_columns: [...foreignKey.target_columns],
    match_type: foreignKey.match_type,
    update_action: foreignKey.update_action,
    delete_action: foreignKey.delete_action,
    deferrable: Boolean(foreignKey.deferrable),
    initially_deferred: Boolean(foreignKey.initially_deferred),
    validated: Boolean(foreignKey.validated),
    source_rls_enabled: Boolean(foreignKey.source_rls_enabled),
    target_rls_enabled: Boolean(foreignKey.target_rls_enabled),
    source_can_select: Boolean(foreignKey.source_can_select),
    target_can_select: Boolean(foreignKey.target_can_select),
    orphan_count: foreignKey.orphan_count ?? null,
  }
}

function structuralForeignKey(foreignKey) {
  const normalized = normalizeForeignKey(foreignKey)
  delete normalized.source_can_select
  delete normalized.target_can_select
  delete normalized.source_rls_enabled
  delete normalized.target_rls_enabled
  delete normalized.orphan_count
  return normalized
}

export function buildCatalogFingerprint({
  tables,
  auth_foreign_keys: authForeignKeys,
  app_to_auth_users_foreign_keys: appToAuthUsersForeignKeys = [],
  managed_migration_ledger: managedMigrationLedger = null,
}) {
  return sha256Fingerprint({
    tables: [...tables]
      .map((table) => ({
        name: table.name,
        owner: table.owner,
        kind: table.kind,
        rls_enabled: Boolean(table.rls_enabled),
        force_rls: Boolean(table.force_rls),
        columns: normalizeColumns(table.columns),
        constraints: normalizeConstraints(table.constraints),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    auth_foreign_keys: [...authForeignKeys]
      .map(structuralForeignKey)
      .sort((left, right) =>
        `${left.source_schema}.${left.source_table}.${left.name}`.localeCompare(
          `${right.source_schema}.${right.source_table}.${right.name}`
        )
      ),
    app_to_auth_users_foreign_keys: [...appToAuthUsersForeignKeys]
      .map(structuralForeignKey)
      .sort((left, right) =>
        `${left.source_schema}.${left.source_table}.${left.name}`.localeCompare(
          `${right.source_schema}.${right.source_table}.${right.name}`
        )
      ),
    managed_migration_ledger: managedMigrationLedger,
  })
}

function failure(scope, code, object) {
  return object === undefined ? { scope, code } : { scope, code, object }
}

function numericCount(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null
}

function hasColumn(table, name, dataType) {
  return table?.columns.some(
    (column) => column.name === name && (dataType === undefined || column.data_type === dataType)
  )
}

function hasUsersPrimaryKey(table) {
  return table?.constraints.some(
    (constraint) =>
      constraint.type === 'primary_key' &&
      constraint.validated &&
      constraint.columns.length === 1 &&
      constraint.columns[0] === 'id'
  )
}

function databaseFailures(database, scope) {
  const failures = []
  const tables = new Map(database.auth.tables.map((table) => [table.name, table]))

  if (!database.postgres.transaction_read_only) {
    failures.push(failure(scope, 'READ_ONLY_TRANSACTION_UNPROVEN'))
  }

  for (const tableName of REQUIRED_AUTH_TABLES) {
    if (!tables.has(tableName)) {
      failures.push(failure(scope, 'REQUIRED_AUTH_TABLE_MISSING', `auth.${tableName}`))
    }
  }
  for (const tableName of REQUIRED_MANAGED_AUTH_TABLES) {
    if (!tables.has(tableName)) {
      failures.push(failure(scope, 'REQUIRED_MANAGED_AUTH_TABLE_MISSING', `auth.${tableName}`))
    }
  }

  const migrationLedger = database.auth.managed_migration_ledger
  if (
    migrationLedger == null ||
    numericCount(migrationLedger.row_count) === null ||
    typeof migrationLedger.content_fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(migrationLedger.content_fingerprint)
  ) {
    failures.push(failure(scope, 'AUTH_MIGRATION_LEDGER_UNPROVEN', 'auth.schema_migrations'))
  }

  if (tables.has('users') && !hasColumn(tables.get('users'), 'id', 'uuid')) {
    failures.push(failure(scope, 'REQUIRED_AUTH_COLUMN_DRIFT', 'auth.users.id'))
  }
  if (tables.has('users') && !hasUsersPrimaryKey(tables.get('users'))) {
    failures.push(failure(scope, 'AUTH_USERS_PRIMARY_KEY_DRIFT', 'auth.users'))
  }
  if (tables.has('identities') && !hasColumn(tables.get('identities'), 'user_id', 'uuid')) {
    failures.push(failure(scope, 'REQUIRED_AUTH_COLUMN_DRIFT', 'auth.identities.user_id'))
  }

  for (const table of database.auth.tables) {
    const object = `auth.${table.name}`
    if (table.owner !== EXPECTED_AUTH_OWNER) {
      failures.push(failure(scope, 'AUTH_TABLE_OWNER_UNEXPECTED', object))
    }
    if (!table.can_select) {
      failures.push(failure(scope, 'AUTH_TABLE_SELECT_DENIED', object))
    }
    if (table.rls_enabled && !database.backup_role.bypass_rls) {
      failures.push(failure(scope, 'AUTH_RLS_VISIBILITY_UNPROVEN', object))
    }
    const count = numericCount(table.row_count)
    if (table.row_count !== null && count === null) {
      failures.push(failure(scope, 'AUTH_ROW_COUNT_INVALID', object))
    }
    if (table.classification === 'unknown' && count !== null && count > 0n) {
      failures.push(failure(scope, 'UNKNOWN_AUTH_TABLE_NONEMPTY', object))
    }
  }

  const allForeignKeys = [...database.auth.foreign_keys, ...database.app_to_auth_users.foreign_keys]
  for (const foreignKey of allForeignKeys) {
    const object = `${foreignKey.source_schema}.${foreignKey.source_table}.${foreignKey.name}`
    if (!foreignKey.source_can_select || !foreignKey.target_can_select) {
      failures.push(failure(scope, 'FOREIGN_KEY_SELECT_DENIED', object))
    }
    if (
      (foreignKey.source_rls_enabled || foreignKey.target_rls_enabled) &&
      !database.backup_role.bypass_rls
    ) {
      failures.push(failure(scope, 'FOREIGN_KEY_RLS_VISIBILITY_UNPROVEN', object))
    }
    if (!foreignKey.validated) {
      failures.push(failure(scope, 'FOREIGN_KEY_NOT_VALIDATED', object))
    }
    const count = numericCount(foreignKey.orphan_count)
    if (foreignKey.orphan_count !== null && count === null) {
      failures.push(failure(scope, 'FOREIGN_KEY_ORPHAN_COUNT_INVALID', object))
    } else if (count !== null && count > 0n) {
      failures.push(failure(scope, 'FOREIGN_KEY_ORPHANS_PRESENT', object))
    }
    if (foreignKey.match_type === 'partial') {
      failures.push(failure(scope, 'FOREIGN_KEY_MATCH_PARTIAL_UNSUPPORTED', object))
    }
  }

  for (const foreignKey of database.app_to_auth_users.foreign_keys) {
    const exactUsersPrimaryKey =
      foreignKey.target_schema === 'auth' &&
      foreignKey.target_table === 'users' &&
      foreignKey.target_columns.length === 1 &&
      foreignKey.target_columns[0] === 'id'
    if (!exactUsersPrimaryKey) {
      failures.push(
        failure(
          scope,
          'APP_AUTH_FOREIGN_KEY_NOT_USERS_PRIMARY_KEY',
          `${foreignKey.source_schema}.${foreignKey.source_table}.${foreignKey.name}`
        )
      )
    }
  }

  return failures
}

export function assessDatabase(database, scope = 'source') {
  const assessed = {
    ...database,
    auth: {
      ...database.auth,
      catalog_fingerprint: buildCatalogFingerprint({
        tables: database.auth.tables,
        auth_foreign_keys: database.auth.foreign_keys,
        app_to_auth_users_foreign_keys: database.app_to_auth_users.foreign_keys,
        managed_migration_ledger: database.auth.managed_migration_ledger,
      }),
    },
  }
  const failures = databaseFailures(assessed, scope)
  return { ...assessed, failures, safe: failures.length === 0 }
}

function tableStructuralView(table) {
  return {
    owner: table.owner,
    kind: table.kind,
    rls_enabled: table.rls_enabled,
    force_rls: table.force_rls,
    columns: normalizeColumns(table.columns),
    constraints: normalizeConstraints(table.constraints),
  }
}

export function compareSourceAndTarget(source, target) {
  const failures = []
  if (source.postgres.major_version !== target.postgres.major_version) {
    failures.push(failure('compatibility', 'TARGET_POSTGRES_MAJOR_MISMATCH'))
  }

  const sourceTables = new Map(source.auth.tables.map((table) => [table.name, table]))
  const targetTables = new Map(target.auth.tables.map((table) => [table.name, table]))
  const sourceNames = [...sourceTables.keys()].sort()
  const targetNames = [...targetTables.keys()].sort()
  if (stableJson(sourceNames) !== stableJson(targetNames)) {
    failures.push(failure('compatibility', 'TARGET_AUTH_TABLE_SET_MISMATCH'))
  }

  for (const name of sourceNames.filter((tableName) => targetTables.has(tableName))) {
    const sourceTable = tableStructuralView(sourceTables.get(name))
    const targetTable = tableStructuralView(targetTables.get(name))
    if (stableJson(sourceTable.columns) !== stableJson(targetTable.columns)) {
      failures.push(failure('compatibility', 'TARGET_AUTH_COLUMN_DRIFT', `auth.${name}`))
    }
    if (sourceTable.owner !== targetTable.owner) {
      failures.push(failure('compatibility', 'TARGET_AUTH_OWNER_DRIFT', `auth.${name}`))
    }
    if (
      sourceTable.kind !== targetTable.kind ||
      sourceTable.rls_enabled !== targetTable.rls_enabled ||
      sourceTable.force_rls !== targetTable.force_rls
    ) {
      failures.push(failure('compatibility', 'TARGET_AUTH_TABLE_PROPERTY_DRIFT', `auth.${name}`))
    }
    if (stableJson(sourceTable.constraints) !== stableJson(targetTable.constraints)) {
      failures.push(failure('compatibility', 'TARGET_AUTH_CONSTRAINT_DRIFT', `auth.${name}`))
    }
  }

  const foreignKeySort = (left, right) =>
    `${left.source_schema}.${left.source_table}.${left.name}`.localeCompare(
      `${right.source_schema}.${right.source_table}.${right.name}`
    )
  const sourceForeignKeys = source.auth.foreign_keys.map(structuralForeignKey).sort(foreignKeySort)
  const targetForeignKeys = target.auth.foreign_keys.map(structuralForeignKey).sort(foreignKeySort)
  if (stableJson(sourceForeignKeys) !== stableJson(targetForeignKeys)) {
    failures.push(failure('compatibility', 'TARGET_AUTH_FOREIGN_KEY_DRIFT'))
  }
  const sourceAppForeignKeys = source.app_to_auth_users.foreign_keys
    .map(structuralForeignKey)
    .sort(foreignKeySort)
  const targetAppForeignKeys = target.app_to_auth_users.foreign_keys
    .map(structuralForeignKey)
    .sort(foreignKeySort)
  if (stableJson(sourceAppForeignKeys) !== stableJson(targetAppForeignKeys)) {
    failures.push(failure('compatibility', 'TARGET_APP_AUTH_FOREIGN_KEY_DRIFT'))
  }
  if (
    stableJson(source.auth.managed_migration_ledger) !==
    stableJson(target.auth.managed_migration_ledger)
  ) {
    failures.push(failure('compatibility', 'TARGET_AUTH_MIGRATION_LEDGER_DRIFT'))
  }
  if (source.auth.catalog_fingerprint !== target.auth.catalog_fingerprint) {
    failures.push(failure('compatibility', 'TARGET_AUTH_CATALOG_MISMATCH'))
  }

  for (const table of target.auth.tables) {
    if (table.managed_excluded) continue
    const count = numericCount(table.row_count)
    if (count !== null && count > 0n) {
      failures.push(failure('target', 'TARGET_AUTH_TABLE_NOT_EMPTY', `auth.${table.name}`))
    }
  }

  return {
    status: failures.length === 0 ? 'compatible' : 'incompatible',
    failures,
  }
}

export function buildForeignKeyOrphanSql(foreignKey) {
  if (
    !Array.isArray(foreignKey.source_columns) ||
    foreignKey.source_columns.length === 0 ||
    foreignKey.source_columns.length !== foreignKey.target_columns?.length
  ) {
    throw new PreflightConfigurationError('INVALID_FOREIGN_KEY_SHAPE')
  }

  const sourceRelation = `${quoteIdentifier(foreignKey.source_schema)}.${quoteIdentifier(
    foreignKey.source_table
  )}`
  const targetRelation = `${quoteIdentifier(foreignKey.target_schema)}.${quoteIdentifier(
    foreignKey.target_table
  )}`
  const sourceColumns = foreignKey.source_columns.map(
    (column) => `source_row.${quoteIdentifier(column)}`
  )
  const allNonNull = sourceColumns.map((column) => `${column} IS NOT NULL`).join(' AND ')
  const anyNonNull = sourceColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')
  const joins = foreignKey.source_columns
    .map(
      (sourceColumn, index) =>
        `target_row.${quoteIdentifier(foreignKey.target_columns[index])} = ` +
        `source_row.${quoteIdentifier(sourceColumn)}`
    )
    .join(' AND ')
  const missingTarget = `NOT EXISTS (SELECT 1 FROM ${targetRelation} AS target_row WHERE ${joins})`
  const predicate =
    foreignKey.match_type === 'full'
      ? `((${anyNonNull}) AND (NOT (${allNonNull}) OR ${missingTarget}))`
      : `((${allNonNull}) AND ${missingTarget})`

  return `SELECT pg_catalog.count(*)::text AS orphan_count FROM ${sourceRelation} AS source_row WHERE ${predicate}`
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function validateExplicitDatabaseUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PreflightConfigurationError(`${label}_REQUIRED`)
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new PreflightConfigurationError(`${label}_INVALID`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new PreflightConfigurationError(`${label}_INVALID`)
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname || parsed.pathname === '/') {
    throw new PreflightConfigurationError(`${label}_INVALID`)
  }
  if (parsed.hash || parsed.pathname.slice(1).includes('/')) {
    throw new PreflightConfigurationError(`${label}_INVALID`)
  }

  for (const forbidden of [
    'dbname',
    'host',
    'hostaddr',
    'password',
    'service',
    'servicefile',
    'user',
  ]) {
    if (parsed.searchParams.has(forbidden)) {
      throw new PreflightConfigurationError(`${label}_AMBIGUOUS`)
    }
  }
  const sslModes = parsed.searchParams.getAll('sslmode')
  if (sslModes.length > 1) {
    throw new PreflightConfigurationError(`${label}_AMBIGUOUS`)
  }
  if (
    !isLocalHostname(parsed.hostname) &&
    !['require', 'verify-ca', 'verify-full'].includes(sslModes[0])
  ) {
    throw new PreflightConfigurationError(`${label}_TLS_REQUIRED`)
  }
  return value
}

function majorVersion(serverVersionNumber) {
  const numeric = Number(serverVersionNumber)
  return Number.isSafeInteger(numeric) && numeric > 0 ? Math.floor(numeric / 10_000) : null
}

function groupedBy(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const value = row[key]
    const group = groups.get(value) ?? []
    group.push(row)
    groups.set(value, group)
  }
  return groups
}

function mapForeignKey(row) {
  return {
    name: row.constraint_name,
    source_schema: row.source_schema,
    source_table: row.source_table,
    source_columns: row.source_columns,
    target_schema: row.target_schema,
    target_table: row.target_table,
    target_columns: row.target_columns,
    match_type: FK_MATCH_NAMES[row.match_type] ?? 'unknown',
    update_action: FK_ACTION_NAMES[row.update_action] ?? 'unknown',
    delete_action: FK_ACTION_NAMES[row.delete_action] ?? 'unknown',
    deferrable: row.deferrable,
    initially_deferred: row.initially_deferred,
    validated: row.validated,
    source_rls_enabled: row.source_rls_enabled,
    target_rls_enabled: row.target_rls_enabled,
    source_can_select: row.source_can_select,
    target_can_select: row.target_can_select,
    orphan_count: null,
  }
}

export async function inspectDatabase(databaseUrl, { clientFactory } = {}) {
  const makeClient = clientFactory ?? ((configuration) => new pg.Client(configuration))
  const client = makeClient({
    connectionString: databaseUrl,
    application_name: 'arena-auth-recovery-preflight',
    connectionTimeoutMillis: 10_000,
    query_timeout: PREFLIGHT_STATEMENT_TIMEOUT_MS + 5_000,
  })
  let transactionOpen = false

  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
      `${PREFLIGHT_STATEMENT_TIMEOUT_MS}ms`,
    ])
    await client.query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [
      `${PREFLIGHT_LOCK_TIMEOUT_MS}ms`,
    ])

    const postgresRow = (
      await client.query(`
        SELECT
          pg_catalog.current_setting('server_version') AS server_version,
          pg_catalog.current_setting('server_version_num') AS server_version_num,
          pg_catalog.current_setting('transaction_read_only') AS transaction_read_only
      `)
    ).rows[0]
    const roleRow = (
      await client.query(`
        SELECT (role_row.rolsuper OR role_row.rolbypassrls) AS bypass_rls
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = CURRENT_USER
      `)
    ).rows[0]
    const tableRows = (await client.query(TABLES_SQL)).rows
    const columnRows = (await client.query(COLUMNS_SQL)).rows
    const constraintRows = (await client.query(CONSTRAINTS_SQL)).rows
    const foreignKeyRows = (await client.query(FOREIGN_KEYS_SQL)).rows

    const columnsByTable = groupedBy(columnRows, 'table_oid')
    const constraintsByTable = groupedBy(constraintRows, 'table_oid')
    const tables = []
    for (const row of tableRows) {
      const classification = classifyAuthTable(row.table_name)
      let rowCount = null
      if (row.can_select && (!row.rls_enabled || roleRow?.bypass_rls)) {
        const countResult = await client.query(
          `SELECT pg_catalog.count(*)::text AS row_count FROM ${quoteIdentifier(
            'auth'
          )}.${quoteIdentifier(row.table_name)}`
        )
        rowCount = countResult.rows[0]?.row_count ?? null
      }
      tables.push({
        name: row.table_name,
        owner: row.owner,
        kind: row.relation_kind === 'p' ? 'partitioned_table' : 'table',
        rls_enabled: row.rls_enabled,
        force_rls: row.force_rls,
        can_select: Boolean(row.can_select),
        row_count: rowCount,
        ...classification,
        columns: (columnsByTable.get(row.table_oid) ?? []).map((column) => ({
          name: column.column_name,
          ordinal: column.ordinal,
          data_type: column.data_type,
          not_null: column.not_null,
          identity_kind: column.identity_kind,
          generated_kind: column.generated_kind,
          has_default: column.default_expression !== null,
          default_fingerprint:
            column.default_expression === null
              ? null
              : sha256Fingerprint(column.default_expression),
        })),
        constraints: (constraintsByTable.get(row.table_oid) ?? []).map((constraint) => ({
          name: constraint.constraint_name,
          type: CONSTRAINT_TYPE_NAMES[constraint.constraint_type] ?? 'unknown',
          columns: constraint.columns,
          definition_fingerprint: sha256Fingerprint(constraint.definition),
          deferrable: constraint.deferrable,
          initially_deferred: constraint.initially_deferred,
          validated: constraint.validated,
        })),
      })
    }

    const foreignKeys = foreignKeyRows.map(mapForeignKey)
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.source_can_select &&
        foreignKey.target_can_select &&
        (roleRow?.bypass_rls ||
          (!foreignKey.source_rls_enabled && !foreignKey.target_rls_enabled)) &&
        foreignKey.match_type !== 'partial'
      ) {
        const orphanResult = await client.query(buildForeignKeyOrphanSql(foreignKey))
        foreignKey.orphan_count = orphanResult.rows[0]?.orphan_count ?? null
      }
    }

    const schemaMigrations = tables.find((table) => table.name === 'schema_migrations')
    let managedMigrationLedger = null
    if (
      schemaMigrations?.can_select &&
      (!schemaMigrations.rls_enabled || roleRow?.bypass_rls) &&
      hasColumn(schemaMigrations, 'version')
    ) {
      const ledgerResult = await client.query(`
        SELECT
          pg_catalog.count(*)::text AS row_count,
          pg_catalog.md5(
            COALESCE(
              pg_catalog.jsonb_agg(version::text ORDER BY version::text)::text,
              '[]'
            )
          ) AS content_digest
        FROM auth.schema_migrations
      `)
      const ledger = ledgerResult.rows[0]
      if (
        typeof ledger?.row_count === 'string' &&
        typeof ledger?.content_digest === 'string' &&
        /^[0-9a-f]{32}$/.test(ledger.content_digest)
      ) {
        managedMigrationLedger = {
          row_count: ledger.row_count,
          content_fingerprint: sha256Fingerprint({
            contract: 'arena.auth-managed-migration-ledger-fingerprint.v1',
            row_count: ledger.row_count,
            aggregate_digest: ledger.content_digest,
          }),
        }
      }
    }

    const authForeignKeys = foreignKeys.filter((foreignKey) => foreignKey.source_schema === 'auth')
    const appForeignKeys = foreignKeys.filter((foreignKey) => foreignKey.source_schema !== 'auth')
    const canSelectAll = tables.every((table) => table.can_select)
    const foreignKeyRlsSafe = foreignKeys.every(
      (foreignKey) =>
        Boolean(roleRow?.bypass_rls) ||
        (!foreignKey.source_rls_enabled && !foreignKey.target_rls_enabled)
    )

    await client.query('ROLLBACK')
    transactionOpen = false

    return {
      postgres: {
        server_version: postgresRow.server_version,
        server_version_num: postgresRow.server_version_num,
        major_version: majorVersion(postgresRow.server_version_num),
        transaction_read_only: postgresRow.transaction_read_only === 'on',
      },
      backup_role: {
        can_select_all_auth_tables: canSelectAll,
        bypass_rls: Boolean(roleRow?.bypass_rls),
        rls_visibility_complete:
          canSelectAll &&
          foreignKeyRlsSafe &&
          tables.every((table) => !table.rls_enabled || Boolean(roleRow?.bypass_rls)),
      },
      auth: {
        classification_version: AUTH_RECOVERY_CLASSIFICATION_VERSION,
        tables,
        foreign_keys: authForeignKeys,
        managed_migration_ledger: managedMigrationLedger,
      },
      app_to_auth_users: {
        foreign_keys: appForeignKeys,
      },
    }
  } finally {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    await client.end().catch(() => undefined)
  }
}

function resultEnvelope({ source, target, compatibility, failures }) {
  const scratchPreflightReady =
    target === null
      ? null
      : Boolean(source?.safe && target?.safe && compatibility?.status === 'compatible')
  return {
    contract: AUTH_RECOVERY_PREFLIGHT_CONTRACT,
    safe_to_capture_auth_data: source?.safe ?? false,
    safe_to_attempt_scratch_restore: scratchPreflightReady,
    restore_certified: false,
    safe_to_restore: target === null ? null : false,
    required_post_restore_checks: [
      'auth_data_restore_completed',
      'managed_auth_runtime_started',
      'existing_password_login_verified',
      'new_registration_verified',
      'oauth_verified_if_configured',
      'mfa_and_passkey_verified_if_configured',
      'forced_reauthentication_policy_verified',
      'app_auth_foreign_keys_revalidated',
    ],
    failures,
    source,
    target,
    compatibility,
  }
}

export async function runCli({
  env = process.env,
  clientFactory,
  write = (value) => process.stdout.write(value),
} = {}) {
  let sourceUrl
  let targetUrl = null
  try {
    sourceUrl = validateExplicitDatabaseUrl(env.SOURCE_DATABASE_URL, 'SOURCE_DATABASE_URL')
    if (typeof env.TARGET_DATABASE_URL === 'string' && env.TARGET_DATABASE_URL.trim() !== '') {
      targetUrl = validateExplicitDatabaseUrl(env.TARGET_DATABASE_URL, 'TARGET_DATABASE_URL')
    }
  } catch (error) {
    const code =
      error instanceof PreflightConfigurationError ? error.code : 'PREFLIGHT_CONFIGURATION_INVALID'
    const output = resultEnvelope({
      source: null,
      target: null,
      compatibility: { status: 'not_checked', failures: [] },
      failures: [failure('configuration', code)],
    })
    write(`${JSON.stringify(output, null, 2)}\n`)
    return 2
  }

  let source
  try {
    source = assessDatabase(await inspectDatabase(sourceUrl, { clientFactory }), 'source')
  } catch {
    const output = resultEnvelope({
      source: null,
      target: null,
      compatibility: { status: 'not_checked', failures: [] },
      failures: [failure('source', 'SOURCE_INSPECTION_FAILED')],
    })
    write(`${JSON.stringify(output, null, 2)}\n`)
    return 2
  }

  let target = null
  let compatibility = { status: 'not_checked', failures: [] }
  if (targetUrl !== null) {
    try {
      target = assessDatabase(await inspectDatabase(targetUrl, { clientFactory }), 'target')
      compatibility = compareSourceAndTarget(source, target)
    } catch {
      const output = resultEnvelope({
        source,
        target: null,
        compatibility: { status: 'not_checked', failures: [] },
        failures: [...source.failures, failure('target', 'TARGET_INSPECTION_FAILED')],
      })
      write(`${JSON.stringify(output, null, 2)}\n`)
      return 2
    }
  }

  const failures = [...source.failures, ...(target?.failures ?? []), ...compatibility.failures]
  const output = resultEnvelope({ source, target, compatibility, failures })
  write(`${JSON.stringify(output, null, 2)}\n`)
  return failures.length === 0 ? 0 : 1
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  process.exitCode = await runCli()
}
