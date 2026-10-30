import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MANAGED_EVIDENCE_RECEIPT_CONTRACT,
  MANAGED_EVIDENCE_RECEIPT_STATUS,
  validateManagedEvidenceReceipt,
} from './managed-evidence-receipt.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/qa/managed-evidence-receipt.mjs')
const SCHEMA = resolve(ROOT, 'scripts/qa/managed-evidence-receipt.schema.json')
const TEMPLATE = resolve(ROOT, 'scripts/fixtures/managed-evidence-receipt.template.json')

function sha256(label) {
  return createHash('sha256').update(label).digest('hex')
}

function target({ capacity, createdAt, deletedAt, identity, kind, minimumDiskGiB = 16 }) {
  return {
    capacity_slot_sha256: sha256(capacity),
    clean_at_start: true,
    compute_class: 'small',
    created_at: createdAt,
    deleted_at: deletedAt,
    deletion_due_at: '2026-08-07T00:00:00.000Z',
    deletion_owner_sha256: sha256(`${identity}:owner`),
    deletion_receipt_sha256: sha256(`${identity}:deletion`),
    deletion_status: 'deleted',
    disk_gib: minimumDiskGiB,
    empty_at_start: true,
    extensions: [
      { name: 'pgcrypto', schema: 'extensions', version: '1.3' },
      { name: 'uuid-ossp', schema: 'extensions', version: '1.1' },
    ],
    identity_sha256: sha256(identity),
    isolated_from_production: true,
    kind,
    outbound_side_effects_quarantined: true,
    postgres_version: '17.8',
    production_aliases_attached: false,
    production_credentials_present: false,
    region: 'us-west-1',
  }
}

function counts(targetIdentity, checkedAt, populated = true) {
  return {
    checked_at: checkedAt,
    constraint_count: populated ? 338 : 12,
    critical_rows: {
      'arena.trader_stats': populated ? 552870 : 0,
      'arena.traders': populated ? 217938 : 0,
      'public.leaderboard_ranks': populated ? 41760 : 0,
    },
    index_count: populated ? 510 : 16,
    nonempty_table_count: populated ? 153 : 0,
    table_count: populated ? 345 : 24,
    target_identity_sha256: targetIdentity,
  }
}

function rls(targetIdentity, checkedAt) {
  return {
    acl_sha256: sha256(`${targetIdentity}:acl`),
    catalog_sha256: sha256(`${targetIdentity}:rls-catalog`),
    checked_at: checkedAt,
    enabled_relation_count: 8,
    policy_count: 20,
    relation_count: 24,
    result: 'passed',
    target_identity_sha256: targetIdentity,
  }
}

function auth(targetIdentity, checkedAt, covered = true) {
  return {
    catalog_sha256: sha256(`${targetIdentity}:auth-catalog`),
    checked_at: checkedAt,
    coverage: covered ? 'managed-platform' : 'not-in-app-backup',
    existing_login: covered ? 'passed' : 'not-covered',
    identity_count: covered ? 12 : 0,
    mfa_if_configured: covered ? 'not-applicable' : 'not-covered',
    new_registration: covered ? 'passed' : 'not-covered',
    oauth_if_configured: covered ? 'not-applicable' : 'not-covered',
    result: covered ? 'passed' : 'not-covered',
    target_identity_sha256: targetIdentity,
    user_count: covered ? 10 : 0,
  }
}

function smoke(targetIdentity, checkedAt) {
  return {
    checked_at: checkedAt,
    checks: [
      { id: 'health', result: 'passed' },
      { id: 'rankings', result: 'passed' },
      { id: 'traders', result: 'passed' },
    ],
    result: 'passed',
    target_identity_sha256: targetIdentity,
  }
}

function restore({ current, targetValue }) {
  const targetIdentity = targetValue.identity_sha256
  const artifactSha = sha256(current ? 'current-artifact-body' : 'legacy-artifact-body')
  const startedAt = current ? '2026-08-05T02:00:00.000Z' : '2026-08-04T01:00:00.000Z'
  const streamStartedAt = current ? '2026-08-05T02:01:00.000Z' : '2026-08-04T01:01:00.000Z'
  const streamCompletedAt = current ? '2026-08-05T04:00:00.000Z' : '2026-08-04T03:00:00.000Z'
  const checkedAt = current ? '2026-08-05T04:20:00.000Z' : '2026-08-04T03:20:00.000Z'
  const serviceReadyAt = current ? '2026-08-05T04:40:00.000Z' : '2026-08-04T03:40:00.000Z'
  const completedAt = current ? '2026-08-05T05:00:00.000Z' : '2026-08-04T04:00:00.000Z'
  const backupCompletedAt = current ? '2026-08-05T01:30:00.000Z' : '2026-07-26T01:00:00.000Z'
  const source = current
    ? {
        artifact_identity_sha256: sha256('current-object-identity'),
        artifact_sha256: artifactSha,
        kind: 'current-contract-post-incident',
      }
    : {
        artifact_identity_sha256: sha256('legacy-object-identity'),
        artifact_sha256: artifactSha,
        kind: 'protected-legacy-2026-07-26',
        protected_copy_identity_sha256: sha256('legacy-protected-copy'),
        snapshot_date: '2026-07-26',
      }
  return {
    auth: auth(targetIdentity, checkedAt, current),
    completed_at: completedAt,
    completion: {
      artifact_bytes: current ? 2147483648 : 5112388073,
      artifact_sha256: artifactSha,
      backup_completed_at: backupCompletedAt,
      gzip_crc_result: 'passed',
      gzip_isize_result: 'passed',
      metadata_contract: current ? 'arena.pg-dump-complete.v1' : 'legacy-pg17-restrict-footer',
      metadata_sha256: sha256(`${current ? 'current' : 'legacy'}:completion-metadata`),
      metadata_verified: true,
      pg_dump_tail_result: 'passed',
      required_relations_result: 'passed',
      restore_exit_code: 0,
      stream_completed_at: streamCompletedAt,
      stream_started_at: streamStartedAt,
      tail_sha256: sha256(`${current ? 'current' : 'legacy'}:tail`),
      target_identity_sha256: targetIdentity,
    },
    counts: counts(targetIdentity, checkedAt),
    evidence_id: sha256(`${current ? 'current' : 'legacy'}:restore-evidence`),
    purpose: current ? 'current-contract-post-incident-restore' : 'protected-legacy-restore',
    result: current ? 'passed' : 'failed',
    rls: rls(targetIdentity, checkedAt),
    rpo_rto: {
      backup_cutoff_at: backupCompletedAt,
      calculation_sha256: sha256(`${current ? 'current' : 'legacy'}:rpo-rto`),
      latest_included_at: current ? '2026-08-05T01:25:00.000Z' : '2026-07-26T00:30:00.000Z',
      rpo_seconds: current ? 300 : 1800,
      rto_seconds: 9600,
      service_ready_at: serviceReadyAt,
      target_identity_sha256: targetIdentity,
    },
    smoke: smoke(targetIdentity, checkedAt),
    source,
    started_at: startedAt,
    subject_target_sha256: targetIdentity,
    target: targetValue,
  }
}

function comparison(targetIdentity, expectedCatalog, expectedLedger) {
  return {
    actual_catalog_sha256: expectedCatalog,
    actual_ledger_sha256: expectedLedger,
    catalog_match: true,
    catalog_mismatch_count: 0,
    catalog_mismatch_manifest_sha256: null,
    expected_catalog_sha256: expectedCatalog,
    expected_ledger_sha256: expectedLedger,
    ledger_match: true,
    ledger_mismatch_count: 0,
    ledger_mismatch_manifest_sha256: null,
    target_identity_sha256: targetIdentity,
  }
}

function replay({
  candidateEvidenceId,
  expectedCatalog,
  expectedLedger,
  foundationSha,
  gitSha,
  platformPrerequisitesSha,
  preview,
  replayRunnerSha,
  slot,
}) {
  const suffix = preview ? 'preview' : slot
  const startedAt = preview ? '2026-08-05T09:00:00.000Z' : '2026-08-05T07:00:00.000Z'
  const checkedAt = preview ? '2026-08-05T09:40:00.000Z' : '2026-08-05T07:40:00.000Z'
  const completedAt = preview ? '2026-08-05T10:00:00.000Z' : '2026-08-05T08:00:00.000Z'
  const targetValue = target({
    capacity: `${suffix}:capacity`,
    createdAt: preview ? '2026-08-05T08:30:00.000Z' : '2026-08-05T06:30:00.000Z',
    deletedAt: preview ? '2026-08-05T10:10:00.000Z' : '2026-08-05T08:10:00.000Z',
    identity: `${suffix}:target`,
    kind: preview ? 'managed-preview' : 'managed-schema-replay',
  })
  const targetIdentity = targetValue.identity_sha256
  return {
    auth: auth(targetIdentity, checkedAt),
    candidate_evidence_id: candidateEvidenceId,
    completed_at: completedAt,
    comparison: comparison(targetIdentity, expectedCatalog, expectedLedger),
    counts: counts(targetIdentity, checkedAt, false),
    evidence_id: sha256(`${suffix}:evidence`),
    foundation_sha256: foundationSha,
    git_sha: gitSha,
    phases: { app_schema: 'passed', forward_epoch: 'passed', foundation: 'passed' },
    platform_prerequisites_sha256: platformPrerequisitesSha,
    ...(preview ? { pull_request_number: 255 } : {}),
    purpose: preview ? 'managed-preview-full-replay' : 'managed-pg17-baseline-replay',
    replay_runner_sha256: replayRunnerSha,
    result: 'passed',
    rls: rls(targetIdentity, checkedAt),
    ...(!preview ? { slot } : {}),
    smoke: smoke(targetIdentity, checkedAt),
    started_at: startedAt,
    status: preview ? 'preview/candidate-evidence' : 'replay/candidate-evidence',
    subject_target_sha256: targetIdentity,
    target: targetValue,
  }
}

function receiptFixture() {
  const gitSha = 'a'.repeat(40)
  const legacyTarget = target({
    capacity: 'legacy-restore-capacity',
    createdAt: '2026-08-04T00:00:00.000Z',
    deletedAt: '2026-08-04T04:30:00.000Z',
    identity: 'legacy-target',
    kind: 'managed-restore',
    minimumDiskGiB: 100,
  })
  const currentTarget = target({
    capacity: 'current-restore-capacity',
    createdAt: '2026-08-05T01:00:00.000Z',
    deletedAt: '2026-08-05T05:30:00.000Z',
    identity: 'current-target',
    kind: 'managed-restore',
    minimumDiskGiB: 100,
  })
  const captureEvidenceId = sha256('source-capture-evidence')
  const sourceCatalog = sha256('source-normalized-catalog')
  const candidateEvidenceId = sha256('candidate-evidence')
  const expectedCatalog = sha256('candidate-expected-catalog')
  const expectedLedger = sha256('candidate-expected-ledger')
  const foundationSha = sha256('managed-pg17-foundation')
  const platformPrerequisitesSha = sha256('platform-prerequisites')
  const replayRunnerSha = sha256('replay-runner')
  const candidate = {
    artifact_sha256: sha256('candidate-artifact'),
    capture_evidence_id: captureEvidenceId,
    created_at: '2026-08-05T06:10:00.000Z',
    evidence_id: candidateEvidenceId,
    expected_replay_catalog_sha256: expectedCatalog,
    expected_replay_ledger_sha256: expectedLedger,
    foundation_sha256: foundationSha,
    git_sha: gitSha,
    independent_review: {
      result: 'passed',
      reviewed_at: '2026-08-05T06:20:00.000Z',
      reviewer_identity_sha256: sha256('reviewer'),
    },
    launch_inventory_sha256: sha256('launch-inventory'),
    postdeploy_migration_count: 3,
    predeploy_migration_count: 122,
    platform_prerequisites_sha256: platformPrerequisitesSha,
    production_deployable: false,
    purpose: 'canonical-baseline-candidate',
    replay_runner_sha256: replayRunnerSha,
    source_catalog_sha256: sourceCatalog,
    status: 'candidate/not-deployable',
  }
  return {
    candidate,
    contract: MANAGED_EVIDENCE_RECEIPT_CONTRACT,
    created_at: '2026-08-05T11:00:00.000Z',
    current_contract_restore: restore({ current: true, targetValue: currentTarget }),
    legacy_restore: restore({ current: false, targetValue: legacyTarget }),
    managed_pg17_replays: [
      replay({
        candidateEvidenceId,
        expectedCatalog,
        expectedLedger,
        foundationSha,
        gitSha,
        platformPrerequisitesSha,
        replayRunnerSha,
        slot: 'replay-a',
      }),
      replay({
        candidateEvidenceId,
        expectedCatalog,
        expectedLedger,
        foundationSha,
        gitSha,
        platformPrerequisitesSha,
        replayRunnerSha,
        slot: 'replay-b',
      }),
    ],
    preview: replay({
      candidateEvidenceId,
      expectedCatalog,
      expectedLedger,
      foundationSha,
      gitSha,
      platformPrerequisitesSha,
      preview: true,
      replayRunnerSha,
    }),
    production_authorized: false,
    provider_incident: {
      evidence_sha256: sha256('provider-resolution-evidence'),
      incident_identity_sha256: sha256('provider-incident'),
      resolved_at: '2026-08-05T00:00:00.000Z',
      status: 'resolved/evidence-only',
    },
    receipt_id: sha256('receipt'),
    source_capture: {
      artifacts: {
        app_schema_sha256: sha256('app-schema'),
        migration_ledger_sha256: sha256('source-ledger'),
        normalized_catalog_sha256: sourceCatalog,
        source_catalog_file_sha256: sha256('source-catalog-file'),
      },
      ca_sha256: sha256('server-ca'),
      ca_validity: {
        not_after: '2027-01-01T00:00:00.000Z',
        not_before: '2026-01-01T00:00:00.000Z',
      },
      captured_at: '2026-08-05T06:00:00.000Z',
      connection_mode: 'direct-5432',
      evidence_id: captureEvidenceId,
      git_sha: gitSha,
      incomplete_marker_absent: true,
      postgres_version: '17.8',
      purpose: 'canonical-source-capture',
      repeatable_read: true,
      source_identity_sha256: sha256('production-source-identity'),
      sslmode: 'verify-full',
      status: 'source-capture/not-a-candidate',
      subject_source_identity_sha256: sha256('production-source-identity'),
      transaction_read_only: true,
    },
    status: MANAGED_EVIDENCE_RECEIPT_STATUS,
  }
}

function clone(value) {
  return structuredClone(value)
}

function allClaimsPassedFixture() {
  const receipt = receiptFixture()
  Object.assign(receipt.legacy_restore.auth, {
    coverage: 'managed-platform',
    existing_login: 'passed',
    identity_count: 12,
    mfa_if_configured: 'not-applicable',
    new_registration: 'passed',
    oauth_if_configured: 'not-applicable',
    result: 'passed',
    user_count: 10,
  })
  receipt.legacy_restore.result = 'passed'
  return receipt
}

function deletePath(value, pathParts) {
  const parent = pathParts.slice(0, -1).reduce((current, key) => current[key], value)
  delete parent[pathParts.at(-1)]
}

test('accepts structurally complete claims without presenting them as evidence proof or live GO', () => {
  const summary = validateManagedEvidenceReceipt(receiptFixture())
  assert.deepEqual(summary, {
    all_claimed_checks_passed: false,
    claim_fields_structurally_complete: true,
    contract: MANAGED_EVIDENCE_RECEIPT_CONTRACT,
    evidence_proven: false,
    external_evidence_files_verified: false,
    external_evidence_hashes_recomputed: false,
    production_authorized: false,
    receipt_id: sha256('receipt'),
    status: MANAGED_EVIDENCE_RECEIPT_STATUS,
  })
})

test('keeps a fully passed set of self-asserted claims explicitly below evidence proof', () => {
  const summary = validateManagedEvidenceReceipt(allClaimsPassedFixture())
  assert.equal(summary.all_claimed_checks_passed, true)
  assert.equal(summary.claim_fields_structurally_complete, true)
  assert.equal(summary.evidence_proven, false)
  assert.equal(summary.external_evidence_files_verified, false)
  assert.equal(summary.external_evidence_hashes_recomputed, false)
  assert.equal(summary.production_authorized, false)
  assert.equal(summary.status, 'receipt/claims-only')
})

test('schema is machine-readable and the placeholder template is deliberately not evidence', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const refs = []
  const collectRefs = (value) => {
    if (Array.isArray(value)) return value.forEach(collectRefs)
    if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') refs.push(value.$ref)
      Object.values(value).forEach(collectRefs)
    }
  }
  collectRefs(schema)
  const prefix = '#/$defs/'
  assert.equal(
    refs.every((ref) => ref.startsWith(prefix) && ref.slice(prefix.length) in schema.$defs),
    true
  )
  assert.equal(schema.properties.contract.const, MANAGED_EVIDENCE_RECEIPT_CONTRACT)
  assert.equal(schema.properties.status.const, MANAGED_EVIDENCE_RECEIPT_STATUS)
  assert.equal(schema.properties.production_authorized.const, false)
  assert.match(
    schema.description,
    /Shape-only.*does not recompute hashes.*verify external evidence/u
  )
  assert.match(schema.$comment, /schema is not evidence proof/iu)
  assert.equal(schema.properties.managed_pg17_replays.minItems, 2)
  assert.equal(schema.properties.managed_pg17_replays.maxItems, 2)
  assert.equal(schema.$defs.target.required.includes('extensions'), true)
  assert.equal(schema.$defs.extensionCatalog.minItems, 1)
  for (const field of [
    'foundation_sha256',
    'platform_prerequisites_sha256',
    'replay_runner_sha256',
  ]) {
    assert.equal(schema.$defs.candidate.required.includes(field), true)
    assert.equal(schema.$defs.replay.required.includes(field), true)
    assert.equal(schema.$defs.preview.required.includes(field), true)
  }
  assert.equal(template.status, 'template/not-evidence')
  assert.throws(() => validateManagedEvidenceReceipt(template), /EXPECTED_RECEIPT\/CLAIMS-ONLY/u)
})

test('rejects missing completion, CRC/tail, counts, RLS, Auth, and RPO/RTO evidence', async (t) => {
  const requiredPaths = [
    ['legacy_restore', 'completion'],
    ['legacy_restore', 'completion', 'metadata_sha256'],
    ['legacy_restore', 'completion', 'gzip_crc_result'],
    ['legacy_restore', 'completion', 'pg_dump_tail_result'],
    ['legacy_restore', 'counts'],
    ['legacy_restore', 'rls'],
    ['legacy_restore', 'auth'],
    ['legacy_restore', 'rpo_rto'],
    ['legacy_restore', 'target', 'extensions'],
    ['current_contract_restore', 'completion'],
    ['current_contract_restore', 'counts'],
    ['current_contract_restore', 'rls'],
    ['current_contract_restore', 'auth'],
    ['current_contract_restore', 'rpo_rto'],
    ['source_capture', 'artifacts'],
    ['candidate', 'independent_review'],
    ['candidate', 'foundation_sha256'],
    ['candidate', 'platform_prerequisites_sha256'],
    ['candidate', 'replay_runner_sha256'],
    ['managed_pg17_replays', 0, 'comparison'],
    ['managed_pg17_replays', 0, 'counts'],
    ['managed_pg17_replays', 0, 'rls'],
    ['managed_pg17_replays', 0, 'auth'],
    ['managed_pg17_replays', 0, 'foundation_sha256'],
    ['managed_pg17_replays', 0, 'platform_prerequisites_sha256'],
    ['managed_pg17_replays', 0, 'replay_runner_sha256'],
    ['preview', 'comparison'],
    ['preview', 'counts'],
    ['preview', 'rls'],
    ['preview', 'auth'],
  ]
  for (const pathParts of requiredPaths) {
    await t.test(pathParts.join('.'), () => {
      const receipt = clone(receiptFixture())
      deletePath(receipt, pathParts)
      assert.throws(() => validateManagedEvidenceReceipt(receipt), /EXACT_FIELDS_REQUIRED/u)
    })
  }
})

test('requires a non-empty canonically sorted exact extension catalogue on every target', () => {
  const empty = clone(receiptFixture())
  empty.preview.target.extensions = []
  assert.throws(() => validateManagedEvidenceReceipt(empty), /MINIMUM_LENGTH_REQUIRED/u)

  const reordered = clone(receiptFixture())
  reordered.managed_pg17_replays[0].target.extensions.reverse()
  assert.throws(
    () => validateManagedEvidenceReceipt(reordered),
    /EXTENSIONS_MUST_BE_CANONICALLY_SORTED/u
  )

  const duplicateName = clone(receiptFixture())
  duplicateName.current_contract_restore.target.extensions.push({
    name: 'uuid-ossp',
    schema: 'extensions',
    version: '1.2',
  })
  assert.throws(() => validateManagedEvidenceReceipt(duplicateName), /DUPLICATE_EXTENSION_NAME/u)

  const malformed = clone(receiptFixture())
  malformed.legacy_restore.target.extensions[0].version = 'Version 1'
  assert.throws(() => validateManagedEvidenceReceipt(malformed), /INVALID_FORMAT/u)
})

test('keeps every restore, replay, and Preview target/evidence identity independent', () => {
  const mixedBinding = clone(receiptFixture())
  mixedBinding.legacy_restore.counts.target_identity_sha256 =
    mixedBinding.current_contract_restore.target.identity_sha256
  assert.throws(() => validateManagedEvidenceReceipt(mixedBinding), /EXPECTED_[0-9A-F]{64}/u)

  const duplicateTargets = clone(receiptFixture())
  duplicateTargets.managed_pg17_replays[1].target.identity_sha256 =
    duplicateTargets.managed_pg17_replays[0].target.identity_sha256
  const duplicateIdentity = duplicateTargets.managed_pg17_replays[1].target.identity_sha256
  for (const block of ['auth', 'comparison', 'counts', 'rls', 'smoke']) {
    duplicateTargets.managed_pg17_replays[1][block].target_identity_sha256 = duplicateIdentity
  }
  duplicateTargets.managed_pg17_replays[1].subject_target_sha256 = duplicateIdentity
  assert.throws(
    () => validateManagedEvidenceReceipt(duplicateTargets),
    /TARGET_IDENTITIES_MUST_BE_DISTINCT/u
  )

  const duplicateEvidence = clone(receiptFixture())
  duplicateEvidence.preview.evidence_id = duplicateEvidence.managed_pg17_replays[0].evidence_id
  assert.throws(
    () => validateManagedEvidenceReceipt(duplicateEvidence),
    /EVIDENCE_IDENTITIES_MUST_BE_DISTINCT/u
  )

  const targetAsEvidence = clone(receiptFixture())
  targetAsEvidence.preview.evidence_id = targetAsEvidence.preview.target.identity_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(targetAsEvidence),
    /TARGET_AND_EVIDENCE_IDENTITIES_MUST_BE_DISTINCT/u
  )

  const duplicateArtifacts = clone(receiptFixture())
  duplicateArtifacts.current_contract_restore.source.artifact_sha256 =
    duplicateArtifacts.legacy_restore.source.artifact_sha256
  duplicateArtifacts.current_contract_restore.completion.artifact_sha256 =
    duplicateArtifacts.legacy_restore.source.artifact_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(duplicateArtifacts),
    /SOURCE_ARTIFACTS_MUST_BE_DISTINCT/u
  )
})

test('requires independent capacity slots across both restores, both replays, and Preview', () => {
  const duplicateReplayCapacity = clone(receiptFixture())
  duplicateReplayCapacity.managed_pg17_replays[1].target.capacity_slot_sha256 =
    duplicateReplayCapacity.managed_pg17_replays[0].target.capacity_slot_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(duplicateReplayCapacity),
    /TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT/u
  )

  const previewReusesReplayCapacity = clone(receiptFixture())
  previewReusesReplayCapacity.preview.target.capacity_slot_sha256 =
    previewReusesReplayCapacity.managed_pg17_replays[0].target.capacity_slot_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(previewReusesReplayCapacity),
    /TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT/u
  )

  const restoreReusesRestoreCapacity = clone(receiptFixture())
  restoreReusesRestoreCapacity.current_contract_restore.target.capacity_slot_sha256 =
    restoreReusesRestoreCapacity.legacy_restore.target.capacity_slot_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(restoreReusesRestoreCapacity),
    /TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT/u
  )

  const replayReusesRestoreCapacity = clone(receiptFixture())
  replayReusesRestoreCapacity.managed_pg17_replays[0].target.capacity_slot_sha256 =
    replayReusesRestoreCapacity.legacy_restore.target.capacity_slot_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(replayReusesRestoreCapacity),
    /TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT/u
  )

  const previewReusesRestoreCapacity = clone(receiptFixture())
  previewReusesRestoreCapacity.preview.target.capacity_slot_sha256 =
    previewReusesRestoreCapacity.current_contract_restore.target.capacity_slot_sha256
  assert.throws(
    () => validateManagedEvidenceReceipt(previewReusesRestoreCapacity),
    /TARGET_CAPACITY_SLOTS_MUST_BE_DISTINCT/u
  )
})

test('does not allow failed checks to be relabeled as passed restore or replay evidence', () => {
  const failedTail = clone(receiptFixture())
  failedTail.current_contract_restore.completion.pg_dump_tail_result = 'failed'
  assert.throws(
    () => validateManagedEvidenceReceipt(failedTail),
    /PASSED_RESTORE_CLAIM_UNSUPPORTED/u
  )

  const zeroCriticalRows = clone(receiptFixture())
  zeroCriticalRows.current_contract_restore.counts.critical_rows['arena.traders'] = 0
  assert.throws(
    () => validateManagedEvidenceReceipt(zeroCriticalRows),
    /PASSED_RESTORE_CLAIM_UNSUPPORTED/u
  )

  const mismatchedReplay = clone(receiptFixture())
  const comparisonValue = mismatchedReplay.managed_pg17_replays[0].comparison
  comparisonValue.catalog_match = false
  comparisonValue.actual_catalog_sha256 = sha256('different-catalog')
  comparisonValue.catalog_mismatch_count = 1
  comparisonValue.catalog_mismatch_manifest_sha256 = sha256('mismatch')
  assert.throws(
    () => validateManagedEvidenceReceipt(mismatchedReplay),
    /PASSED_REPLAY_CLAIM_UNSUPPORTED/u
  )

  const failedAuthSubcheck = clone(receiptFixture())
  failedAuthSubcheck.current_contract_restore.auth.existing_login = 'failed'
  assert.throws(
    () => validateManagedEvidenceReceipt(failedAuthSubcheck),
    /PASSED_AUTH_CLAIM_UNSUPPORTED/u
  )

  const emptyAuthPopulation = clone(receiptFixture())
  emptyAuthPopulation.preview.auth.identity_count = 0
  assert.throws(
    () => validateManagedEvidenceReceipt(emptyAuthPopulation),
    /PASSED_AUTH_CLAIM_UNSUPPORTED/u
  )

  const unsupportedCoveredAuthOutcome = clone(receiptFixture())
  unsupportedCoveredAuthOutcome.managed_pg17_replays[0].auth.mfa_if_configured = 'not-covered'
  assert.throws(
    () => validateManagedEvidenceReceipt(unsupportedCoveredAuthOutcome),
    /PASSED_AUTH_CLAIM_UNSUPPORTED/u
  )

  const uncoveredPassedAuth = clone(receiptFixture())
  uncoveredPassedAuth.current_contract_restore.auth.coverage = 'not-in-app-backup'
  assert.throws(
    () => validateManagedEvidenceReceipt(uncoveredPassedAuth),
    /AUTH_NONCOVERAGE_RESULT_REQUIRED/u
  )

  const emptyRlsClaim = clone(receiptFixture())
  Object.assign(emptyRlsClaim.preview.rls, {
    enabled_relation_count: 0,
    policy_count: 0,
    relation_count: 0,
  })
  assert.throws(
    () => validateManagedEvidenceReceipt(emptyRlsClaim),
    /PASSED_RLS_CLAIM_REQUIRES_POSITIVE_COUNTS/u
  )
})

test('enforces provider recovery, restore, capture, review, and replay chronology', () => {
  const currentBackupBeforeRecovery = clone(receiptFixture())
  currentBackupBeforeRecovery.current_contract_restore.completion.backup_completed_at =
    '2026-08-04T23:59:59.000Z'
  assert.throws(
    () => validateManagedEvidenceReceipt(currentBackupBeforeRecovery),
    /BACKUP_BEFORE_INCIDENT_RESOLUTION/u
  )

  const captureBeforeRestore = clone(receiptFixture())
  captureBeforeRestore.source_capture.captured_at = '2026-08-05T04:59:59.000Z'
  assert.throws(
    () => validateManagedEvidenceReceipt(captureBeforeRestore),
    /CAPTURE_BEFORE_RESTORE_EVIDENCE/u
  )

  const replayBeforeReview = clone(receiptFixture())
  replayBeforeReview.managed_pg17_replays[0].started_at = '2026-08-05T06:19:59.000Z'
  assert.throws(
    () => validateManagedEvidenceReceipt(replayBeforeReview),
    /STARTED_BEFORE_CANDIDATE_REVIEW/u
  )

  const previewBeforeManagedReplaysComplete = clone(receiptFixture())
  previewBeforeManagedReplaysComplete.preview.target.created_at = '2026-08-05T07:30:00.000Z'
  previewBeforeManagedReplaysComplete.preview.started_at = '2026-08-05T07:59:59.000Z'
  assert.throws(
    () => validateManagedEvidenceReceipt(previewBeforeManagedReplaysComplete),
    /STARTED_BEFORE_MANAGED_REPLAYS_COMPLETED/u
  )
})

test('binds comparison hashes to the candidate and requires mismatch manifests', () => {
  const forgedExpected = clone(receiptFixture())
  forgedExpected.preview.comparison.expected_catalog_sha256 = sha256('forged')
  assert.throws(() => validateManagedEvidenceReceipt(forgedExpected), /EXPECTED_[0-9A-F]{64}/u)

  const missingMismatch = clone(receiptFixture())
  missingMismatch.managed_pg17_replays[0].comparison.catalog_match = false
  missingMismatch.managed_pg17_replays[0].comparison.actual_catalog_sha256 = sha256('different')
  assert.throws(
    () => validateManagedEvidenceReceipt(missingMismatch),
    /CATALOG_MISMATCH_EVIDENCE_REQUIRED/u
  )

  const validMismatch = clone(receiptFixture())
  validMismatch.managed_pg17_replays[0].comparison.catalog_match = false
  validMismatch.managed_pg17_replays[0].comparison.actual_catalog_sha256 = sha256('different')
  validMismatch.managed_pg17_replays[0].comparison.catalog_mismatch_count = 2
  validMismatch.managed_pg17_replays[0].comparison.catalog_mismatch_manifest_sha256 =
    sha256('mismatch-manifest')
  validMismatch.managed_pg17_replays[0].result = 'failed'
  assert.equal(validateManagedEvidenceReceipt(validMismatch).all_claimed_checks_passed, false)

  const wrongFoundation = clone(receiptFixture())
  wrongFoundation.preview.foundation_sha256 = sha256('different-foundation')
  assert.throws(
    () => validateManagedEvidenceReceipt(wrongFoundation),
    /preview\.foundation_sha256:EXPECTED_[0-9A-F]{64}/u
  )

  const wrongPrerequisites = clone(receiptFixture())
  wrongPrerequisites.managed_pg17_replays[0].platform_prerequisites_sha256 =
    sha256('different-prerequisites')
  assert.throws(
    () => validateManagedEvidenceReceipt(wrongPrerequisites),
    /platform_prerequisites_sha256:EXPECTED_[0-9A-F]{64}/u
  )

  const wrongRunner = clone(receiptFixture())
  wrongRunner.managed_pg17_replays[1].replay_runner_sha256 = sha256('different-runner')
  assert.throws(
    () => validateManagedEvidenceReceipt(wrongRunner),
    /replay_runner_sha256:EXPECTED_[0-9A-F]{64}/u
  )
})

test('rejects secret-like fields, URLs, key material, JWTs, and live GO claims', async (t) => {
  const mutations = [
    (receipt) => {
      receipt.database_url = 'postgresql://operator:do-not-store@example.invalid:5432/postgres'
    },
    (receipt) => {
      receipt.preview.target.compute_class = 'https://example.invalid/project'
    },
    (receipt) => {
      receipt.preview.access_token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    },
    (receipt) => {
      receipt.preview.note = 'password=do-not-store-this'
    },
    (receipt) => {
      receipt.preview.note = '-----BEGIN PRIVATE KEY-----'
    },
    (receipt) => {
      receipt.preview.note = 'eyJabcdefghijk.eyJabcdefghijk.abcdefghijk'
    },
    (receipt) => {
      receipt.candidate.status = 'production-ready'
    },
  ]
  for (const [index, mutate] of mutations.entries()) {
    await t.test(String(index), () => {
      const receipt = clone(receiptFixture())
      mutate(receipt)
      assert.throws(
        () => validateManagedEvidenceReceipt(receipt),
        /(?:SECRET_LIKE|URL_FORBIDDEN|LIVE_GO_CLAIM_FORBIDDEN)/u
      )
    })
  }

  const unsafeKey = clone(receiptFixture())
  unsafeKey['bad\u001b[31mkey'] = { nested: 'https://example.invalid' }
  assert.throws(
    () => validateManagedEvidenceReceipt(unsafeKey),
    (error) =>
      error.code === 'receipt:UNSAFE_OBJECT_KEY_FORBIDDEN' && !error.code.includes('\u001b')
  )

  const tokenLikeKey = clone(receiptFixture())
  tokenLikeKey.ghp_abcdefghijklmnopqrstuvwxyz123456 = false
  assert.throws(
    () => validateManagedEvidenceReceipt(tokenLikeKey),
    (error) => error.code === 'receipt:UNSAFE_OBJECT_KEY_FORBIDDEN'
  )
})

test('CLI reads one pinned owner-only local JSON and emits only a claims-only non-GO summary', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-managed-receipt-'))
  try {
    const receiptPath = resolve(directory, 'receipt.json')
    writeFileSync(receiptPath, `${JSON.stringify(receiptFixture())}\n`, { mode: 0o600 })
    const accepted = spawnSync(process.execPath, [SCRIPT, receiptPath], { encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    const summary = JSON.parse(accepted.stdout)
    assert.equal(summary.claim_fields_structurally_complete, true)
    assert.equal(summary.evidence_proven, false)
    assert.equal(summary.external_evidence_files_verified, false)
    assert.equal(summary.external_evidence_hashes_recomputed, false)
    assert.equal(summary.production_authorized, false)
    assert.equal(accepted.stdout.includes('postgresql://'), false)

    const noPath = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    assert.equal(noPath.status, 2)
    assert.match(noPath.stderr, /Usage:/u)

    const option = spawnSync(process.execPath, [SCRIPT, '--live'], { encoding: 'utf8' })
    assert.equal(option.status, 2)

    const invalidJsonPath = resolve(directory, 'invalid.json')
    writeFileSync(invalidJsonPath, '{not-json}\n', { mode: 0o600 })
    const invalidJson = spawnSync(process.execPath, [SCRIPT, invalidJsonPath], { encoding: 'utf8' })
    assert.equal(invalidJson.status, 1)
    assert.match(invalidJson.stderr, /CLI:JSON_INVALID/u)

    const sensitivePath = resolve(directory, 'sensitive.json')
    writeFileSync(
      sensitivePath,
      JSON.stringify({ database_url: 'postgresql://operator:do-not-echo@example.invalid/db' }),
      { mode: 0o600 }
    )
    const sensitive = spawnSync(process.execPath, [SCRIPT, sensitivePath], { encoding: 'utf8' })
    assert.equal(sensitive.status, 1)
    assert.match(sensitive.stderr, /SECRET_LIKE_FIELD_FORBIDDEN/u)
    assert.doesNotMatch(sensitive.stderr, /do-not-echo|operator|example\.invalid/u)

    const unsafeKeyPath = resolve(directory, 'unsafe-key.json')
    writeFileSync(
      unsafeKeyPath,
      JSON.stringify({ ['bad\u001b[31mkey']: { nested: 'https://example.invalid' } }),
      { mode: 0o600 }
    )
    const unsafeKey = spawnSync(process.execPath, [SCRIPT, unsafeKeyPath], { encoding: 'utf8' })
    assert.equal(unsafeKey.status, 1)
    assert.match(unsafeKey.stderr, /UNSAFE_OBJECT_KEY_FORBIDDEN/u)
    assert.doesNotMatch(unsafeKey.stderr, /bad|\u001b|example\.invalid/u)

    const symlinkPath = resolve(directory, 'receipt-link.json')
    symlinkSync(receiptPath, symlinkPath)
    const symlink = spawnSync(process.execPath, [SCRIPT, symlinkPath], { encoding: 'utf8' })
    assert.equal(symlink.status, 1)
    assert.match(symlink.stderr, /LOCAL_JSON_UNREADABLE/u)

    const publicPath = resolve(directory, 'public-receipt.json')
    writeFileSync(publicPath, `${JSON.stringify(receiptFixture())}\n`, { mode: 0o600 })
    chmodSync(publicPath, 0o644)
    const publicReceipt = spawnSync(process.execPath, [SCRIPT, publicPath], { encoding: 'utf8' })
    assert.equal(publicReceipt.status, 1)
    assert.match(publicReceipt.stderr, /OWNER_ONLY_FILE_REQUIRED/u)

    const template = spawnSync(process.execPath, [SCRIPT, TEMPLATE], { encoding: 'utf8' })
    assert.equal(template.status, 1)
    assert.match(template.stderr, /OWNER_ONLY_FILE_REQUIRED/u)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('implementation has no network, subprocess, environment, or filesystem-write path', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|node:net|node:tls/u)
  assert.doesNotMatch(source, /spawn|execFile|execSync|process\.env|dotenv/u)
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|unlink|rename|mkdir|rmSync/u)
  assert.match(source, /O_RDONLY\s*\|\s*fsConstants\.O_NOFOLLOW/u)
  assert.match(source, /process\.geteuid/u)
  assert.match(source, /before\.ctimeMs\s*!==\s*after\.ctimeMs/u)
  assert.match(source, /before\.mode\s*&\s*0o077/u)
})
