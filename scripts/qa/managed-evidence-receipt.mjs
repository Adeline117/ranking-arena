#!/usr/bin/env node

/**
 * Offline validator for self-asserted claims collected during the managed-
 * scratch phase. A structurally valid receipt does not prove that an external
 * evidence file exists, recompute any claimed hash, or authorize a production
 * restore, migration, deployment, or worker start.
 */

import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANAGED_EVIDENCE_RECEIPT_CONTRACT = 'arena.managed-scratch-evidence-receipt@1'
export const MANAGED_EVIDENCE_RECEIPT_STATUS = 'receipt/claims-only'
export const MANAGED_EVIDENCE_SCHEMA_PATH = 'scripts/qa/managed-evidence-receipt.schema.json'

const MAX_RECEIPT_BYTES = 1024 * 1024
const COMPLETE_BACKUP_MIN_BYTES = 1024 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u
const POSTGRES_17_PATTERN = /^17(?:\.[0-9]+){1,3}$/u
const SAFE_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const SAFE_OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/u
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u
const RESULT_VALUES = new Set(['failed', 'passed'])
const CHECK_RESULT_VALUES = new Set(['failed', 'not-applicable', 'not-covered', 'passed'])
const SECRET_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|authorization|bearer|cookie|credentials?|database[_-]?url|jwt|pass(?:word|wd)?|private[_-]?key|secret|session|token)(?:$|[_-])/iu
const ALLOWED_NEGATIVE_SECURITY_FIELDS = new Set(['production_credentials_present'])
const URL_PATTERN = /\b(?:https?|postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|ssh|wss?):\/\//iu
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,})\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/iu,
])
const LIVE_GO_CLAIM_PATTERN =
  /^(?:go|live-go|production-go|production-ready|approved-for-production|release-approved)$/iu

class ReceiptValidationError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new ReceiptValidationError(code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function object(value, pathName, keys) {
  if (!isPlainObject(value)) fail(`${pathName}:OBJECT_REQUIRED`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${pathName}:EXACT_FIELDS_REQUIRED`)
  }
  return value
}

function array(value, pathName, { length, minimum = 0 } = {}) {
  if (!Array.isArray(value)) fail(`${pathName}:ARRAY_REQUIRED`)
  if (length !== undefined && value.length !== length) fail(`${pathName}:EXACT_LENGTH_REQUIRED`)
  if (value.length < minimum) fail(`${pathName}:MINIMUM_LENGTH_REQUIRED`)
  return value
}

function literal(value, expected, pathName) {
  if (value !== expected) fail(`${pathName}:EXPECTED_${String(expected).toUpperCase()}`)
  return value
}

function oneOf(value, expected, pathName) {
  if (!expected.has(value)) fail(`${pathName}:UNSUPPORTED_VALUE`)
  return value
}

function boolean(value, pathName) {
  if (typeof value !== 'boolean') fail(`${pathName}:BOOLEAN_REQUIRED`)
  return value
}

function integer(value, pathName, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${pathName}:INTEGER_REQUIRED`)
  return value
}

function string(value, pathName, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail(`${pathName}:STRING_REQUIRED`)
  }
  if (pattern && !pattern.test(value)) fail(`${pathName}:INVALID_FORMAT`)
  return value
}

function nullableHash(value, pathName) {
  if (value === null) return null
  return string(value, pathName, SHA256_PATTERN)
}

function timestamp(value, pathName) {
  string(value, pathName, UTC_TIMESTAMP_PATTERN)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalizeTimestamp(value)) {
    fail(`${pathName}:INVALID_TIMESTAMP`)
  }
  return parsed.getTime()
}

function normalizeTimestamp(value) {
  return value.includes('.') ? value : value.replace('Z', '.000Z')
}

function assertAtOrBefore(left, right, code) {
  if (left > right) fail(code)
}

function assertSensitiveDataAbsent(value, pathName = 'receipt', seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    if (/\p{Cc}/u.test(value)) fail(`${pathName}:CONTROL_CHARACTER_FORBIDDEN`)
    if (URL_PATTERN.test(value)) fail(`${pathName}:URL_FORBIDDEN`)
    if (LIVE_GO_CLAIM_PATTERN.test(value)) fail(`${pathName}:LIVE_GO_CLAIM_FORBIDDEN`)
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) fail(`${pathName}:SECRET_LIKE_VALUE_FORBIDDEN`)
    }
    return
  }
  if (typeof value !== 'object') fail(`${pathName}:JSON_VALUE_REQUIRED`)
  if (seen.has(value)) fail(`${pathName}:CYCLIC_VALUE_FORBIDDEN`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSensitiveDataAbsent(entry, `${pathName}[${index}]`, seen))
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (
        !SAFE_OBJECT_KEY_PATTERN.test(key) ||
        URL_PATTERN.test(key) ||
        LIVE_GO_CLAIM_PATTERN.test(key) ||
        SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(key))
      ) {
        fail('receipt:UNSAFE_OBJECT_KEY_FORBIDDEN')
      }
      if (SECRET_KEY_PATTERN.test(key) && !ALLOWED_NEGATIVE_SECURITY_FIELDS.has(key)) {
        fail('receipt:SECRET_LIKE_FIELD_FORBIDDEN')
      }
      // Never put an untrusted object key in a surfaced error code.
      assertSensitiveDataAbsent(entry, `${pathName}.*`, seen)
    }
  }
  seen.delete(value)
}

function validateExtensionCatalog(value, pathName) {
  const extensions = array(value, pathName, { minimum: 1 })
  const names = new Set()
  let previous = null
  for (const [index, extension] of extensions.entries()) {
    const extensionPath = `${pathName}[${index}]`
    object(extension, extensionPath, ['name', 'schema', 'version'])
    const name = string(extension.name, `${extensionPath}.name`, SAFE_LABEL_PATTERN)
    const schema = string(extension.schema, `${extensionPath}.schema`, SAFE_LABEL_PATTERN)
    const version = string(extension.version, `${extensionPath}.version`, SAFE_LABEL_PATTERN)
    if (names.has(name)) fail(`${pathName}:DUPLICATE_EXTENSION_NAME`)
    names.add(name)
    const sortKey = `${name}\u0000${schema}\u0000${version}`
    if (previous !== null && sortKey <= previous) {
      fail(`${pathName}:EXTENSIONS_MUST_BE_CANONICALLY_SORTED`)
    }
    previous = sortKey
  }
  return extensions
}

function validateProviderIncident(value) {
  object(value, 'provider_incident', [
    'evidence_sha256',
    'incident_identity_sha256',
    'resolved_at',
    'status',
  ])
  string(value.evidence_sha256, 'provider_incident.evidence_sha256', SHA256_PATTERN)
  string(
    value.incident_identity_sha256,
    'provider_incident.incident_identity_sha256',
    SHA256_PATTERN
  )
  const resolvedAt = timestamp(value.resolved_at, 'provider_incident.resolved_at')
  literal(value.status, 'resolved/evidence-only', 'provider_incident.status')
  return { resolvedAt }
}

function validateTarget(value, pathName, { kind, minimumDiskGiB, emptyAtStart }) {
  object(value, pathName, [
    'capacity_slot_sha256',
    'clean_at_start',
    'compute_class',
    'created_at',
    'deleted_at',
    'deletion_due_at',
    'deletion_owner_sha256',
    'deletion_receipt_sha256',
    'deletion_status',
    'disk_gib',
    'empty_at_start',
    'extensions',
    'identity_sha256',
    'isolated_from_production',
    'kind',
    'outbound_side_effects_quarantined',
    'postgres_version',
    'production_aliases_attached',
    'production_credentials_present',
    'region',
  ])
  string(value.capacity_slot_sha256, `${pathName}.capacity_slot_sha256`, SHA256_PATTERN)
  literal(value.clean_at_start, true, `${pathName}.clean_at_start`)
  string(value.compute_class, `${pathName}.compute_class`, SAFE_LABEL_PATTERN)
  const createdAt = timestamp(value.created_at, `${pathName}.created_at`)
  const deletedAt = timestamp(value.deleted_at, `${pathName}.deleted_at`)
  const deletionDueAt = timestamp(value.deletion_due_at, `${pathName}.deletion_due_at`)
  string(value.deletion_owner_sha256, `${pathName}.deletion_owner_sha256`, SHA256_PATTERN)
  string(value.deletion_receipt_sha256, `${pathName}.deletion_receipt_sha256`, SHA256_PATTERN)
  literal(value.deletion_status, 'deleted', `${pathName}.deletion_status`)
  integer(value.disk_gib, `${pathName}.disk_gib`, minimumDiskGiB)
  literal(value.empty_at_start, emptyAtStart, `${pathName}.empty_at_start`)
  validateExtensionCatalog(value.extensions, `${pathName}.extensions`)
  const identity = string(value.identity_sha256, `${pathName}.identity_sha256`, SHA256_PATTERN)
  literal(value.isolated_from_production, true, `${pathName}.isolated_from_production`)
  literal(value.kind, kind, `${pathName}.kind`)
  literal(
    value.outbound_side_effects_quarantined,
    true,
    `${pathName}.outbound_side_effects_quarantined`
  )
  string(value.postgres_version, `${pathName}.postgres_version`, POSTGRES_17_PATTERN)
  literal(value.production_aliases_attached, false, `${pathName}.production_aliases_attached`)
  literal(value.production_credentials_present, false, `${pathName}.production_credentials_present`)
  string(value.region, `${pathName}.region`, SAFE_LABEL_PATTERN)
  assertAtOrBefore(createdAt, deletionDueAt, `${pathName}:DELETION_DUE_BEFORE_CREATION`)
  assertAtOrBefore(createdAt, deletedAt, `${pathName}:DELETED_BEFORE_CREATION`)
  assertAtOrBefore(deletedAt, deletionDueAt, `${pathName}:DELETED_AFTER_DEADLINE`)
  return {
    capacitySlot: value.capacity_slot_sha256,
    createdAt,
    deletedAt,
    identity,
  }
}

function validateCompletion(value, pathName, targetIdentity, expectedContract) {
  object(value, pathName, [
    'artifact_bytes',
    'artifact_sha256',
    'backup_completed_at',
    'gzip_crc_result',
    'gzip_isize_result',
    'metadata_contract',
    'metadata_sha256',
    'metadata_verified',
    'pg_dump_tail_result',
    'required_relations_result',
    'restore_exit_code',
    'stream_completed_at',
    'stream_started_at',
    'tail_sha256',
    'target_identity_sha256',
  ])
  integer(value.artifact_bytes, `${pathName}.artifact_bytes`, COMPLETE_BACKUP_MIN_BYTES)
  string(value.artifact_sha256, `${pathName}.artifact_sha256`, SHA256_PATTERN)
  const backupCompletedAt = timestamp(value.backup_completed_at, `${pathName}.backup_completed_at`)
  oneOf(value.gzip_crc_result, RESULT_VALUES, `${pathName}.gzip_crc_result`)
  oneOf(value.gzip_isize_result, RESULT_VALUES, `${pathName}.gzip_isize_result`)
  literal(value.metadata_contract, expectedContract, `${pathName}.metadata_contract`)
  string(value.metadata_sha256, `${pathName}.metadata_sha256`, SHA256_PATTERN)
  boolean(value.metadata_verified, `${pathName}.metadata_verified`)
  oneOf(value.pg_dump_tail_result, RESULT_VALUES, `${pathName}.pg_dump_tail_result`)
  oneOf(value.required_relations_result, RESULT_VALUES, `${pathName}.required_relations_result`)
  integer(value.restore_exit_code, `${pathName}.restore_exit_code`, 0)
  const streamCompletedAt = timestamp(value.stream_completed_at, `${pathName}.stream_completed_at`)
  const streamStartedAt = timestamp(value.stream_started_at, `${pathName}.stream_started_at`)
  string(value.tail_sha256, `${pathName}.tail_sha256`, SHA256_PATTERN)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  assertAtOrBefore(backupCompletedAt, streamStartedAt, `${pathName}:BACKUP_AFTER_RESTORE_STARTED`)
  assertAtOrBefore(streamStartedAt, streamCompletedAt, `${pathName}:STREAM_TIME_REVERSED`)
  return { backupCompletedAt, streamCompletedAt, streamStartedAt }
}

function validateCounts(value, pathName, targetIdentity) {
  object(value, pathName, [
    'checked_at',
    'constraint_count',
    'critical_rows',
    'index_count',
    'nonempty_table_count',
    'table_count',
    'target_identity_sha256',
  ])
  const checkedAt = timestamp(value.checked_at, `${pathName}.checked_at`)
  integer(value.constraint_count, `${pathName}.constraint_count`)
  integer(value.index_count, `${pathName}.index_count`)
  integer(value.nonempty_table_count, `${pathName}.nonempty_table_count`)
  integer(value.table_count, `${pathName}.table_count`)
  if (value.nonempty_table_count > value.table_count)
    fail(`${pathName}:NONEMPTY_COUNT_EXCEEDS_TABLES`)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  object(value.critical_rows, `${pathName}.critical_rows`, [
    'arena.trader_stats',
    'arena.traders',
    'public.leaderboard_ranks',
  ])
  integer(value.critical_rows['arena.trader_stats'], `${pathName}.critical_rows.arena.trader_stats`)
  integer(value.critical_rows['arena.traders'], `${pathName}.critical_rows.arena.traders`)
  integer(
    value.critical_rows['public.leaderboard_ranks'],
    `${pathName}.critical_rows.public.leaderboard_ranks`
  )
  return checkedAt
}

function validateRls(value, pathName, targetIdentity) {
  object(value, pathName, [
    'acl_sha256',
    'catalog_sha256',
    'checked_at',
    'enabled_relation_count',
    'policy_count',
    'relation_count',
    'result',
    'target_identity_sha256',
  ])
  string(value.acl_sha256, `${pathName}.acl_sha256`, SHA256_PATTERN)
  string(value.catalog_sha256, `${pathName}.catalog_sha256`, SHA256_PATTERN)
  const checkedAt = timestamp(value.checked_at, `${pathName}.checked_at`)
  integer(value.enabled_relation_count, `${pathName}.enabled_relation_count`)
  integer(value.policy_count, `${pathName}.policy_count`)
  integer(value.relation_count, `${pathName}.relation_count`)
  if (value.enabled_relation_count > value.relation_count) {
    fail(`${pathName}:RLS_COUNT_EXCEEDS_RELATIONS`)
  }
  oneOf(value.result, RESULT_VALUES, `${pathName}.result`)
  if (
    value.result === 'passed' &&
    (value.relation_count === 0 || value.enabled_relation_count === 0 || value.policy_count === 0)
  ) {
    fail(`${pathName}:PASSED_RLS_CLAIM_REQUIRES_POSITIVE_COUNTS`)
  }
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  return checkedAt
}

function validateAuth(value, pathName, targetIdentity) {
  object(value, pathName, [
    'catalog_sha256',
    'checked_at',
    'coverage',
    'existing_login',
    'identity_count',
    'mfa_if_configured',
    'new_registration',
    'oauth_if_configured',
    'result',
    'target_identity_sha256',
    'user_count',
  ])
  string(value.catalog_sha256, `${pathName}.catalog_sha256`, SHA256_PATTERN)
  const checkedAt = timestamp(value.checked_at, `${pathName}.checked_at`)
  oneOf(
    value.coverage,
    new Set(['app-auth-sidecar', 'managed-platform', 'not-in-app-backup']),
    `${pathName}.coverage`
  )
  oneOf(value.existing_login, CHECK_RESULT_VALUES, `${pathName}.existing_login`)
  integer(value.identity_count, `${pathName}.identity_count`)
  oneOf(value.mfa_if_configured, CHECK_RESULT_VALUES, `${pathName}.mfa_if_configured`)
  oneOf(value.new_registration, CHECK_RESULT_VALUES, `${pathName}.new_registration`)
  oneOf(value.oauth_if_configured, CHECK_RESULT_VALUES, `${pathName}.oauth_if_configured`)
  oneOf(value.result, new Set(['failed', 'not-covered', 'passed']), `${pathName}.result`)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  integer(value.user_count, `${pathName}.user_count`)
  if (value.coverage === 'not-in-app-backup' && value.result !== 'not-covered') {
    fail(`${pathName}:AUTH_NONCOVERAGE_RESULT_REQUIRED`)
  }
  if (value.coverage !== 'not-in-app-backup' && value.result === 'not-covered') {
    fail(`${pathName}:AUTH_COVERAGE_RESULT_REQUIRED`)
  }
  if (value.result === 'not-covered') {
    for (const name of [
      'existing_login',
      'mfa_if_configured',
      'new_registration',
      'oauth_if_configured',
    ]) {
      if (!new Set(['not-applicable', 'not-covered']).has(value[name])) {
        fail(`${pathName}:AUTH_NONCOVERAGE_CHECK_INVALID`)
      }
    }
  }
  if (value.result === 'passed') {
    if (
      value.coverage === 'not-in-app-backup' ||
      value.existing_login !== 'passed' ||
      value.new_registration !== 'passed' ||
      !new Set(['not-applicable', 'passed']).has(value.mfa_if_configured) ||
      !new Set(['not-applicable', 'passed']).has(value.oauth_if_configured) ||
      value.identity_count === 0 ||
      value.user_count === 0
    ) {
      fail(`${pathName}:PASSED_AUTH_CLAIM_UNSUPPORTED`)
    }
  }
  return checkedAt
}

function validateSmoke(value, pathName, targetIdentity) {
  object(value, pathName, ['checked_at', 'checks', 'result', 'target_identity_sha256'])
  const checkedAt = timestamp(value.checked_at, `${pathName}.checked_at`)
  const checks = array(value.checks, `${pathName}.checks`, { minimum: 3 })
  const ids = new Set()
  let everyPassed = true
  checks.forEach((check, index) => {
    const checkPath = `${pathName}.checks[${index}]`
    object(check, checkPath, ['id', 'result'])
    const id = string(check.id, `${checkPath}.id`, SAFE_LABEL_PATTERN)
    if (ids.has(id)) fail(`${pathName}:DUPLICATE_SMOKE_CHECK`)
    ids.add(id)
    oneOf(check.result, CHECK_RESULT_VALUES, `${checkPath}.result`)
    everyPassed &&= check.result === 'passed'
  })
  for (const required of ['health', 'rankings', 'traders']) {
    if (!ids.has(required)) fail(`${pathName}:REQUIRED_SMOKE_CHECK_MISSING`)
  }
  oneOf(value.result, RESULT_VALUES, `${pathName}.result`)
  if ((value.result === 'passed') !== everyPassed) fail(`${pathName}:SMOKE_RESULT_INCONSISTENT`)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  return checkedAt
}

function validateRpoRto(value, pathName, targetIdentity, restoreStartedAt) {
  object(value, pathName, [
    'backup_cutoff_at',
    'calculation_sha256',
    'latest_included_at',
    'rpo_seconds',
    'rto_seconds',
    'service_ready_at',
    'target_identity_sha256',
  ])
  const cutoffAt = timestamp(value.backup_cutoff_at, `${pathName}.backup_cutoff_at`)
  string(value.calculation_sha256, `${pathName}.calculation_sha256`, SHA256_PATTERN)
  const latestIncludedAt = timestamp(value.latest_included_at, `${pathName}.latest_included_at`)
  const rpoSeconds = integer(value.rpo_seconds, `${pathName}.rpo_seconds`)
  const rtoSeconds = integer(value.rto_seconds, `${pathName}.rto_seconds`)
  const serviceReadyAt = timestamp(value.service_ready_at, `${pathName}.service_ready_at`)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  assertAtOrBefore(latestIncludedAt, cutoffAt, `${pathName}:LATEST_INCLUDED_AFTER_CUTOFF`)
  assertAtOrBefore(restoreStartedAt, serviceReadyAt, `${pathName}:SERVICE_READY_BEFORE_RESTORE`)
  if ((cutoffAt - latestIncludedAt) / 1000 !== rpoSeconds) fail(`${pathName}:RPO_MISMATCH`)
  if ((serviceReadyAt - restoreStartedAt) / 1000 !== rtoSeconds) fail(`${pathName}:RTO_MISMATCH`)
  return serviceReadyAt
}

function validateRestore(value, pathName, purpose, expectedSource, expectedCompletionContract) {
  object(value, pathName, [
    'auth',
    'completed_at',
    'completion',
    'counts',
    'evidence_id',
    'purpose',
    'result',
    'rls',
    'rpo_rto',
    'smoke',
    'source',
    'started_at',
    'subject_target_sha256',
    'target',
  ])
  const evidenceId = string(value.evidence_id, `${pathName}.evidence_id`, SHA256_PATTERN)
  literal(value.purpose, purpose, `${pathName}.purpose`)
  const startedAt = timestamp(value.started_at, `${pathName}.started_at`)
  const completedAt = timestamp(value.completed_at, `${pathName}.completed_at`)
  assertAtOrBefore(startedAt, completedAt, `${pathName}:RESTORE_TIME_REVERSED`)
  const target = validateTarget(value.target, `${pathName}.target`, {
    emptyAtStart: true,
    kind: 'managed-restore',
    minimumDiskGiB: 100,
  })
  assertAtOrBefore(target.createdAt, startedAt, `${pathName}:TARGET_CREATED_AFTER_RESTORE_START`)
  assertAtOrBefore(completedAt, target.deletedAt, `${pathName}:TARGET_DELETED_BEFORE_EVIDENCE`)
  literal(value.subject_target_sha256, target.identity, `${pathName}.subject_target_sha256`)
  const sourceKeys =
    expectedSource === 'protected-legacy-2026-07-26'
      ? [
          'artifact_identity_sha256',
          'artifact_sha256',
          'kind',
          'protected_copy_identity_sha256',
          'snapshot_date',
        ]
      : ['artifact_identity_sha256', 'artifact_sha256', 'kind']
  object(value.source, `${pathName}.source`, sourceKeys)
  string(
    value.source.artifact_identity_sha256,
    `${pathName}.source.artifact_identity_sha256`,
    SHA256_PATTERN
  )
  string(value.source.artifact_sha256, `${pathName}.source.artifact_sha256`, SHA256_PATTERN)
  literal(value.source.kind, expectedSource, `${pathName}.source.kind`)
  if (expectedSource === 'protected-legacy-2026-07-26') {
    string(
      value.source.protected_copy_identity_sha256,
      `${pathName}.source.protected_copy_identity_sha256`,
      SHA256_PATTERN
    )
    literal(value.source.snapshot_date, '2026-07-26', `${pathName}.source.snapshot_date`)
  }
  const completion = validateCompletion(
    value.completion,
    `${pathName}.completion`,
    target.identity,
    expectedCompletionContract
  )
  if (value.source.artifact_sha256 !== value.completion.artifact_sha256) {
    fail(`${pathName}:SOURCE_ARTIFACT_BINDING_MISMATCH`)
  }
  assertAtOrBefore(completion.backupCompletedAt, startedAt, `${pathName}:BACKUP_AFTER_RESTORE`)
  assertAtOrBefore(startedAt, completion.streamStartedAt, `${pathName}:STREAM_BEFORE_RESTORE`)
  assertAtOrBefore(completion.streamCompletedAt, completedAt, `${pathName}:STREAM_AFTER_COMPLETION`)
  const evidenceTimes = [
    validateCounts(value.counts, `${pathName}.counts`, target.identity),
    validateRls(value.rls, `${pathName}.rls`, target.identity),
    validateAuth(value.auth, `${pathName}.auth`, target.identity),
    validateSmoke(value.smoke, `${pathName}.smoke`, target.identity),
  ]
  for (const evidenceTime of evidenceTimes) {
    assertAtOrBefore(
      completion.streamCompletedAt,
      evidenceTime,
      `${pathName}:CHECK_BEFORE_STREAM_END`
    )
    assertAtOrBefore(evidenceTime, completedAt, `${pathName}:CHECK_AFTER_COMPLETION`)
  }
  const serviceReadyAt = validateRpoRto(
    value.rpo_rto,
    `${pathName}.rpo_rto`,
    target.identity,
    startedAt
  )
  assertAtOrBefore(serviceReadyAt, completedAt, `${pathName}:SERVICE_READY_AFTER_COMPLETION`)
  oneOf(value.result, RESULT_VALUES, `${pathName}.result`)
  if (value.result === 'passed') {
    const completionPassed =
      value.completion.metadata_verified &&
      value.completion.gzip_crc_result === 'passed' &&
      value.completion.gzip_isize_result === 'passed' &&
      value.completion.pg_dump_tail_result === 'passed' &&
      value.completion.required_relations_result === 'passed' &&
      value.completion.restore_exit_code === 0
    const positiveCounts =
      value.counts.table_count > 0 &&
      value.counts.index_count > 0 &&
      value.counts.constraint_count > 0 &&
      Object.values(value.counts.critical_rows).every((count) => count > 0)
    if (
      !completionPassed ||
      !positiveCounts ||
      value.rls.result !== 'passed' ||
      value.auth.result !== 'passed' ||
      value.smoke.result !== 'passed'
    ) {
      fail(`${pathName}:PASSED_RESTORE_CLAIM_UNSUPPORTED`)
    }
  }
  return {
    artifactIdentity: value.source.artifact_identity_sha256,
    artifactSha256: value.source.artifact_sha256,
    backupCompletedAt: completion.backupCompletedAt,
    completedAt,
    evidenceId,
    result: value.result,
    target,
  }
}

function validateSourceCapture(value, providerResolvedAt, priorCompletedAt) {
  const pathName = 'source_capture'
  object(value, pathName, [
    'artifacts',
    'ca_sha256',
    'ca_validity',
    'captured_at',
    'connection_mode',
    'evidence_id',
    'git_sha',
    'incomplete_marker_absent',
    'postgres_version',
    'purpose',
    'repeatable_read',
    'source_identity_sha256',
    'sslmode',
    'status',
    'subject_source_identity_sha256',
    'transaction_read_only',
  ])
  const evidenceId = string(value.evidence_id, `${pathName}.evidence_id`, SHA256_PATTERN)
  literal(value.purpose, 'canonical-source-capture', `${pathName}.purpose`)
  const sourceIdentity = string(
    value.source_identity_sha256,
    `${pathName}.source_identity_sha256`,
    SHA256_PATTERN
  )
  literal(
    value.subject_source_identity_sha256,
    sourceIdentity,
    `${pathName}.subject_source_identity_sha256`
  )
  const capturedAt = timestamp(value.captured_at, `${pathName}.captured_at`)
  assertAtOrBefore(providerResolvedAt, capturedAt, `${pathName}:CAPTURE_BEFORE_INCIDENT_RESOLUTION`)
  assertAtOrBefore(priorCompletedAt, capturedAt, `${pathName}:CAPTURE_BEFORE_RESTORE_EVIDENCE`)
  oneOf(
    value.connection_mode,
    new Set(['direct-5432', 'session-pooler-5432']),
    `${pathName}.connection_mode`
  )
  string(value.ca_sha256, `${pathName}.ca_sha256`, SHA256_PATTERN)
  object(value.ca_validity, `${pathName}.ca_validity`, ['not_after', 'not_before'])
  const caNotAfter = timestamp(value.ca_validity.not_after, `${pathName}.ca_validity.not_after`)
  const caNotBefore = timestamp(value.ca_validity.not_before, `${pathName}.ca_validity.not_before`)
  assertAtOrBefore(caNotBefore, capturedAt, `${pathName}:CA_NOT_YET_VALID`)
  assertAtOrBefore(capturedAt, caNotAfter, `${pathName}:CA_EXPIRED`)
  string(value.git_sha, `${pathName}.git_sha`, GIT_SHA_PATTERN)
  literal(value.incomplete_marker_absent, true, `${pathName}.incomplete_marker_absent`)
  string(value.postgres_version, `${pathName}.postgres_version`, POSTGRES_17_PATTERN)
  literal(value.repeatable_read, true, `${pathName}.repeatable_read`)
  literal(value.sslmode, 'verify-full', `${pathName}.sslmode`)
  literal(value.status, 'source-capture/not-a-candidate', `${pathName}.status`)
  literal(value.transaction_read_only, true, `${pathName}.transaction_read_only`)
  object(value.artifacts, `${pathName}.artifacts`, [
    'app_schema_sha256',
    'migration_ledger_sha256',
    'normalized_catalog_sha256',
    'source_catalog_file_sha256',
  ])
  for (const name of Object.keys(value.artifacts)) {
    string(value.artifacts[name], `${pathName}.artifacts.${name}`, SHA256_PATTERN)
  }
  return {
    capturedAt,
    evidenceId,
    gitSha: value.git_sha,
    ledgerSha256: value.artifacts.migration_ledger_sha256,
    normalizedCatalogSha256: value.artifacts.normalized_catalog_sha256,
  }
}

function validateCandidate(value, capture) {
  const pathName = 'candidate'
  object(value, pathName, [
    'artifact_sha256',
    'capture_evidence_id',
    'created_at',
    'evidence_id',
    'expected_replay_catalog_sha256',
    'expected_replay_ledger_sha256',
    'foundation_sha256',
    'git_sha',
    'independent_review',
    'launch_inventory_sha256',
    'postdeploy_migration_count',
    'predeploy_migration_count',
    'platform_prerequisites_sha256',
    'production_deployable',
    'purpose',
    'replay_runner_sha256',
    'source_catalog_sha256',
    'status',
  ])
  const evidenceId = string(value.evidence_id, `${pathName}.evidence_id`, SHA256_PATTERN)
  literal(value.purpose, 'canonical-baseline-candidate', `${pathName}.purpose`)
  literal(value.status, 'candidate/not-deployable', `${pathName}.status`)
  literal(value.production_deployable, false, `${pathName}.production_deployable`)
  literal(value.capture_evidence_id, capture.evidenceId, `${pathName}.capture_evidence_id`)
  literal(
    value.source_catalog_sha256,
    capture.normalizedCatalogSha256,
    `${pathName}.source_catalog_sha256`
  )
  string(value.artifact_sha256, `${pathName}.artifact_sha256`, SHA256_PATTERN)
  const createdAt = timestamp(value.created_at, `${pathName}.created_at`)
  assertAtOrBefore(capture.capturedAt, createdAt, `${pathName}:CREATED_BEFORE_CAPTURE`)
  string(
    value.expected_replay_catalog_sha256,
    `${pathName}.expected_replay_catalog_sha256`,
    SHA256_PATTERN
  )
  string(
    value.expected_replay_ledger_sha256,
    `${pathName}.expected_replay_ledger_sha256`,
    SHA256_PATTERN
  )
  string(value.foundation_sha256, `${pathName}.foundation_sha256`, SHA256_PATTERN)
  literal(value.git_sha, capture.gitSha, `${pathName}.git_sha`)
  string(value.launch_inventory_sha256, `${pathName}.launch_inventory_sha256`, SHA256_PATTERN)
  literal(value.predeploy_migration_count, 122, `${pathName}.predeploy_migration_count`)
  literal(value.postdeploy_migration_count, 3, `${pathName}.postdeploy_migration_count`)
  string(
    value.platform_prerequisites_sha256,
    `${pathName}.platform_prerequisites_sha256`,
    SHA256_PATTERN
  )
  string(value.replay_runner_sha256, `${pathName}.replay_runner_sha256`, SHA256_PATTERN)
  object(value.independent_review, `${pathName}.independent_review`, [
    'result',
    'reviewed_at',
    'reviewer_identity_sha256',
  ])
  oneOf(value.independent_review.result, RESULT_VALUES, `${pathName}.independent_review.result`)
  const reviewedAt = timestamp(
    value.independent_review.reviewed_at,
    `${pathName}.independent_review.reviewed_at`
  )
  assertAtOrBefore(createdAt, reviewedAt, `${pathName}:REVIEW_BEFORE_CREATION`)
  string(
    value.independent_review.reviewer_identity_sha256,
    `${pathName}.independent_review.reviewer_identity_sha256`,
    SHA256_PATTERN
  )
  return {
    createdAt,
    evidenceId,
    expectedCatalogSha256: value.expected_replay_catalog_sha256,
    expectedLedgerSha256: value.expected_replay_ledger_sha256,
    foundationSha256: value.foundation_sha256,
    gitSha: value.git_sha,
    platformPrerequisitesSha256: value.platform_prerequisites_sha256,
    replayRunnerSha256: value.replay_runner_sha256,
    result: value.independent_review.result,
    reviewedAt,
  }
}

function validateComparison(value, pathName, targetIdentity, candidate) {
  object(value, pathName, [
    'actual_catalog_sha256',
    'actual_ledger_sha256',
    'catalog_match',
    'catalog_mismatch_count',
    'catalog_mismatch_manifest_sha256',
    'expected_catalog_sha256',
    'expected_ledger_sha256',
    'ledger_match',
    'ledger_mismatch_count',
    'ledger_mismatch_manifest_sha256',
    'target_identity_sha256',
  ])
  for (const name of [
    'actual_catalog_sha256',
    'actual_ledger_sha256',
    'expected_catalog_sha256',
    'expected_ledger_sha256',
  ]) {
    string(value[name], `${pathName}.${name}`, SHA256_PATTERN)
  }
  literal(
    value.expected_catalog_sha256,
    candidate.expectedCatalogSha256,
    `${pathName}.expected_catalog_sha256`
  )
  literal(
    value.expected_ledger_sha256,
    candidate.expectedLedgerSha256,
    `${pathName}.expected_ledger_sha256`
  )
  boolean(value.catalog_match, `${pathName}.catalog_match`)
  const catalogMismatchCount = integer(
    value.catalog_mismatch_count,
    `${pathName}.catalog_mismatch_count`
  )
  nullableHash(
    value.catalog_mismatch_manifest_sha256,
    `${pathName}.catalog_mismatch_manifest_sha256`
  )
  boolean(value.ledger_match, `${pathName}.ledger_match`)
  const ledgerMismatchCount = integer(
    value.ledger_mismatch_count,
    `${pathName}.ledger_mismatch_count`
  )
  nullableHash(value.ledger_mismatch_manifest_sha256, `${pathName}.ledger_mismatch_manifest_sha256`)
  literal(value.target_identity_sha256, targetIdentity, `${pathName}.target_identity_sha256`)
  const assertMatchBinding = (kind, matched, mismatchCount, mismatchManifest, actual, expected) => {
    if (matched) {
      if (mismatchCount !== 0 || mismatchManifest !== null || actual !== expected) {
        fail(`${pathName}:${kind.toUpperCase()}_MATCH_BINDING_INVALID`)
      }
    } else if (mismatchCount < 1 || mismatchManifest === null) {
      fail(`${pathName}:${kind.toUpperCase()}_MISMATCH_EVIDENCE_REQUIRED`)
    }
  }
  assertMatchBinding(
    'catalog',
    value.catalog_match,
    catalogMismatchCount,
    value.catalog_mismatch_manifest_sha256,
    value.actual_catalog_sha256,
    value.expected_catalog_sha256
  )
  assertMatchBinding(
    'ledger',
    value.ledger_match,
    ledgerMismatchCount,
    value.ledger_mismatch_manifest_sha256,
    value.actual_ledger_sha256,
    value.expected_ledger_sha256
  )
}

function validateReplayOrPreview(value, pathName, candidate, configuration) {
  const keys = [
    'auth',
    'candidate_evidence_id',
    'completed_at',
    'comparison',
    'counts',
    'evidence_id',
    'foundation_sha256',
    'git_sha',
    'phases',
    'platform_prerequisites_sha256',
    'purpose',
    'replay_runner_sha256',
    'result',
    'rls',
    'smoke',
    'started_at',
    'status',
    'subject_target_sha256',
    'target',
  ]
  if (configuration.slot) keys.push('slot')
  if (configuration.preview) keys.push('pull_request_number')
  object(value, pathName, keys)
  const evidenceId = string(value.evidence_id, `${pathName}.evidence_id`, SHA256_PATTERN)
  literal(value.purpose, configuration.purpose, `${pathName}.purpose`)
  literal(value.status, configuration.status, `${pathName}.status`)
  if (configuration.slot) literal(value.slot, configuration.slot, `${pathName}.slot`)
  if (configuration.preview)
    integer(value.pull_request_number, `${pathName}.pull_request_number`, 1)
  literal(value.candidate_evidence_id, candidate.evidenceId, `${pathName}.candidate_evidence_id`)
  literal(value.foundation_sha256, candidate.foundationSha256, `${pathName}.foundation_sha256`)
  literal(value.git_sha, candidate.gitSha, `${pathName}.git_sha`)
  literal(
    value.platform_prerequisites_sha256,
    candidate.platformPrerequisitesSha256,
    `${pathName}.platform_prerequisites_sha256`
  )
  literal(
    value.replay_runner_sha256,
    candidate.replayRunnerSha256,
    `${pathName}.replay_runner_sha256`
  )
  const startedAt = timestamp(value.started_at, `${pathName}.started_at`)
  const completedAt = timestamp(value.completed_at, `${pathName}.completed_at`)
  assertAtOrBefore(candidate.reviewedAt, startedAt, `${pathName}:STARTED_BEFORE_CANDIDATE_REVIEW`)
  assertAtOrBefore(startedAt, completedAt, `${pathName}:TIME_REVERSED`)
  const target = validateTarget(value.target, `${pathName}.target`, {
    emptyAtStart: true,
    kind: configuration.targetKind,
    minimumDiskGiB: 1,
  })
  assertAtOrBefore(target.createdAt, startedAt, `${pathName}:TARGET_CREATED_AFTER_REPLAY_START`)
  assertAtOrBefore(completedAt, target.deletedAt, `${pathName}:TARGET_DELETED_BEFORE_EVIDENCE`)
  literal(value.subject_target_sha256, target.identity, `${pathName}.subject_target_sha256`)
  object(value.phases, `${pathName}.phases`, ['app_schema', 'forward_epoch', 'foundation'])
  for (const phase of ['foundation', 'app_schema', 'forward_epoch']) {
    oneOf(value.phases[phase], RESULT_VALUES, `${pathName}.phases.${phase}`)
  }
  validateComparison(value.comparison, `${pathName}.comparison`, target.identity, candidate)
  const evidenceTimes = [
    validateCounts(value.counts, `${pathName}.counts`, target.identity),
    validateRls(value.rls, `${pathName}.rls`, target.identity),
    validateAuth(value.auth, `${pathName}.auth`, target.identity),
    validateSmoke(value.smoke, `${pathName}.smoke`, target.identity),
  ]
  for (const evidenceTime of evidenceTimes) {
    assertAtOrBefore(startedAt, evidenceTime, `${pathName}:CHECK_BEFORE_START`)
    assertAtOrBefore(evidenceTime, completedAt, `${pathName}:CHECK_AFTER_COMPLETION`)
  }
  oneOf(value.result, RESULT_VALUES, `${pathName}.result`)
  if (value.result === 'passed') {
    const phasesPassed = Object.values(value.phases).every((result) => result === 'passed')
    if (
      !phasesPassed ||
      !value.comparison.catalog_match ||
      !value.comparison.ledger_match ||
      value.counts.table_count === 0 ||
      value.counts.index_count === 0 ||
      value.counts.constraint_count === 0 ||
      value.rls.result !== 'passed' ||
      value.auth.result !== 'passed' ||
      value.smoke.result !== 'passed'
    ) {
      fail(`${pathName}:PASSED_REPLAY_CLAIM_UNSUPPORTED`)
    }
  }
  return { completedAt, evidenceId, result: value.result, startedAt, target }
}

function unique(values, code) {
  if (new Set(values).size !== values.length) fail(code)
}

function allClaimedChecksPassed(receipt, legacy, current, candidate, replays, preview) {
  const restorePassed = (restore, parsed) =>
    parsed.result === 'passed' &&
    restore.completion.metadata_verified &&
    restore.completion.gzip_crc_result === 'passed' &&
    restore.completion.gzip_isize_result === 'passed' &&
    restore.completion.pg_dump_tail_result === 'passed' &&
    restore.completion.required_relations_result === 'passed' &&
    restore.completion.restore_exit_code === 0 &&
    restore.rls.result === 'passed' &&
    restore.auth.result === 'passed' &&
    restore.smoke.result === 'passed'
  const replayPassed = (entry, parsed) =>
    parsed.result === 'passed' &&
    Object.values(entry.phases).every((result) => result === 'passed') &&
    entry.comparison.catalog_match &&
    entry.comparison.ledger_match &&
    entry.rls.result === 'passed' &&
    entry.auth.result === 'passed' &&
    entry.smoke.result === 'passed'
  return (
    restorePassed(receipt.legacy_restore, legacy) &&
    restorePassed(receipt.current_contract_restore, current) &&
    candidate.result === 'passed' &&
    replays.every((parsed, index) => replayPassed(receipt.managed_pg17_replays[index], parsed)) &&
    replayPassed(receipt.preview, preview)
  )
}

export function validateManagedEvidenceReceipt(receipt) {
  assertSensitiveDataAbsent(receipt)
  object(receipt, 'receipt', [
    'candidate',
    'contract',
    'created_at',
    'current_contract_restore',
    'legacy_restore',
    'managed_pg17_replays',
    'preview',
    'production_authorized',
    'provider_incident',
    'receipt_id',
    'source_capture',
    'status',
  ])
  literal(receipt.contract, MANAGED_EVIDENCE_RECEIPT_CONTRACT, 'receipt.contract')
  literal(receipt.status, MANAGED_EVIDENCE_RECEIPT_STATUS, 'receipt.status')
  literal(receipt.production_authorized, false, 'receipt.production_authorized')
  const receiptId = string(receipt.receipt_id, 'receipt.receipt_id', SHA256_PATTERN)
  const createdAt = timestamp(receipt.created_at, 'receipt.created_at')
  const provider = validateProviderIncident(receipt.provider_incident)
  const legacy = validateRestore(
    receipt.legacy_restore,
    'legacy_restore',
    'protected-legacy-restore',
    'protected-legacy-2026-07-26',
    'legacy-pg17-restrict-footer'
  )
  const current = validateRestore(
    receipt.current_contract_restore,
    'current_contract_restore',
    'current-contract-post-incident-restore',
    'current-contract-post-incident',
    'arena.pg-dump-complete.v1'
  )
  assertAtOrBefore(
    provider.resolvedAt,
    current.target.createdAt,
    'current_contract_restore:TARGET_CREATED_BEFORE_INCIDENT_RESOLUTION'
  )
  assertAtOrBefore(
    provider.resolvedAt,
    current.backupCompletedAt,
    'current_contract_restore:BACKUP_BEFORE_INCIDENT_RESOLUTION'
  )
  if (
    legacy.artifactIdentity === current.artifactIdentity ||
    legacy.artifactSha256 === current.artifactSha256
  ) {
    fail('restore_cycles:SOURCE_ARTIFACTS_MUST_BE_DISTINCT')
  }
  const capture = validateSourceCapture(
    receipt.source_capture,
    provider.resolvedAt,
    Math.max(legacy.completedAt, current.completedAt)
  )
  const candidate = validateCandidate(receipt.candidate, capture)
  const replayValues = array(receipt.managed_pg17_replays, 'managed_pg17_replays', { length: 2 })
  const replays = replayValues.map((value, index) =>
    validateReplayOrPreview(value, `managed_pg17_replays[${index}]`, candidate, {
      purpose: 'managed-pg17-baseline-replay',
      slot: index === 0 ? 'replay-a' : 'replay-b',
      status: 'replay/candidate-evidence',
      targetKind: 'managed-schema-replay',
    })
  )
  const preview = validateReplayOrPreview(receipt.preview, 'preview', candidate, {
    preview: true,
    purpose: 'managed-preview-full-replay',
    status: 'preview/candidate-evidence',
    targetKind: 'managed-preview',
  })
  const evidenceIds = [
    receiptId,
    legacy.evidenceId,
    current.evidenceId,
    capture.evidenceId,
    candidate.evidenceId,
    ...replays.map((entry) => entry.evidenceId),
    preview.evidenceId,
  ]
  unique(evidenceIds, 'receipt:EVIDENCE_IDENTITIES_MUST_BE_DISTINCT')
  const targetIds = [
    legacy.target.identity,
    current.target.identity,
    ...replays.map((entry) => entry.target.identity),
    preview.target.identity,
  ]
  unique(targetIds, 'receipt:TARGET_IDENTITIES_MUST_BE_DISTINCT')
  unique(
    [
      legacy.target.capacitySlot,
      current.target.capacitySlot,
      ...replays.map((entry) => entry.target.capacitySlot),
      preview.target.capacitySlot,
    ],
    'receipt:TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT'
  )
  assertAtOrBefore(
    Math.max(...replays.map((entry) => entry.completedAt)),
    preview.startedAt,
    'preview:STARTED_BEFORE_MANAGED_REPLAYS_COMPLETED'
  )
  if (evidenceIds.some((identity) => targetIds.includes(identity))) {
    fail('receipt:TARGET_AND_EVIDENCE_IDENTITIES_MUST_BE_DISTINCT')
  }
  const completedTimes = [
    legacy.completedAt,
    current.completedAt,
    capture.capturedAt,
    candidate.reviewedAt,
    ...replays.map((entry) => entry.completedAt),
    preview.completedAt,
    ...[legacy.target, current.target, ...replays.map((entry) => entry.target), preview.target].map(
      (target) => target.deletedAt
    ),
  ]
  for (const completedAt of completedTimes) {
    assertAtOrBefore(completedAt, createdAt, 'receipt:CREATED_BEFORE_EVIDENCE_COMPLETED')
  }

  return Object.freeze({
    all_claimed_checks_passed: allClaimedChecksPassed(
      receipt,
      legacy,
      current,
      candidate,
      replays,
      preview
    ),
    claim_fields_structurally_complete: true,
    contract: MANAGED_EVIDENCE_RECEIPT_CONTRACT,
    evidence_proven: false,
    external_evidence_files_verified: false,
    external_evidence_hashes_recomputed: false,
    production_authorized: false,
    receipt_id: receiptId,
    status: MANAGED_EVIDENCE_RECEIPT_STATUS,
  })
}

function parseReceiptFile(localPath) {
  if (typeof localPath !== 'string' || localPath.length === 0 || localPath.includes('\0')) {
    fail('CLI:LOCAL_JSON_PATH_REQUIRED')
  }
  const resolvedPath = path.resolve(localPath)
  let descriptor
  try {
    if (typeof fsConstants.O_NOFOLLOW !== 'number') fail('CLI:NOFOLLOW_REQUIRED')
    descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor)
    if (!before.isFile()) fail('CLI:REGULAR_FILE_REQUIRED')
    const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : null
    if (effectiveUserId === null || (before.mode & 0o077) !== 0 || before.uid !== effectiveUserId) {
      fail('CLI:OWNER_ONLY_FILE_REQUIRED')
    }
    if (before.size < 2 || before.size > MAX_RECEIPT_BYTES) fail('CLI:FILE_SIZE_INVALID')
    const contents = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      fail('CLI:FILE_CHANGED_DURING_READ')
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      fail('CLI:JSON_INVALID')
    }
    return parsed
  } catch (error) {
    if (error instanceof ReceiptValidationError) throw error
    fail('CLI:LOCAL_JSON_UNREADABLE')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function runManagedEvidenceReceiptCli(
  argv = process.argv.slice(2),
  {
    writeError = (value) => process.stderr.write(value),
    writeOutput = (value) => process.stdout.write(value),
  } = {}
) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    writeError('Usage: node scripts/qa/managed-evidence-receipt.mjs <local-receipt.json>\n')
    return 2
  }
  try {
    const summary = validateManagedEvidenceReceipt(parseReceiptFile(argv[0]))
    writeOutput(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = error instanceof ReceiptValidationError ? error.code : 'RECEIPT_VALIDATION_FAILED'
    writeError(`Managed evidence receipt rejected: ${code}\n`)
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exitCode = runManagedEvidenceReceiptCli()
