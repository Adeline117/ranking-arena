import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { validateApiTierCutoverReport } from './validate-api-tier-cutover-report.mjs'

const RELEASE_SHA = 'a'.repeat(40)

function sha(body) {
  return createHash('sha256').update(body).digest('hex')
}

function fixture(migrationDirectory) {
  const additiveBody = 'SELECT 200;\n'
  const cleanupBody = 'SELECT 210;\n'
  writeFileSync(
    resolve(migrationDirectory, '20260729020000_api_tier_cancellation_identity.sql'),
    additiveBody
  )
  writeFileSync(
    resolve(migrationDirectory, '20260729021000_disable_legacy_api_tier_writer.sql'),
    cleanupBody
  )
  return {
    schema_version: 1,
    generated_at: '2026-07-29T08:00:00.000Z',
    release_sha: RELEASE_SHA,
    closed_probe: {
      release_sha: RELEASE_SHA,
      writer_mode: 'closed',
      http_status: 503,
      writer_header: 'closed',
    },
    drain: {
      started_at: '2026-07-29T07:00:00.000Z',
      completed_at: '2026-07-29T07:10:00.000Z',
      old_instances_remaining: 0,
    },
    migration_ledgers: [
      {
        version: '20260729020000',
        name: 'api_tier_cancellation_identity',
        phase: 'predeploy',
        state: 'exact',
        sha256: sha(additiveBody),
      },
      {
        version: '20260729021000',
        name: 'disable_legacy_api_tier_writer',
        phase: 'postdeploy',
        state: 'exact',
        sha256: sha(cleanupBody),
      },
    ],
    legacy_checkout_scan: {
      livemode: true,
      open_pages: 2,
      complete_pages: 3,
      unique_legacy_sessions: 4,
      open_observed: 2,
      complete_observed: 3,
      expired: 1,
      fulfilled: 2,
      cancel_refund_acked: 1,
      open_remaining: 0,
      unsettled_complete: 0,
      malformed: 0,
      identity_conflicts: 0,
      duplicate_ids: 0,
    },
    webhook_and_projection: {
      failed_events: 0,
      processing_events: 0,
      paid_unbound: 0,
      profile_ledger_drift: 0,
      unresolved_financial_reversals: 0,
    },
    sealed_probe: {
      release_sha: RELEASE_SHA,
      writer_mode: 'sealed',
      http_status: 200,
      writer_header: 'sealed',
    },
    canary: {
      reservation_id: '11111111-1111-4111-8111-111111111111',
      checkout_session_id: 'cs_live_canary',
      customer_id: 'cus_canary',
      subscription_id: 'sub_canary',
      event_id: 'evt_canary',
      livemode: true,
      api_tier: 'starter',
      daily_limit: 10_000,
      reservation_status: 'converted',
      event_status: 'applied',
      profile_exact: true,
      keys_exact: true,
    },
  }
}

function withMigrations(run) {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-api-cutover-'))
  try {
    return run(directory, fixture(directory))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('accepts only a zero-backlog exact-SHA cutover report', () => {
  withMigrations((migrationDirectory, report) => {
    assert.deepEqual(
      validateApiTierCutoverReport(report, {
        expectedReleaseSha: RELEASE_SHA,
        migrationDirectory,
      }),
      {
        status: 'ready',
        release_sha: RELEASE_SHA,
        legacy_sessions: 4,
        canary_subscription_id: 'sub_canary',
      }
    )
  })
})

test('rejects release, migration, scan, backlog, and canary drift', () => {
  const cases = [
    ['release', (report) => (report.sealed_probe.release_sha = 'b'.repeat(40))],
    ['migration hash', (report) => (report.migration_ledgers[0].sha256 = '0'.repeat(64))],
    ['unsettled complete', (report) => (report.legacy_checkout_scan.unsettled_complete = 1)],
    ['missing disposition', (report) => (report.legacy_checkout_scan.fulfilled = 1)],
    ['failed webhook', (report) => (report.webhook_and_projection.failed_events = 1)],
    ['canary projection', (report) => (report.canary.keys_exact = false)],
  ]

  for (const [label, mutate] of cases) {
    withMigrations((migrationDirectory, report) => {
      mutate(report)
      assert.throws(
        () =>
          validateApiTierCutoverReport(report, {
            expectedReleaseSha: RELEASE_SHA,
            migrationDirectory,
          }),
        /API tier cutover report invalid/,
        label
      )
    })
  }
})

test('rejects omitted or extra evidence fields', () => {
  withMigrations((migrationDirectory, report) => {
    report.legacy_checkout_scan.unreviewed = 0
    assert.throws(
      () =>
        validateApiTierCutoverReport(report, {
          expectedReleaseSha: RELEASE_SHA,
          migrationDirectory,
        }),
      /legacy_checkout_scan keys must be exactly/
    )
  })
})
