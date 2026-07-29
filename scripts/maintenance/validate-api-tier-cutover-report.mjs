#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const FULL_SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_IDS = {
  checkout_session_id: /^cs_[A-Za-z0-9_]+$/,
  subscription_id: /^sub_[A-Za-z0-9_]+$/,
  event_id: /^evt_[A-Za-z0-9_]+$/,
  customer_id: /^cus_[A-Za-z0-9_]+$/,
}
const REQUIRED_MIGRATIONS = new Map([
  [
    '20260729020000',
    {
      name: 'api_tier_cancellation_identity',
      phase: 'predeploy',
      file: '20260729020000_api_tier_cancellation_identity.sql',
    },
  ],
  [
    '20260729021000',
    {
      name: 'disable_legacy_api_tier_writer',
      phase: 'postdeploy',
      file: '20260729021000_disable_legacy_api_tier_writer.sql',
    },
  ],
])

function fail(message) {
  throw new Error(`API tier cutover report invalid: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(record(value, label)).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(',')}`)
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`)
  return value
}

function exactZero(value, label) {
  if (value !== 0) fail(`${label} must be zero`)
}

function exactTrue(value, label) {
  if (value !== true) fail(`${label} must be true`)
}

function timestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} must be an ISO UTC timestamp`)
  }
  return Date.parse(value)
}

function migrationDigest(migrationDirectory, file) {
  return createHash('sha256')
    .update(readFileSync(resolve(migrationDirectory, file)))
    .digest('hex')
}

function validateMigrationLedgers(entries, migrationDirectory) {
  if (!Array.isArray(entries)) fail('migration_ledgers must be an array')
  const byVersion = new Map()
  for (const [index, entryValue] of entries.entries()) {
    const label = `migration_ledgers[${index}]`
    const entry = record(entryValue, label)
    exactKeys(entry, ['version', 'name', 'phase', 'state', 'sha256'], label)
    if (
      typeof entry.version !== 'string' ||
      !/^202\d{11}$/.test(entry.version) ||
      byVersion.has(entry.version)
    ) {
      fail(`${label}.version is malformed or duplicated`)
    }
    if (
      typeof entry.name !== 'string' ||
      !/^[a-z0-9_]+$/.test(entry.name) ||
      !['predeploy', 'postdeploy'].includes(entry.phase) ||
      entry.state !== 'exact' ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      fail(`${label} identity is malformed or not exact`)
    }
    byVersion.set(entry.version, entry)
  }

  for (const [version, expected] of REQUIRED_MIGRATIONS) {
    const entry = byVersion.get(version)
    if (!entry) fail(`required migration ${version} is missing`)
    if (entry.name !== expected.name || entry.phase !== expected.phase) {
      fail(`required migration ${version} has the wrong name or phase`)
    }
    let digest
    try {
      digest = migrationDigest(migrationDirectory, expected.file)
    } catch (error) {
      fail(`cannot read required migration ${expected.file}: ${error.message}`)
    }
    if (entry.sha256 !== digest) fail(`required migration ${version} hash drifted`)
  }
}

function validateProbe(probeValue, label, expectedReleaseSha, expectedMode, expectedStatus) {
  const probe = record(probeValue, label)
  exactKeys(probe, ['release_sha', 'writer_mode', 'http_status', 'writer_header'], label)
  if (
    probe.release_sha !== expectedReleaseSha ||
    probe.writer_mode !== expectedMode ||
    probe.http_status !== expectedStatus ||
    probe.writer_header !== expectedMode
  ) {
    fail(`${label} does not prove the exact ${expectedMode} release`)
  }
}

function validateLegacyScan(scanValue) {
  const scan = record(scanValue, 'legacy_checkout_scan')
  exactKeys(
    scan,
    [
      'livemode',
      'open_pages',
      'complete_pages',
      'unique_legacy_sessions',
      'open_observed',
      'complete_observed',
      'expired',
      'fulfilled',
      'cancel_refund_acked',
      'open_remaining',
      'unsettled_complete',
      'malformed',
      'identity_conflicts',
      'duplicate_ids',
    ],
    'legacy_checkout_scan'
  )
  if (typeof scan.livemode !== 'boolean') fail('legacy_checkout_scan.livemode must be boolean')
  positiveInteger(scan.open_pages, 'legacy_checkout_scan.open_pages')
  positiveInteger(scan.complete_pages, 'legacy_checkout_scan.complete_pages')
  const total = nonNegativeInteger(
    scan.unique_legacy_sessions,
    'legacy_checkout_scan.unique_legacy_sessions'
  )
  const openObserved = nonNegativeInteger(scan.open_observed, 'legacy_checkout_scan.open_observed')
  const completeObserved = nonNegativeInteger(
    scan.complete_observed,
    'legacy_checkout_scan.complete_observed'
  )
  const dispositions = ['expired', 'fulfilled', 'cancel_refund_acked'].map((field) =>
    nonNegativeInteger(scan[field], `legacy_checkout_scan.${field}`)
  )
  if (openObserved > total || completeObserved > total) {
    fail('legacy Checkout observations exceed the unique Session count')
  }
  if (dispositions.reduce((sum, value) => sum + value, 0) !== total) {
    fail('every unique legacy Checkout must have one exact terminal disposition')
  }
  for (const field of [
    'open_remaining',
    'unsettled_complete',
    'malformed',
    'identity_conflicts',
    'duplicate_ids',
  ]) {
    exactZero(scan[field], `legacy_checkout_scan.${field}`)
  }
}

function validateBacklog(backlogValue) {
  const backlog = record(backlogValue, 'webhook_and_projection')
  exactKeys(
    backlog,
    [
      'failed_events',
      'processing_events',
      'paid_unbound',
      'profile_ledger_drift',
      'unresolved_financial_reversals',
    ],
    'webhook_and_projection'
  )
  for (const field of Object.keys(backlog)) {
    exactZero(backlog[field], `webhook_and_projection.${field}`)
  }
}

function validateCanary(canaryValue, expectedLivemode) {
  const canary = record(canaryValue, 'canary')
  exactKeys(
    canary,
    [
      'reservation_id',
      'checkout_session_id',
      'customer_id',
      'subscription_id',
      'event_id',
      'livemode',
      'api_tier',
      'daily_limit',
      'reservation_status',
      'event_status',
      'profile_exact',
      'keys_exact',
    ],
    'canary'
  )
  if (!UUID.test(canary.reservation_id)) fail('canary.reservation_id is malformed')
  for (const [field, pattern] of Object.entries(STRIPE_IDS)) {
    if (typeof canary[field] !== 'string' || !pattern.test(canary[field])) {
      fail(`canary.${field} is malformed`)
    }
  }
  if (canary.livemode !== expectedLivemode) fail('canary.livemode differs from the legacy scan')
  if (canary.api_tier !== 'starter' && canary.api_tier !== 'pro') {
    fail('canary.api_tier is invalid')
  }
  const expectedLimit = canary.api_tier === 'starter' ? 10_000 : 0
  if (canary.daily_limit !== expectedLimit) fail('canary.daily_limit does not match its API tier')
  if (canary.reservation_status !== 'converted' || canary.event_status !== 'applied') {
    fail('canary reservation or event was not durably applied')
  }
  exactTrue(canary.profile_exact, 'canary.profile_exact')
  exactTrue(canary.keys_exact, 'canary.keys_exact')
}

export function validateApiTierCutoverReport(
  reportValue,
  { expectedReleaseSha, migrationDirectory = resolve(ROOT, 'supabase/migrations') } = {}
) {
  const report = record(reportValue, 'report')
  exactKeys(
    report,
    [
      'schema_version',
      'generated_at',
      'release_sha',
      'closed_probe',
      'drain',
      'migration_ledgers',
      'legacy_checkout_scan',
      'webhook_and_projection',
      'sealed_probe',
      'canary',
    ],
    'report'
  )
  if (report.schema_version !== 1) fail('schema_version must be 1')
  timestamp(report.generated_at, 'generated_at')
  if (
    typeof expectedReleaseSha !== 'string' ||
    !FULL_SHA.test(expectedReleaseSha) ||
    report.release_sha !== expectedReleaseSha
  ) {
    fail('release_sha must equal the caller-provided full release SHA')
  }

  validateProbe(report.closed_probe, 'closed_probe', expectedReleaseSha, 'closed', 503)
  const drain = record(report.drain, 'drain')
  exactKeys(drain, ['started_at', 'completed_at', 'old_instances_remaining'], 'drain')
  const drainStart = timestamp(drain.started_at, 'drain.started_at')
  const drainEnd = timestamp(drain.completed_at, 'drain.completed_at')
  if (drainEnd < drainStart) fail('drain.completed_at precedes drain.started_at')
  exactZero(drain.old_instances_remaining, 'drain.old_instances_remaining')

  validateMigrationLedgers(report.migration_ledgers, migrationDirectory)
  validateLegacyScan(report.legacy_checkout_scan)
  validateBacklog(report.webhook_and_projection)
  validateProbe(report.sealed_probe, 'sealed_probe', expectedReleaseSha, 'sealed', 200)
  validateCanary(report.canary, report.legacy_checkout_scan.livemode)

  return {
    status: 'ready',
    release_sha: report.release_sha,
    legacy_sessions: report.legacy_checkout_scan.unique_legacy_sessions,
    canary_subscription_id: report.canary.subscription_id,
  }
}

function parseArgs(argv) {
  let reportPath
  let expectedReleaseSha
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--report') reportPath = argv[++index]
    else if (arg === '--expected-release-sha') expectedReleaseSha = argv[++index]
    else fail(`unknown argument ${arg}`)
  }
  if (!reportPath || !expectedReleaseSha) {
    fail('usage: --report <json> --expected-release-sha <40-char-sha>')
  }
  return { reportPath, expectedReleaseSha }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { reportPath, expectedReleaseSha } = parseArgs(process.argv.slice(2))
    const report = JSON.parse(readFileSync(resolve(reportPath), 'utf8'))
    const result = validateApiTierCutoverReport(report, { expectedReleaseSha })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
