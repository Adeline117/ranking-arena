#!/usr/bin/env node

/**
 * Capture a schema-only canonical-baseline source witness without mutating the
 * source database.
 *
 * This command is deliberately separate from baseline candidate construction.
 * It emits only app-schema.sql and source-catalog.json into a caller-selected,
 * previously absent directory. It never creates a manifest, chooses a replay
 * boundary, or edits migration history.
 */

import { createHash, X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, writeSync } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { checkServerIdentity } from 'node:tls'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
  validateSourceCatalogRowContracts,
} from '../qa/baseline-source-catalog-contract.mjs'
import { validateAppSchemaSqlSafety } from '../qa/baseline-sql-safety.mjs'
import { cleanPostgresConnectionEnv } from './postgres-cli-env.mjs'

export const CAPTURE_OPT_IN_NAME = 'ARENA_CANONICAL_BASELINE_CAPTURE'
export const CAPTURE_SOURCE_URL_NAME = 'ARENA_BASELINE_SOURCE_DATABASE_URL'
export const CAPTURE_CA_FILE_NAME = 'ARENA_BASELINE_SOURCE_CA_FILE'
export { SOURCE_CATALOG_CONTRACT }
export const MINIMUM_POSTGRES_VERSION = Object.freeze({ major: 17, minor: 6 })

const APP_SCHEMAS = Object.freeze(['arena', 'public'])
const CATALOG_KEYS = SOURCE_CATALOG_KEYS
const TOOL_NAMES = Object.freeze(['pg_dump', 'psql'])
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024
const TOOL_VERSION_TIMEOUT_MS = 10_000
const PG_DUMP_TIMEOUT_MS = 90_000
const TOOL_KILL_GRACE_MS = 5_000
const CAPTURE_ARTIFACT_NAMES = Object.freeze(['app-schema.sql', 'source-catalog.json'])
const CAPTURE_INCOMPLETE_MARKER = '.arena-baseline-capture-incomplete'
const TEMPORARY_ROOT_PREFIXES = Object.freeze([
  '.arena-baseline-capture-runtime-',
  '.arena-baseline-capture-stage-',
])
const RESTRICTION_TOKEN_PATTERN = /^[A-Za-z0-9]{63}$/u
const PUBLIC_SCHEMA_CREATE_STATEMENT = 'CREATE SCHEMA "public";'
const PUBLIC_SCHEMA_NORMALIZED_COMMENT =
  '-- Arena baseline replay uses the target-provided "public" schema.'
const SAFE_CLI_ERROR_CODES = new Set(['CAPTURE_CLEANUP_FAILED', 'CAPTURE_INTERRUPTED'])

const CATALOG_QUERIES = Object.freeze({
  acls: `
    /* arena_baseline_catalog:acls */
    SELECT
      object_row.object_kind AS "objectKind",
      object_row.schema_name AS schema,
      object_row.object_name AS name,
      object_row.acl
    FROM (
      SELECT
        'relation'::text AS object_kind,
        namespace.nspname AS schema_name,
        relation.relname AS object_name,
        COALESCE(relation.relacl::text, '') AS acl
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
      UNION ALL
      SELECT
        'routine'::text,
        namespace.nspname,
        routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
        COALESCE(routine.proacl::text, '')
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = ANY($1::text[])
      UNION ALL
      SELECT
        'schema'::text,
        namespace.nspname,
        namespace.nspname,
        COALESCE(namespace.nspacl::text, '')
      FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname = ANY($1::text[])
    ) AS object_row
    ORDER BY object_row.object_kind, object_row.schema_name, object_row.object_name
  `,
  columns: `
    /* arena_baseline_catalog:columns */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS relation,
      attribute.attnum::integer AS ordinal,
      attribute.attname AS name,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
      attribute.attnotnull AS "notNull",
      attribute.attidentity AS identity,
      attribute.attgenerated AS generated,
      pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS "defaultExpression"
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = ANY($1::text[])
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY namespace.nspname, relation.relname, attribute.attnum
  `,
  constraints: `
    /* arena_baseline_catalog:constraints */
    SELECT
      COALESCE(relation_namespace.nspname, domain_namespace.nspname) AS schema,
      CASE WHEN constraint_row.contypid <> 0 THEN 'domain' ELSE 'relation' END AS "objectKind",
      COALESCE(relation.relname, '') AS relation,
      COALESCE(domain_type.typname, '') AS domain,
      constraint_row.conname AS name,
      constraint_row.contype AS type,
      constraint_row.condeferrable AS deferrable,
      constraint_row.condeferred AS "initiallyDeferred",
      constraint_row.convalidated AS validated,
      constraint_row.conislocal AS local,
      constraint_row.connoinherit AS "noInherit",
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_catalog.pg_constraint AS constraint_row
    LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
    LEFT JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_type AS domain_type ON domain_type.oid = constraint_row.contypid
    LEFT JOIN pg_catalog.pg_namespace AS domain_namespace
      ON domain_namespace.oid = domain_type.typnamespace
    WHERE relation_namespace.nspname = ANY($1::text[])
       OR domain_namespace.nspname = ANY($1::text[])
    ORDER BY COALESCE(relation_namespace.nspname, domain_namespace.nspname),
      CASE WHEN constraint_row.contypid <> 0 THEN 'domain' ELSE 'relation' END,
      COALESCE(relation.relname, domain_type.typname), constraint_row.conname
  `,
  defaultPrivileges: `
    /* arena_baseline_catalog:defaultPrivileges */
    SELECT
      pg_catalog.pg_get_userbyid(default_acl.defaclrole) AS owner,
      COALESCE(namespace.nspname, '') AS schema,
      default_acl.defaclobjtype AS "objectType",
      default_acl.defaclacl::text AS acl
    FROM pg_catalog.pg_default_acl AS default_acl
    LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
    WHERE default_acl.defaclnamespace = 0 OR namespace.nspname = ANY($1::text[])
    ORDER BY owner, schema, "objectType"
  `,
  extensions: `
    /* arena_baseline_catalog:extensions */
    SELECT
      extension.extname AS name,
      extension.extversion AS version,
      namespace.nspname AS schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    ORDER BY extension.extname
  `,
  functions: `
    /* arena_baseline_catalog:functions */
    SELECT
      namespace.nspname AS schema,
      routine.proname AS name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) AS "identityArguments",
      pg_catalog.pg_get_function_result(routine.oid) AS result,
      language.lanname AS language,
      routine.prokind AS kind,
      routine.provolatile AS volatility,
      routine.prosecdef AS "securityDefiner",
      routine.proleakproof AS leakproof,
      routine.proconfig AS configuration,
      CASE
        WHEN routine.prokind IN ('f', 'p', 'w')
          THEN pg_catalog.pg_get_functiondef(routine.oid)
        ELSE NULL
      END AS definition
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
    WHERE namespace.nspname = ANY($1::text[])
    ORDER BY namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid)
  `,
  indexes: `
    /* arena_baseline_catalog:indexes */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS relation,
      index_relation.relname AS name,
      index_row.indisunique AS "unique",
      index_row.indisprimary AS "primary",
      index_row.indisvalid AS valid,
      index_row.indisready AS ready,
      pg_catalog.pg_get_indexdef(index_row.indexrelid) AS definition
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY($1::text[])
    ORDER BY namespace.nspname, relation.relname, index_relation.relname
  `,
  policies: `
    /* arena_baseline_catalog:policies */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS relation,
      policy.polname AS name,
      policy.polpermissive AS permissive,
      policy.polcmd AS command,
      ARRAY(
        SELECT pg_catalog.pg_get_userbyid(role_oid)
        FROM pg_catalog.unnest(policy.polroles) AS role_oid
        ORDER BY pg_catalog.pg_get_userbyid(role_oid)
      )::text[] AS roles,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS "using",
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS "withCheck"
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY($1::text[])
    ORDER BY namespace.nspname, relation.relname, policy.polname
  `,
  publications: `
    /* arena_baseline_catalog:publications */
    SELECT
      publication.pubname AS name,
      publication.puballtables AS "allTables",
      publication.pubinsert AS inserts,
      publication.pubupdate AS updates,
      publication.pubdelete AS deletes,
      publication.pubtruncate AS truncates,
      publication.pubviaroot AS "viaPartitionRoot",
      membership.membership_kind AS "membershipKind",
      membership.schema_name AS schema,
      membership.relation_name AS relation,
      membership.selected_columns AS columns,
      membership.row_filter AS "rowFilter"
    FROM pg_catalog.pg_publication AS publication
    JOIN (
      SELECT
        publication_relation.prpubid AS publication_oid,
        'relation'::text AS membership_kind,
        namespace.nspname::text AS schema_name,
        relation.relname::text AS relation_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM pg_catalog.unnest(publication_relation.prattrs::smallint[])
            WITH ORDINALITY AS selected(attnum, ordinal)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = publication_relation.prrelid
           AND attribute.attnum = selected.attnum
          ORDER BY selected.ordinal
        )::text[] AS selected_columns,
        pg_catalog.pg_get_expr(
          publication_relation.prqual,
          publication_relation.prrelid,
          true
        ) AS row_filter
      FROM pg_catalog.pg_publication_rel AS publication_relation
      JOIN pg_catalog.pg_class AS relation ON relation.oid = publication_relation.prrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])

      UNION ALL

      SELECT
        publication_namespace.pnpubid,
        'schema'::text,
        namespace.nspname::text,
        ''::text,
        ARRAY[]::text[],
        NULL::text
      FROM pg_catalog.pg_publication_namespace AS publication_namespace
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = publication_namespace.pnnspid
      WHERE namespace.nspname = ANY($1::text[])

      UNION ALL

      SELECT
        all_tables_publication.oid,
        'allTables'::text,
        ''::text,
        ''::text,
        ARRAY[]::text[],
        NULL::text
      FROM pg_catalog.pg_publication AS all_tables_publication
      WHERE all_tables_publication.puballtables
    ) AS membership ON membership.publication_oid = publication.oid
    ORDER BY publication.pubname, membership.membership_kind,
      membership.schema_name, membership.relation_name
  `,
  schemas: `
    /* arena_baseline_catalog:schemas */
    SELECT
      namespace.nspname AS name,
      pg_catalog.pg_get_userbyid(namespace.nspowner) AS owner,
      COALESCE(namespace.nspacl::text, '') AS acl
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname = ANY($1::text[])
    ORDER BY namespace.nspname
  `,
  tables: `
    /* arena_baseline_catalog:tables */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS name,
      relation.relkind AS kind,
      pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
      relation.relpersistence AS persistence,
      relation.relrowsecurity AS "rowSecurity",
      relation.relforcerowsecurity AS "forceRowSecurity",
      pg_catalog.pg_get_expr(relation.relpartbound, relation.oid) AS "partitionBound"
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY($1::text[])
      AND relation.relkind IN ('r', 'p', 'S', 'f')
    ORDER BY namespace.nspname, relation.relname
  `,
  triggers: `
    /* arena_baseline_catalog:triggers */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS relation,
      trigger_row.tgname AS name,
      trigger_row.tgenabled AS enabled,
      pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY($1::text[])
      AND NOT trigger_row.tgisinternal
    ORDER BY namespace.nspname, relation.relname, trigger_row.tgname
  `,
  types: `
    /* arena_baseline_catalog:types */
    SELECT
      namespace.nspname AS schema,
      type_row.typname AS name,
      pg_catalog.pg_get_userbyid(type_row.typowner) AS owner,
      type_row.typtype AS kind,
      type_row.typcategory AS category,
      pg_catalog.format_type(type_row.oid, NULL) AS formatted,
      CASE
        WHEN type_row.typbasetype = 0 THEN NULL
        ELSE pg_catalog.format_type(type_row.typbasetype, type_row.typtypmod)
      END AS "baseType",
      type_row.typnotnull AS "notNull",
      type_row.typdefault AS "defaultExpression",
      CASE
        WHEN type_row.typcollation = 0 THEN NULL
        ELSE pg_catalog.format('%I.%I', type_collation_namespace.nspname, type_collation.collname)
      END AS "collation",
      ARRAY(
        SELECT enum_row.enumlabel
        FROM pg_catalog.pg_enum AS enum_row
        WHERE enum_row.enumtypid = type_row.oid
        ORDER BY enum_row.enumsortorder
      )::text[] AS "enumLabels",
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'collation', CASE
                WHEN attribute.attcollation = 0 THEN NULL
                ELSE pg_catalog.format(
                  '%I.%I',
                  attribute_collation_namespace.nspname,
                  attribute_collation.collname
                )
              END,
              'name', attribute.attname,
              'ordinal', attribute.attnum,
              'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            )
            ORDER BY attribute.attnum
          )
          FROM pg_catalog.pg_attribute AS attribute
          LEFT JOIN pg_catalog.pg_collation AS attribute_collation
            ON attribute_collation.oid = attribute.attcollation
          LEFT JOIN pg_catalog.pg_namespace AS attribute_collation_namespace
            ON attribute_collation_namespace.oid = attribute_collation.collnamespace
          WHERE attribute.attrelid = type_row.typrelid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ),
        '[]'::jsonb
      ) AS "compositeAttributes",
      CASE
        WHEN range_row.rngsubtype IS NULL THEN NULL
        ELSE pg_catalog.format_type(range_row.rngsubtype, NULL)
      END AS "rangeSubtype",
      CASE
        WHEN range_row.rngcollation IS NULL OR range_row.rngcollation = 0 THEN NULL
        ELSE pg_catalog.format('%I.%I', range_collation_namespace.nspname, range_collation.collname)
      END AS "rangeCollation",
      CASE
        WHEN range_row.rngcanonical IS NULL OR range_row.rngcanonical = 0 THEN NULL
        ELSE pg_catalog.format(
          '%I.%I(%s)',
          range_canonical_namespace.nspname,
          range_canonical.proname,
          pg_catalog.pg_get_function_identity_arguments(range_canonical.oid)
        )
      END AS "rangeCanonical",
      CASE
        WHEN range_row.rngsubdiff IS NULL OR range_row.rngsubdiff = 0 THEN NULL
        ELSE pg_catalog.format(
          '%I.%I(%s)',
          range_subdiff_namespace.nspname,
          range_subdiff.proname,
          pg_catalog.pg_get_function_identity_arguments(range_subdiff.oid)
        )
      END AS "rangeSubdiff"
    FROM pg_catalog.pg_type AS type_row
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
    LEFT JOIN pg_catalog.pg_class AS composite_relation ON composite_relation.oid = type_row.typrelid
    LEFT JOIN pg_catalog.pg_collation AS type_collation
      ON type_collation.oid = type_row.typcollation
    LEFT JOIN pg_catalog.pg_namespace AS type_collation_namespace
      ON type_collation_namespace.oid = type_collation.collnamespace
    LEFT JOIN pg_catalog.pg_range AS range_row
      ON range_row.rngtypid = type_row.oid OR range_row.rngmultitypid = type_row.oid
    LEFT JOIN pg_catalog.pg_collation AS range_collation
      ON range_collation.oid = range_row.rngcollation
    LEFT JOIN pg_catalog.pg_namespace AS range_collation_namespace
      ON range_collation_namespace.oid = range_collation.collnamespace
    LEFT JOIN pg_catalog.pg_proc AS range_canonical
      ON range_canonical.oid = range_row.rngcanonical
    LEFT JOIN pg_catalog.pg_namespace AS range_canonical_namespace
      ON range_canonical_namespace.oid = range_canonical.pronamespace
    LEFT JOIN pg_catalog.pg_proc AS range_subdiff ON range_subdiff.oid = range_row.rngsubdiff
    LEFT JOIN pg_catalog.pg_namespace AS range_subdiff_namespace
      ON range_subdiff_namespace.oid = range_subdiff.pronamespace
    WHERE namespace.nspname = ANY($1::text[])
      AND type_row.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
      AND type_row.typelem = 0
      AND (type_row.typtype <> 'c' OR composite_relation.relkind = 'c')
    ORDER BY namespace.nspname, type_row.typname
  `,
  views: `
    /* arena_baseline_catalog:views */
    SELECT
      namespace.nspname AS schema,
      relation.relname AS name,
      relation.relkind AS kind,
      pg_catalog.pg_get_viewdef(relation.oid, true) AS definition
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY($1::text[])
      AND relation.relkind IN ('v', 'm')
    ORDER BY namespace.nspname, relation.relname
  `,
})

const LEDGER_QUERY = `
  /* arena_baseline_ledger */
  SELECT version::text AS version, name::text AS name, statements
  FROM supabase_migrations.schema_migrations
  ORDER BY version::text, name::text
`

export class CaptureConfigurationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'CaptureConfigurationError'
    this.code = code
  }
}

function refuse(code) {
  throw new CaptureConfigurationError(code)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function decodeUrlPart(value, label) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || /[\0\r\n]/u.test(decoded)) refuse(`SOURCE_URL_${label}_INVALID`)
    return decoded
  } catch (error) {
    if (error instanceof CaptureConfigurationError) throw error
    refuse(`SOURCE_URL_${label}_INVALID`)
  }
}

export function validateSourceUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) refuse('SOURCE_URL_REQUIRED')

  let url
  try {
    url = new URL(raw)
  } catch {
    refuse('SOURCE_URL_INVALID')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) refuse('SOURCE_URL_PROTOCOL_INVALID')
  if (url.hash) refuse('SOURCE_URL_FRAGMENT_FORBIDDEN')
  if (!url.hostname || /[\0\r\n]/u.test(url.hostname)) refuse('SOURCE_URL_HOST_INVALID')
  if (
    !/^db\.[a-z0-9]{20}\.supabase\.co$/u.test(url.hostname) &&
    !/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(url.hostname)
  ) {
    refuse('SOURCE_URL_MUST_BE_SUPABASE_DIRECT_OR_SESSION')
  }
  if (url.port !== '5432') refuse('SOURCE_URL_PORT_MUST_BE_5432')
  if (!url.pathname || url.pathname === '/') refuse('SOURCE_URL_DATABASE_REQUIRED')

  const database = decodeUrlPart(url.pathname.slice(1), 'DATABASE')
  if (database.includes('/')) refuse('SOURCE_URL_DATABASE_INVALID')
  const user = decodeUrlPart(url.username, 'USER')
  const password = decodeUrlPart(url.password, 'PASSWORD')

  const options = [...url.searchParams.entries()]
  if (options.length !== 1 || options[0][0] !== 'sslmode' || options[0][1] !== 'verify-full') {
    refuse('SOURCE_URL_REQUIRES_EXACT_VERIFY_FULL')
  }

  return Object.freeze({
    database,
    host: url.hostname.replace(/^\[|\]$/gu, ''),
    password,
    port: 5432,
    user,
  })
}

async function validateCaFile(caPath) {
  if (typeof caPath !== 'string' || !path.isAbsolute(caPath)) {
    refuse('SOURCE_CA_MUST_BE_ABSOLUTE')
  }
  const normalized = path.resolve(caPath)
  let metadata
  try {
    metadata = await lstat(normalized)
  } catch {
    refuse('SOURCE_CA_UNAVAILABLE')
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) refuse('SOURCE_CA_MUST_BE_REGULAR_FILE')
  if ((metadata.mode & 0o077) !== 0) refuse('SOURCE_CA_MUST_HAVE_OWNER_ONLY_PERMISSIONS')
  const physicalPath = await realpath(normalized)
  if (physicalPath !== normalized) refuse('SOURCE_CA_PATH_MUST_NOT_USE_SYMLINKS')

  let handle
  let contents
  try {
    handle = await open(physicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const openedMetadata = await handle.stat()
    if (!openedMetadata.isFile() || (openedMetadata.mode & 0o077) !== 0) {
      refuse('SOURCE_CA_MUST_BE_REGULAR_FILE')
    }
    const currentMetadata = await lstat(normalized)
    if (
      currentMetadata.isSymbolicLink() ||
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino ||
      (await realpath(normalized)) !== normalized
    ) {
      refuse('SOURCE_CA_CHANGED_DURING_READ')
    }
    contents = await handle.readFile('utf8')
    const afterReadMetadata = await handle.stat()
    if (
      afterReadMetadata.dev !== openedMetadata.dev ||
      afterReadMetadata.ino !== openedMetadata.ino ||
      afterReadMetadata.size !== openedMetadata.size ||
      afterReadMetadata.mtimeMs !== openedMetadata.mtimeMs ||
      afterReadMetadata.ctimeMs !== openedMetadata.ctimeMs
    ) {
      refuse('SOURCE_CA_CHANGED_DURING_READ')
    }
  } catch (error) {
    if (error instanceof CaptureConfigurationError) throw error
    refuse('SOURCE_CA_UNAVAILABLE')
  } finally {
    await handle?.close().catch(() => undefined)
  }
  if (
    !contents.includes('-----BEGIN CERTIFICATE-----') ||
    !contents.includes('-----END CERTIFICATE-----') ||
    contents.includes('PRIVATE KEY')
  ) {
    refuse('SOURCE_CA_CERTIFICATE_INVALID')
  }
  let certificate
  try {
    certificate = new X509Certificate(contents)
  } catch {
    refuse('SOURCE_CA_CERTIFICATE_INVALID')
  }
  const now = Date.now()
  if (
    !certificate.ca ||
    Number.isNaN(Date.parse(certificate.validFrom)) ||
    Number.isNaN(Date.parse(certificate.validTo)) ||
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  ) {
    refuse('SOURCE_CA_CERTIFICATE_INVALID')
  }
  return contents
}

async function validateOutputDirectory(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) {
    refuse('OUTPUT_DIR_MUST_BE_EXPLICIT_ABSOLUTE_PATH')
  }
  const normalized = path.resolve(outputDir)
  if (path.basename(normalized) === '.' || path.basename(normalized) === '..') {
    refuse('OUTPUT_DIR_INVALID')
  }
  const parent = path.dirname(normalized)
  let parentMetadata
  try {
    parentMetadata = await lstat(parent)
  } catch {
    refuse('OUTPUT_PARENT_UNAVAILABLE')
  }
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    refuse('OUTPUT_PARENT_MUST_BE_REAL_DIRECTORY')
  }
  if ((await realpath(parent)) !== parent) refuse('OUTPUT_PARENT_MUST_NOT_USE_SYMLINKS')
  const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : null
  if (
    (effectiveUserId !== null && parentMetadata.uid !== effectiveUserId) ||
    (parentMetadata.mode & 0o077) !== 0
  ) {
    refuse('OUTPUT_PARENT_MUST_BE_OWNER_ONLY')
  }
  try {
    await lstat(normalized)
    refuse('OUTPUT_DIR_MUST_NOT_EXIST')
  } catch (error) {
    if (error instanceof CaptureConfigurationError) throw error
    if (error?.code !== 'ENOENT') refuse('OUTPUT_DIR_UNAVAILABLE')
  }
  return {
    outputDir: normalized,
    parent,
    parentIdentity: Object.freeze({
      dev: parentMetadata.dev,
      ino: parentMetadata.ino,
      uid: parentMetadata.uid,
    }),
  }
}

async function assertOutputParentIdentity(destination) {
  let metadata
  try {
    metadata = await lstat(destination.parent)
  } catch {
    refuse('OUTPUT_PARENT_CHANGED_DURING_CAPTURE')
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== destination.parentIdentity.dev ||
    metadata.ino !== destination.parentIdentity.ino ||
    metadata.uid !== destination.parentIdentity.uid ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(destination.parent)) !== destination.parent
  ) {
    refuse('OUTPUT_PARENT_CHANGED_DURING_CAPTURE')
  }
}

async function validateToolPath(toolPath) {
  let requestedMetadata
  try {
    requestedMetadata = await stat(toolPath)
  } catch {
    refuse('PG17_TOOLCHAIN_INCOMPLETE')
  }
  if (!requestedMetadata.isFile() || (requestedMetadata.mode & 0o111) === 0) {
    refuse('PG17_TOOLCHAIN_INCOMPLETE')
  }
  const physicalPath = await realpath(toolPath)
  const metadata = await lstat(physicalPath)
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) refuse('PG17_TOOLCHAIN_INCOMPLETE')
  return Object.freeze({
    physicalPath,
    identity: Object.freeze({
      dev: metadata.dev,
      ino: metadata.ino,
      sha256: sha256(await readFile(physicalPath)),
    }),
  })
}

function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      rejectPromise(new Error('POSTGRES_TOOL_START_FAILED'))
      return
    }
    let stdout = ''
    let stderr = ''
    let overflow = false
    let timedOut = false
    let aborted = false
    let closed = false
    let startFailed = false
    let terminationRequested = false
    let terminationFailed = false
    let forceKillTimer = null
    const timeoutMs = options.timeoutMs ?? TOOL_VERSION_TIMEOUT_MS
    const killGraceMs = options.killGraceMs ?? TOOL_KILL_GRACE_MS
    const requestTermination = (reason) => {
      if (closed || terminationRequested) return
      terminationRequested = true
      timedOut = reason === 'timeout'
      aborted = reason === 'abort'
      try {
        const sent = child.kill('SIGTERM')
        if (!sent && child.exitCode === null && child.signalCode === null) {
          terminationFailed = true
        }
      } catch {
        terminationFailed = true
      }
      forceKillTimer = setTimeout(() => {
        if (closed) return
        try {
          const sent = child.kill('SIGKILL')
          if (!sent && child.exitCode === null && child.signalCode === null) {
            terminationFailed = true
          }
        } catch {
          terminationFailed = true
        }
      }, killGraceMs)
    }
    const timeout = setTimeout(() => requestTermination('timeout'), timeoutMs)
    const abort = () => requestTermination('abort')
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const clearTimers = () => {
      clearTimeout(timeout)
      if (forceKillTimer !== null) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
    }
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) + chunk.length > MAX_TOOL_OUTPUT_BYTES) {
        overflow = true
        requestTermination('overflow')
        return current
      }
      return current + chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', () => {
      startFailed = true
    })
    child.once('close', (code, signal) => {
      closed = true
      clearTimers()
      if (startFailed) {
        rejectPromise(new Error('POSTGRES_TOOL_START_FAILED'))
        return
      }
      resolvePromise({
        aborted,
        code: code ?? 1,
        overflow,
        signal,
        stderr,
        stdout,
        terminationFailed,
        timedOut,
      })
    })
  })
}

function parsePostgresVersion(output) {
  const match = /PostgreSQL[^0-9]*([0-9]+)\.([0-9]+)(?:\.([0-9]+))?(?:[^0-9]|$)/u.exec(output)
  if (!match) refuse('PG17_TOOL_VERSION_UNRECOGNIZED')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
    text: `${match[1]}.${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`,
  }
}

function toolEnvironment(env) {
  const childEnv = {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  }
  for (const name of ['PATH', 'SystemRoot', 'WINDIR']) {
    if (typeof env[name] === 'string' && env[name].length > 0) childEnv[name] = env[name]
  }
  return cleanPostgresConnectionEnv(childEnv)
}

async function assertToolIdentity(toolPath, identity) {
  let metadata
  try {
    metadata = await lstat(toolPath)
  } catch {
    refuse('PG17_TOOL_CHANGED_DURING_CAPTURE')
  }
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o111) === 0 ||
    metadata.dev !== identity.dev ||
    metadata.ino !== identity.ino ||
    (await realpath(toolPath)) !== toolPath ||
    sha256(await readFile(toolPath)) !== identity.sha256
  ) {
    refuse('PG17_TOOL_CHANGED_DURING_CAPTURE')
  }
}

export async function inspectPg17Toolchain(
  pgBin,
  runCommand = defaultRunCommand,
  env = process.env,
  signal
) {
  if (typeof pgBin !== 'string' || !path.isAbsolute(pgBin)) refuse('PG17_BIN_MUST_BE_ABSOLUTE')
  let binMetadata
  try {
    binMetadata = await stat(pgBin)
  } catch {
    refuse('PG17_BIN_UNAVAILABLE')
  }
  if (!binMetadata.isDirectory()) refuse('PG17_BIN_UNAVAILABLE')

  const tools = {}
  const identities = {}
  let expectedVersion = null
  let expectedPhysicalDirectory = null
  for (const name of TOOL_NAMES) {
    throwIfAborted(signal)
    const requestedPath = path.join(pgBin, name)
    const { identity, physicalPath } = await validateToolPath(requestedPath)
    const physicalDirectory = path.dirname(physicalPath)
    if (expectedPhysicalDirectory !== null && expectedPhysicalDirectory !== physicalDirectory) {
      refuse('PG17_TOOLS_MUST_SHARE_ONE_PHYSICAL_DIRECTORY')
    }
    expectedPhysicalDirectory = physicalDirectory
    const result = await runCommand(physicalPath, ['--version'], {
      env: toolEnvironment(env),
      signal,
      timeoutMs: TOOL_VERSION_TIMEOUT_MS,
    })
    throwIfAborted(signal)
    if (
      result.code !== 0 ||
      result.signal ||
      result.overflow ||
      result.terminationFailed ||
      result.timedOut
    ) {
      refuse('PG17_TOOL_VERSION_FAILED')
    }
    const version = parsePostgresVersion(`${result.stdout}\n${result.stderr}`)
    if (
      version.major !== MINIMUM_POSTGRES_VERSION.major ||
      version.minor < MINIMUM_POSTGRES_VERSION.minor
    ) {
      refuse('PG17_6_OR_NEWER_REQUIRED')
    }
    if (expectedVersion !== null && expectedVersion !== version.text) {
      refuse('PG17_TOOLS_MUST_HAVE_EXACT_VERSION')
    }
    expectedVersion = version.text
    await assertToolIdentity(physicalPath, identity)
    tools[name] = physicalPath
    identities[name] = identity
  }
  return Object.freeze({
    ...tools,
    identities: Object.freeze(identities),
    version: expectedVersion,
  })
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value instanceof Date ? value.toISOString() : value
}

function canonicalRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`CAPTURE_${label.toUpperCase()}_ROWS_INVALID`)
  const normalized = rows.map((row) => canonicalize(row))
  normalized.sort((left, right) => {
    const leftKey = JSON.stringify(left)
    const rightKey = JSON.stringify(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  for (let index = 1; index < normalized.length; index += 1) {
    if (JSON.stringify(normalized[index - 1]) === JSON.stringify(normalized[index])) {
      throw new Error(`CAPTURE_${label.toUpperCase()}_ROWS_DUPLICATED`)
    }
  }
  return normalized
}

function ledgerDigest(statements) {
  return sha256(
    JSON.stringify({
      kind: 'sql-statements',
      value: canonicalize(statements),
    })
  )
}

function normalizeLedger(rows) {
  if (!Array.isArray(rows)) throw new Error('CAPTURE_LEDGER_ROWS_INVALID')
  const modernVersions = new Set()
  const ledger = rows.map((row) => {
    for (const key of ['version', 'name']) {
      if (
        typeof row?.[key] !== 'string' ||
        row[key].length === 0 ||
        row[key].trim() !== row[key] ||
        /[\u0000-\u001f\u007f]/u.test(row[key])
      ) {
        throw new Error(`CAPTURE_LEDGER_${key.toUpperCase()}_INVALID`)
      }
    }
    if (
      row.statements !== null &&
      (!Array.isArray(row.statements) || row.statements.some((value) => typeof value !== 'string'))
    ) {
      throw new Error('CAPTURE_LEDGER_STATEMENTS_INVALID')
    }
    if (/^\d{14}$/u.test(row.version)) {
      if (modernVersions.has(row.version))
        throw new Error('CAPTURE_LEDGER_MODERN_VERSION_DUPLICATED')
      modernVersions.add(row.version)
    }
    return {
      name: row.name,
      statementsSha256: ledgerDigest(row.statements),
      version: row.version,
    }
  })
  if (modernVersions.size === 0) throw new Error('CAPTURE_LEDGER_MODERN_BOUNDARY_MISSING')
  return canonicalRows(ledger, 'ledger')
}

function assertNoCredentialLikeData(contents, label) {
  const patterns = [
    /\bpostgres(?:ql)?:\/\/[^\s'"<>]+/iu,
    /\bhttps?:\/\/[a-z0-9-]+\.supabase\.co\b/iu,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}\b/u,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
    /https:\/\/hooks\.slack\.com\/services\//iu,
    /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/u,
  ]
  if (patterns.some((pattern) => pattern.test(contents))) {
    throw new Error(`${label}_CONTAINS_CREDENTIAL_LIKE_DATA`)
  }
}

function assertNoSourceConnectionData(contents, label, source, rawSourceUrl) {
  for (const value of [rawSourceUrl, source.host, source.password]) {
    if (typeof value === 'string' && value.length > 0 && contents.includes(value)) {
      throw new Error(`${label}_CONTAINS_SOURCE_CONNECTION_DATA`)
    }
  }
}

function normalizeTargetProvidedPublicSchema(contents) {
  const lines = contents.split('\n')
  const matches = []
  for (const [index, line] of lines.entries()) {
    if (line === PUBLIC_SCHEMA_CREATE_STATEMENT) matches.push(index)
  }
  if (matches.length !== 1) {
    throw new Error('APP_SCHEMA_REQUIRES_EXACTLY_ONE_PUBLIC_SCHEMA_CREATE')
  }
  lines[matches[0]] = PUBLIC_SCHEMA_NORMALIZED_COMMENT
  return lines.join('\n')
}

function capturedAtIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('SOURCE_TRANSACTION_TIMESTAMP_INVALID')
  return date.toISOString()
}

function validateServerSnapshot(row) {
  const versionNumber = Number(row?.server_version_num)
  if (!Number.isInteger(versionNumber) || versionNumber < 170006 || versionNumber >= 180000) {
    throw new Error('SOURCE_POSTGRES_17_6_OR_NEWER_REQUIRED')
  }
  if (row?.transaction_read_only !== 'on') throw new Error('SOURCE_TRANSACTION_NOT_READ_ONLY')
  if (
    typeof row?.snapshot_id !== 'string' ||
    row.snapshot_id.length === 0 ||
    row.snapshot_id.length > 256 ||
    !/^[A-Za-z0-9-]+$/u.test(row.snapshot_id)
  ) {
    throw new Error('SOURCE_SNAPSHOT_ID_INVALID')
  }
  return {
    capturedAt: capturedAtIso(row.transaction_timestamp),
    snapshotId: row.snapshot_id,
  }
}

function clientConfiguration(source, caContents) {
  return {
    application_name: 'arena-canonical-baseline-readonly-capture',
    connectionTimeoutMillis: 10_000,
    database: source.database,
    host: source.host,
    options:
      '-c default_transaction_read_only=on -c search_path=pg_catalog -c TimeZone=UTC -c DateStyle=ISO,MDY -c extra_float_digits=3',
    password: source.password,
    port: source.port,
    query_timeout: 65_000,
    ssl: {
      ca: caContents,
      checkServerIdentity,
      rejectUnauthorized: true,
      servername: source.host,
    },
    user: source.user,
  }
}

function pgDumpEnvironment(env, source, privateCaPath, privateHome) {
  const childEnv = Object.assign(toolEnvironment(env), {
    HOME: privateHome,
    PGAPPNAME: 'arena-canonical-baseline-readonly-capture',
    PGCLIENTENCODING: 'UTF8',
    PGCONNECT_TIMEOUT: '10',
    PGDATABASE: source.database,
    PGDATESTYLE: 'ISO, MDY',
    PGGSSENCMODE: 'disable',
    PGHOST: source.host,
    PGOPTIONS:
      '-c default_transaction_read_only=on -c search_path=pg_catalog -c TimeZone=UTC -c DateStyle=ISO,MDY -c extra_float_digits=3',
    PGPASSWORD: source.password,
    PGPASSFILE: path.join(privateHome, 'nonexistent-pgpass'),
    PGPORT: String(source.port),
    PGSERVICEFILE: path.join(privateHome, 'nonexistent-pg-service.conf'),
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: privateCaPath,
    PGSSLSNI: '1',
    PGTZ: 'UTC',
    PGUSER: source.user,
    TMPDIR: path.dirname(privateHome),
    XDG_CONFIG_HOME: path.join(privateHome, '.config'),
  })
  return childEnv
}

function throwIfAborted(signal) {
  if (signal?.aborted) refuse('CAPTURE_INTERRUPTED')
}

function pgDumpArguments(snapshotId, outputPath) {
  return [
    '--schema-only',
    '--format=plain',
    '--encoding=UTF8',
    '--exclude-extension=*',
    '--no-owner',
    '--no-password',
    '--no-publications',
    '--no-security-labels',
    '--no-subscriptions',
    '--strict-names',
    '--quote-all-identifiers',
    `--snapshot=${snapshotId}`,
    `--file=${outputPath}`,
    ...APP_SCHEMAS.map((schema) => `--schema=${schema}`),
  ]
}

async function privateDirectoryIdentity(target) {
  const metadata = await lstat(target)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('CAPTURE_PRIVATE_DIRECTORY_INVALID')
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino })
}

async function regularFileIdentity(target) {
  const metadata = await lstat(target)
  const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : null
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (effectiveUserId !== null && metadata.uid !== effectiveUserId) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('CAPTURE_PRIVATE_FILE_INVALID')
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino })
}

async function safeRemove(target, destination, expectedIdentity) {
  if (!target) return
  if (
    path.dirname(target) !== destination.parent ||
    !TEMPORARY_ROOT_PREFIXES.some((prefix) => path.basename(target).startsWith(prefix)) ||
    !expectedIdentity
  ) {
    throw new Error('CAPTURE_CLEANUP_TARGET_INVALID')
  }
  await assertOutputParentIdentity(destination)
  let metadata
  try {
    metadata = await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== expectedIdentity.dev ||
    metadata.ino !== expectedIdentity.ino
  ) {
    throw new Error('CAPTURE_CLEANUP_TARGET_INVALID')
  }
  if (path.dirname(await realpath(target)) !== destination.parent) {
    throw new Error('CAPTURE_CLEANUP_TARGET_INVALID')
  }
  await rm(target, { force: true, recursive: true })
}

async function claimOutputDirectory(destination) {
  await assertOutputParentIdentity(destination)
  try {
    await mkdir(destination.outputDir, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') refuse('OUTPUT_DIR_APPEARED_DURING_CAPTURE')
    refuse('OUTPUT_DIR_CLAIM_FAILED')
  }
  let identity = null
  try {
    identity = await privateDirectoryIdentity(destination.outputDir)
    const metadata = await lstat(destination.outputDir)
    if (
      metadata.uid !== destination.parentIdentity.uid ||
      (metadata.mode & 0o077) !== 0 ||
      (await realpath(destination.outputDir)) !== destination.outputDir
    ) {
      throw new Error('CAPTURE_OUTPUT_CLAIM_INVALID')
    }
    return identity
  } catch (error) {
    let cleaned = false
    if (identity !== null) {
      try {
        const metadata = await lstat(destination.outputDir)
        if (
          !metadata.isSymbolicLink() &&
          metadata.isDirectory() &&
          metadata.dev === identity.dev &&
          metadata.ino === identity.ino &&
          (await readdir(destination.outputDir)).length === 0
        ) {
          await rmdir(destination.outputDir)
          cleaned = true
        }
      } catch {
        // The caller must see explicit uncertain cleanup, never a false success.
      }
    }
    if (!cleaned) throw new Error('CAPTURE_CLEANUP_FAILED', { cause: error })
    throw error
  }
}

async function assertClaimedOutputIdentity(destination, expectedIdentity) {
  await assertOutputParentIdentity(destination)
  let metadata
  try {
    metadata = await lstat(destination.outputDir)
  } catch {
    throw new Error('CAPTURE_OUTPUT_CLAIM_CHANGED')
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== expectedIdentity.dev ||
    metadata.ino !== expectedIdentity.ino ||
    metadata.uid !== destination.parentIdentity.uid ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(destination.outputDir)) !== destination.outputDir
  ) {
    throw new Error('CAPTURE_OUTPUT_CLAIM_CHANGED')
  }
}

async function removeClaimedOutput(destination, expectedIdentity, ownedEntries) {
  if (!expectedIdentity) return
  await assertClaimedOutputIdentity(destination, expectedIdentity)
  const entries = await readdir(destination.outputDir)
  for (const entry of entries) {
    const identity = ownedEntries.get(entry)
    if (!identity) throw new Error('CAPTURE_OUTPUT_CLEANUP_ENTRY_INVALID')
    const entryPath = path.join(destination.outputDir, entry)
    const metadata = await lstat(entryPath)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino
    ) {
      throw new Error('CAPTURE_OUTPUT_CLEANUP_ENTRY_INVALID')
    }
  }
  for (const entry of entries) await unlink(path.join(destination.outputDir, entry))
  await rmdir(destination.outputDir)
}

async function assertClaimedOutputEntries(
  destination,
  expectedIdentity,
  ownedEntries,
  expectedNames
) {
  await assertClaimedOutputIdentity(destination, expectedIdentity)
  const entries = (await readdir(destination.outputDir)).sort()
  if (JSON.stringify(entries) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error('CAPTURE_OUTPUT_ARTIFACT_SET_INVALID')
  }
  for (const entry of entries) {
    const expectedEntryIdentity = ownedEntries.get(entry)
    if (!expectedEntryIdentity) throw new Error('CAPTURE_OUTPUT_ARTIFACT_IDENTITY_INVALID')
    const metadata = await lstat(path.join(destination.outputDir, entry))
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.dev !== expectedEntryIdentity.dev ||
      metadata.ino !== expectedEntryIdentity.ino
    ) {
      throw new Error('CAPTURE_OUTPUT_ARTIFACT_IDENTITY_INVALID')
    }
  }
}

export async function captureCanonicalBaseline({
  clientFactory,
  commitOutputMarker = unlink,
  env = process.env,
  outputDir,
  pgDumpTimeoutMs = PG_DUMP_TIMEOUT_MS,
  removeTemporaryRoot = safeRemove,
  runCommand = defaultRunCommand,
  signal,
  toolKillGraceMs = TOOL_KILL_GRACE_MS,
} = {}) {
  if (env[CAPTURE_OPT_IN_NAME] !== '1') refuse('EXACT_CAPTURE_OPT_IN_REQUIRED')
  throwIfAborted(signal)
  const destination = await validateOutputDirectory(outputDir)
  const rawSourceUrl = env[CAPTURE_SOURCE_URL_NAME]
  const source = validateSourceUrl(rawSourceUrl)
  const caContents = await validateCaFile(env[CAPTURE_CA_FILE_NAME])
  const toolchain = await inspectPg17Toolchain(env.PG17_BIN, runCommand, env, signal)
  const makeClient = clientFactory ?? ((configuration) => new pg.Client(configuration))

  let stageRoot = null
  let stageIdentity = null
  let runtimeRoot = null
  let runtimeIdentity = null
  let outputIdentity = null
  let outputCommitted = false
  const ownedOutputEntries = new Map()
  let client = null
  let clientClosePromise = null
  let transactionOpen = false
  let abortClient = null
  const closeClient = () => {
    if (clientClosePromise === null) {
      const activeClient = client
      clientClosePromise = activeClient
        ? Promise.resolve().then(() => activeClient.end())
        : Promise.resolve()
    }
    return clientClosePromise
  }
  try {
    throwIfAborted(signal)
    await assertOutputParentIdentity(destination)
    stageRoot = await mkdtemp(path.join(destination.parent, '.arena-baseline-capture-stage-'))
    stageIdentity = await privateDirectoryIdentity(stageRoot)
    runtimeRoot = await mkdtemp(path.join(destination.parent, '.arena-baseline-capture-runtime-'))
    runtimeIdentity = await privateDirectoryIdentity(runtimeRoot)
    await assertOutputParentIdentity(destination)
    await chmod(stageRoot, 0o700)
    await chmod(runtimeRoot, 0o700)
    const privateHome = path.join(runtimeRoot, 'home')
    await mkdir(privateHome, { mode: 0o700 })
    const privateCaPath = path.join(runtimeRoot, 'source-ca.pem')
    await writeFile(privateCaPath, caContents, { flag: 'wx', mode: 0o600 })

    client = makeClient(clientConfiguration(source, caContents))
    abortClient = () => {
      void closeClient().catch(() => undefined)
    }
    signal?.addEventListener('abort', abortClient, { once: true })
    if (signal?.aborted) abortClient()
    await client.connect()
    throwIfAborted(signal)
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", ['60000ms'])
    await client.query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", ['5000ms'])
    await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
    await client.query("SELECT pg_catalog.set_config('TimeZone', 'UTC', true)")
    await client.query("SELECT pg_catalog.set_config('DateStyle', 'ISO, MDY', true)")
    await client.query("SELECT pg_catalog.set_config('extra_float_digits', '3', true)")
    const snapshotRow = (
      await client.query(`
        SELECT
          pg_catalog.current_setting('server_version_num') AS server_version_num,
          pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
          pg_catalog.transaction_timestamp() AS transaction_timestamp,
          pg_catalog.pg_export_snapshot() AS snapshot_id
      `)
    ).rows[0]
    const snapshot = validateServerSnapshot(snapshotRow)

    const catalog = {}
    for (const key of CATALOG_KEYS) {
      const values = key === 'extensions' ? [] : [APP_SCHEMAS]
      const result = await client.query(CATALOG_QUERIES[key], values)
      catalog[key] = canonicalRows(result.rows, key)
      throwIfAborted(signal)
    }
    const ledger = normalizeLedger((await client.query(LEDGER_QUERY)).rows)

    const dumpPath = path.join(stageRoot, 'app-schema.sql')
    throwIfAborted(signal)
    await assertToolIdentity(toolchain.pg_dump, toolchain.identities.pg_dump)
    const dumpResult = await runCommand(
      toolchain.pg_dump,
      pgDumpArguments(snapshot.snapshotId, dumpPath),
      {
        env: pgDumpEnvironment(env, source, privateCaPath, privateHome),
        killGraceMs: toolKillGraceMs,
        signal,
        timeoutMs: pgDumpTimeoutMs,
      }
    )
    throwIfAborted(signal)
    if (
      dumpResult.code !== 0 ||
      dumpResult.signal ||
      dumpResult.overflow ||
      dumpResult.terminationFailed ||
      dumpResult.timedOut
    ) {
      throw new Error('PG_DUMP_SCHEMA_CAPTURE_FAILED')
    }

    const rawAppSchema = await readFile(dumpPath, 'utf8')
    assertNoSourceConnectionData(rawAppSchema, 'APP_SCHEMA', source, rawSourceUrl)
    assertNoCredentialLikeData(rawAppSchema, 'APP_SCHEMA')
    const appSchema = normalizeTargetProvidedPublicSchema(rawAppSchema)
    validateAppSchemaSqlSafety(appSchema, { label: 'captured app-schema.sql' })
    await writeFile(dumpPath, appSchema, { mode: 0o600 })
    await chmod(dumpPath, 0o600)

    const sourceCatalog = {
      capturedAt: snapshot.capturedAt,
      catalog,
      contract: SOURCE_CATALOG_CONTRACT,
      ledger,
      postgresMajor: 17,
    }
    validateSourceCatalogRowContracts(sourceCatalog.catalog)
    const sourceCatalogJson = `${JSON.stringify(sourceCatalog, null, 2)}\n`
    assertNoSourceConnectionData(sourceCatalogJson, 'SOURCE_CATALOG', source, rawSourceUrl)
    assertNoCredentialLikeData(sourceCatalogJson, 'SOURCE_CATALOG')
    await writeFile(path.join(stageRoot, 'source-catalog.json'), sourceCatalogJson, {
      flag: 'wx',
      mode: 0o600,
    })

    // The exported snapshot remains owned by this transaction until pg_dump,
    // every catalog read, validation, and artifact write have completed.
    await client.query('ROLLBACK')
    transactionOpen = false
    throwIfAborted(signal)
    await closeClient()
    client = null
    throwIfAborted(signal)

    await removeTemporaryRoot(runtimeRoot, destination, runtimeIdentity)
    runtimeRoot = null
    runtimeIdentity = null

    // Publishing deliberately changes the old rename contract. An exclusive
    // mkdir is the kernel-level no-overwrite claim on every supported platform.
    // The destination is not complete while its marker exists; exact-file
    // consumers must reject it until the marker is atomically removed.
    throwIfAborted(signal)
    outputIdentity = await claimOutputDirectory(destination)
    const markerPath = path.join(destination.outputDir, CAPTURE_INCOMPLETE_MARKER)
    await writeFile(markerPath, 'incomplete\n', { flag: 'wx', mode: 0o600 })
    ownedOutputEntries.set(CAPTURE_INCOMPLETE_MARKER, await regularFileIdentity(markerPath))
    throwIfAborted(signal)

    const stagedEntries = (await readdir(stageRoot)).sort()
    if (JSON.stringify(stagedEntries) !== JSON.stringify(CAPTURE_ARTIFACT_NAMES)) {
      throw new Error('CAPTURE_STAGE_ARTIFACT_SET_INVALID')
    }
    for (const name of CAPTURE_ARTIFACT_NAMES) {
      const sourcePath = path.join(stageRoot, name)
      const sourceIdentity = await regularFileIdentity(sourcePath)
      await link(sourcePath, path.join(destination.outputDir, name))
      ownedOutputEntries.set(name, sourceIdentity)
      throwIfAborted(signal)
    }

    const expectedIncompleteEntries = [...CAPTURE_ARTIFACT_NAMES, CAPTURE_INCOMPLETE_MARKER].sort()
    await assertClaimedOutputEntries(
      destination,
      outputIdentity,
      ownedOutputEntries,
      expectedIncompleteEntries
    )

    await removeTemporaryRoot(stageRoot, destination, stageIdentity)
    stageRoot = null
    stageIdentity = null
    await assertClaimedOutputEntries(
      destination,
      outputIdentity,
      ownedOutputEntries,
      expectedIncompleteEntries
    )
    throwIfAborted(signal)

    // Removing the marker is the commit point. A signal delivered after the
    // final abort gate loses to a successful unlink: the complete capture is
    // reported as success and is never cleaned up as an interrupted attempt.
    await commitOutputMarker(markerPath)
    ownedOutputEntries.delete(CAPTURE_INCOMPLETE_MARKER)
    outputCommitted = true

    return Object.freeze({
      artifactCount: 2,
      capturedAt: snapshot.capturedAt,
      outputDir: destination.outputDir,
      postgresVersion: toolchain.version,
      status: 'source-capture/not-a-candidate',
    })
  } catch (error) {
    if (client) {
      if (clientClosePromise === null && transactionOpen) {
        await client.query('ROLLBACK').catch(() => undefined)
      }
      await closeClient().catch(() => undefined)
      client = null
    }
    let cleanupFailed = false
    if (!outputCommitted && outputIdentity) {
      try {
        await removeClaimedOutput(destination, outputIdentity, ownedOutputEntries)
      } catch {
        cleanupFailed = true
      }
    }
    for (const [target, identity] of [
      [stageRoot, stageIdentity],
      [runtimeRoot, runtimeIdentity],
    ]) {
      try {
        await removeTemporaryRoot(target, destination, identity)
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) throw new Error('CAPTURE_CLEANUP_FAILED', { cause: error })
    throw error
  } finally {
    if (abortClient) signal?.removeEventListener('abort', abortClient)
  }
}

function parseCliArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--output-dir' || !argv[1]) {
    refuse('USAGE_REQUIRES_OUTPUT_DIR')
  }
  return { outputDir: argv[1] }
}

function safeCliErrorCode(error) {
  if (error instanceof CaptureConfigurationError) return error.code
  if (SAFE_CLI_ERROR_CODES.has(error?.message)) return error.message
  return 'CAPTURE_FAILED'
}

function directExitCode(result, receivedSignal) {
  if (result === 0) return 0
  if (receivedSignal === 'SIGINT') return 130
  if (receivedSignal === 'SIGTERM') return 143
  return result
}

export async function runCli({
  argv = process.argv.slice(2),
  captureBaseline = captureCanonicalBaseline,
  env = process.env,
  signal,
  writeError = (value) => writeSync(2, value),
  writeOutput = (value) => writeSync(1, value),
} = {}) {
  let result
  try {
    result = await captureBaseline({ env, signal, ...parseCliArguments(argv) })
  } catch (error) {
    const code = safeCliErrorCode(error)
    try {
      await Promise.resolve(writeError(`Canonical baseline capture refused: ${code}\n`))
    } catch {
      // Reporting failure cannot change the already determined capture result.
    }
    return 2
  }
  try {
    await Promise.resolve(
      writeOutput(
        `Canonical baseline source capture published (${result.artifactCount} artifacts; not a candidate).\n`
      )
    )
  } catch {
    // A committed output must never become an error exit solely because stdout
    // closed; that would invite an unsafe automated retry of a successful run.
  }
  return 0
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) {
  const controller = new AbortController()
  let receivedSignal = null
  const interrupt = () => {
    receivedSignal ??= 'SIGINT'
    controller.abort()
  }
  const terminate = () => {
    receivedSignal ??= 'SIGTERM'
    controller.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const result = await runCli({ signal: controller.signal })
    process.exitCode = directExitCode(result, receivedSignal)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

export const _captureContractForTests = Object.freeze({
  appSchemas: APP_SCHEMAS,
  captureArtifactNames: CAPTURE_ARTIFACT_NAMES,
  captureIncompleteMarker: CAPTURE_INCOMPLETE_MARKER,
  catalogKeys: CATALOG_KEYS,
  catalogQueries: CATALOG_QUERIES,
  directExitCode,
  ledgerQuery: LEDGER_QUERY,
  normalizeTargetProvidedPublicSchema,
  pgDumpArguments,
  publicSchemaCreateStatement: PUBLIC_SCHEMA_CREATE_STATEMENT,
  restrictionTokenPattern: RESTRICTION_TOKEN_PATTERN,
  safeRemove,
  safeCliErrorCode,
  toolKillGraceMs: TOOL_KILL_GRACE_MS,
})
