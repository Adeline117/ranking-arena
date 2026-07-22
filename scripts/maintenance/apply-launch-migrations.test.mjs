import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const source = readFileSync(resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function migrationArray(name) {
  const marker = new RegExp(`^${name}=\\(\\n`, 'm')
  const match = marker.exec(source)
  assert.ok(match, `${name} is missing`)
  const bodyStart = match.index + match[0].length
  const end = source.indexOf('\n)', bodyStart)
  assert.notEqual(end, -1, `${name} is not terminated`)
  const body = source.slice(bodyStart, end)
  return [...body.matchAll(/^\s+(202\d{11}_[a-z0-9_]+\.sql)$/gm)].map((match) => match[1])
}

function writeFakeCleanReleaseGit(directory) {
  const fakeGit = resolve(directory, 'git')
  writeFileSync(
    fakeGit,
    [
      '#!/usr/bin/env bash',
      'set -eu',
      'args=" $* "',
      'if [[ "$*" == "rev-parse --show-toplevel" ]]; then',
      '  printf "%s\\n" "$FAKE_GIT_ROOT"',
      'elif [[ "$args" == *" ls-files --error-unmatch -- "* ]]; then',
      '  [[ "${FAKE_GIT_TRACKED:-true}" == "true" ]] || exit 1',
      '  printf "%s\\n" "${*: -1}"',
      'elif [[ "$args" == *" status --porcelain=v1 --untracked-files=normal "* ]]; then',
      '  printf "%s" "${FAKE_GIT_DIRTY:-}"',
      'elif [[ "$args" == *" status --porcelain=v1 --untracked-files=all "* ]]; then',
      '  printf "%s" "${FAKE_GIT_DIRTY:-}"',
      'elif [[ "$args" == *" ls-remote --exit-code origin refs/heads/main "* ]]; then',
      '  [[ "${FAKE_GIT_REMOTE_AVAILABLE:-true}" == "true" ]] || exit 2',
      '  printf "%s\\trefs/heads/main\\n" "$FAKE_GIT_LIVE_MAIN"',
      'elif [[ "$args" == *" rev-parse --verify refs/remotes/origin/main "* ]]; then',
      '  printf "%s\\n" "$FAKE_GIT_ORIGIN_MAIN"',
      'elif [[ "$args" == *" rev-parse --verify HEAD "* ]]; then',
      '  printf "%s\\n" "$FAKE_GIT_HEAD"',
      'else',
      '  printf "unexpected fake git invocation: %s\\n" "$*" >&2',
      '  exit 99',
      'fi',
      '',
    ].join('\n')
  )
  chmodSync(fakeGit, 0o755)
}

function cleanReleaseEnvironment(directory, overrides = {}) {
  const releaseSha = '1111111111111111111111111111111111111111'
  return {
    PATH: `${directory}:${process.env.PATH}`,
    FAKE_GIT_ROOT: ROOT,
    FAKE_GIT_HEAD: releaseSha,
    FAKE_GIT_ORIGIN_MAIN: releaseSha,
    FAKE_GIT_LIVE_MAIN: releaseSha,
    FAKE_GIT_TRACKED: 'true',
    ...overrides,
  }
}

function migrationBodySha(migration) {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, 'supabase/migrations', migration)))
    .digest('hex')
}

test('predeploy, postdeploy and recovery phases are exact, unique and ordered', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const recoveryPrerequisites = migrationArray('RECOVERY_PREREQUISITE_MIGRATIONS')
  const concurrentRecovery = migrationArray('CONCURRENT_RECOVERY_MIGRATIONS')
  const recovery = migrationArray('RECOVERY_MIGRATIONS')
  const superseded = migrationArray('SUPERSEDED_MIGRATIONS')
  const all = [...predeploy, ...postdeploy, ...concurrentRecovery, ...recovery, ...superseded]

  assert.equal(predeploy.length, 70)
  assert.deepEqual(postdeploy, [
    '20260716192000_social_edge_write_contract.sql',
    '20260717120000_trader_follows_composite_identity.sql',
  ])
  assert.equal(recoveryPrerequisites.length, 41)
  assert.deepEqual(recoveryPrerequisites, [
    ...predeploy.filter(
      (migration) =>
        ![
          '20260717130000_hero_stats_count_live_source_boards.sql',
          '20260718120000_leaderboard_source_freshness.sql',
          '20260718123000_shadow_sources_without_roi_basis.sql',
          '20260718130000_count_trader_account_followers.sql',
          '20260718131000_source_scope_trader_follow_activity.sql',
          '20260718132000_active_source_platform_freshness.sql',
          '20260718133000_history_partition_range_guard.sql',
          '20260718134000_freshness_expected_sources.sql',
          '20260718135000_partition_child_rls_convergence.sql',
          '20260718140000_add_metric_completeness_daily.sql',
          '20260718182917_arena_resolver_fetch_region.sql',
          '20260718183000_atomic_stripe_entitlement_identity.sql',
          '20260718183500_harden_stripe_entitlement_null_validation.sql',
          '20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql',
          '20260718184000_arena_score_inputs_board_as_of.sql',
          '20260718184500_classify_non_entitlement_stripe_payments.sql',
          '20260718184550_durable_tip_completion_notification.sql',
          '20260721120000_metric_trust_shadow_gate.sql',
          '20260721130000_raw_object_gc_outbox.sql',
          '20260721140000_idempotent_equivalent_refund_events.sql',
          '20260721150000_metric_trust_raw_artifact_identity.sql',
          '20260721175746_arena_score_inputs_publish_bundle.sql',
          '20260721210000_tip_checkout_lifecycle_atomic.sql',
          '20260721211000_tip_checkout_completion_identity.sql',
          '20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql',
          '20260722040000_leaderboard_acquisition_manifest_v3_compat.sql',
          '20260722041000_pure_arena_score_v4_scorer.sql',
          '20260722042000_leaderboard_terminal_publication_fence.sql',
          '20260722050000_metric_trust_attempt_outcome_authority.sql',
          '20260722051000_leaderboard_score_input_manifest_contract.sql',
        ].includes(migration)
    ),
    '20260716192000_social_edge_write_contract.sql',
  ])
  assert.deepEqual(concurrentRecovery, [
    '20260716090000_add_account_export_cursor_indexes.sql',
    '20260716091500_add_security_export_cursor_indexes.sql',
    '20260716094500_add_bookmark_export_cursor_indexes.sql',
    '20260716101500_add_interaction_export_cursor_indexes.sql',
    '20260716110000_add_domain_export_cursor_indexes.sql',
  ])
  assert.deepEqual(recovery, [
    '20260716112000_exchange_connections_server_only.sql',
    '20260716112200_atomic_impression_recording.sql',
    '20260716083256_repair_legacy_exchange_logo_paths.sql',
  ])
  assert.deepEqual(superseded, ['20260716104500_collection_read_write_boundaries.sql'])
  assert.equal(new Set(all).size, 81)
  assert.equal(predeploy[0], '20260716111600_atomic_group_application_review.sql')
  assert.deepEqual(predeploy.slice(-29), [
    '20260718120000_leaderboard_source_freshness.sql',
    '20260718123000_shadow_sources_without_roi_basis.sql',
    '20260718130000_count_trader_account_followers.sql',
    '20260718131000_source_scope_trader_follow_activity.sql',
    '20260718132000_active_source_platform_freshness.sql',
    '20260718133000_history_partition_range_guard.sql',
    '20260718134000_freshness_expected_sources.sql',
    '20260718135000_partition_child_rls_convergence.sql',
    '20260718140000_add_metric_completeness_daily.sql',
    '20260718182917_arena_resolver_fetch_region.sql',
    '20260718183000_atomic_stripe_entitlement_identity.sql',
    '20260718183500_harden_stripe_entitlement_null_validation.sql',
    '20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql',
    '20260718184000_arena_score_inputs_board_as_of.sql',
    '20260718184500_classify_non_entitlement_stripe_payments.sql',
    '20260718184550_durable_tip_completion_notification.sql',
    '20260721120000_metric_trust_shadow_gate.sql',
    '20260721130000_raw_object_gc_outbox.sql',
    '20260721140000_idempotent_equivalent_refund_events.sql',
    '20260721150000_metric_trust_raw_artifact_identity.sql',
    '20260721175746_arena_score_inputs_publish_bundle.sql',
    '20260721210000_tip_checkout_lifecycle_atomic.sql',
    '20260721211000_tip_checkout_completion_identity.sql',
    '20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql',
    '20260722040000_leaderboard_acquisition_manifest_v3_compat.sql',
    '20260722041000_pure_arena_score_v4_scorer.sql',
    '20260722042000_leaderboard_terminal_publication_fence.sql',
    '20260722050000_metric_trust_attempt_outcome_authority.sql',
    '20260722051000_leaderboard_score_input_manifest_contract.sql',
  ])
  assert.ok(predeploy.includes('20260718183000_atomic_stripe_entitlement_identity.sql'))
  assert.ok(predeploy.includes('20260718183500_harden_stripe_entitlement_null_validation.sql'))
  assert.ok(predeploy.includes('20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql'))
  assert.ok(predeploy.includes('20260718184000_arena_score_inputs_board_as_of.sql'))
  assert.ok(predeploy.includes('20260718184500_classify_non_entitlement_stripe_payments.sql'))
  assert.ok(predeploy.includes('20260718184550_durable_tip_completion_notification.sql'))
  assert.ok(predeploy.includes('20260721120000_metric_trust_shadow_gate.sql'))
  assert.ok(predeploy.includes('20260721130000_raw_object_gc_outbox.sql'))
  assert.ok(predeploy.includes('20260721140000_idempotent_equivalent_refund_events.sql'))
  assert.ok(predeploy.includes('20260721150000_metric_trust_raw_artifact_identity.sql'))
  assert.ok(predeploy.includes('20260721175746_arena_score_inputs_publish_bundle.sql'))
  assert.ok(predeploy.includes('20260721210000_tip_checkout_lifecycle_atomic.sql'))
  assert.ok(predeploy.includes('20260721211000_tip_checkout_completion_identity.sql'))
  assert.ok(predeploy.includes('20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql'))
  assert.ok(predeploy.includes('20260722040000_leaderboard_acquisition_manifest_v3_compat.sql'))
  assert.ok(predeploy.includes('20260722041000_pure_arena_score_v4_scorer.sql'))
  assert.ok(predeploy.includes('20260722042000_leaderboard_terminal_publication_fence.sql'))
  assert.ok(predeploy.includes('20260722050000_metric_trust_attempt_outcome_authority.sql'))
  assert.ok(predeploy.includes('20260722051000_leaderboard_score_input_manifest_contract.sql'))
  assert.ok(!postdeploy.includes('20260718183000_atomic_stripe_entitlement_identity.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260717120000_trader_follows_composite_identity.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260718183000_atomic_stripe_entitlement_identity.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260718183500_harden_stripe_entitlement_null_validation.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260718184000_arena_score_inputs_board_as_of.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260718184500_classify_non_entitlement_stripe_payments.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260718184550_durable_tip_completion_notification.sql')
  )
  assert.ok(!recoveryPrerequisites.includes('20260721120000_metric_trust_shadow_gate.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260721130000_raw_object_gc_outbox.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260721140000_idempotent_equivalent_refund_events.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260721150000_metric_trust_raw_artifact_identity.sql')
  )
  assert.ok(!recoveryPrerequisites.includes('20260721175746_arena_score_inputs_publish_bundle.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260721210000_tip_checkout_lifecycle_atomic.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260721211000_tip_checkout_completion_identity.sql'))
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260722040000_leaderboard_acquisition_manifest_v3_compat.sql')
  )
  assert.ok(!recoveryPrerequisites.includes('20260722041000_pure_arena_score_v4_scorer.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260722042000_leaderboard_terminal_publication_fence.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260722050000_metric_trust_attempt_outcome_authority.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260722051000_leaderboard_score_input_manifest_contract.sql')
  )
})

test('runner records exact file bodies and hashes in the same transaction', () => {
  assert.ok(source.includes('ARRAY[\\$$tag\\$'))
  assert.match(source, /shasum -a 256/)
  assert.match(source, /created_by, idempotency_key/)
  assert.match(source, /perl -0pe '' "\$file"/)
  assert.match(source, /migration ledger version already exists/)
  assert.match(source, /SET LOCAL search_path TO DEFAULT/)
})

test('transactional body stripping survives documentation after COMMIT', () => {
  assert.ok(source.includes('s/(^|\\n)COMMIT;(?:\\n|\\z)/$1/'))
  assert.ok(source.includes('s/(^|\\n)SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\\n/$1/'))

  for (const migration of [
    ...migrationArray('PREDEPLOY_MIGRATIONS'),
    ...migrationArray('POSTDEPLOY_MIGRATIONS'),
    ...migrationArray('RECOVERY_MIGRATIONS'),
  ]) {
    const body = readFileSync(resolve(ROOT, 'supabase/migrations', migration), 'utf8')
    const stripped = body
      .replace(/(^|\n)BEGIN;\n/, '$1')
      .replace(/(^|\n)SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\n/, '$1')
      .replace(/(^|\n)COMMIT;(?:\n|$)/, '$1')
    assert.doesNotMatch(
      stripped,
      /^BEGIN;$|^COMMIT;$|^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$/m,
      migration
    )
  }
})

test('repeatable-read migrations promote isolation to the outer transaction', () => {
  const shadowMigration = '20260718123000_shadow_sources_without_roi_basis.sql'
  const shadowBody = readFileSync(resolve(ROOT, 'supabase/migrations', shadowMigration), 'utf8')

  assert.match(shadowBody, /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$/m)
  assert.match(source, /transaction_begin_for_migrations/)
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ;/)
  assert.match(source, /migration has an unsupported transaction mode/)
  assert.match(
    source,
    /emit_all_dry_run[\s\S]*transaction_begin_for_migrations[\s\S]*PREDEPLOY_MIGRATIONS/
  )
})

test('diagnostic transactions remain exact-ledger resumable while legacy writes stay disabled', () => {
  assert.match(source, /emit_pending_migration/)
  assert.match(source, /SKIP exact ledger/)
  assert.match(source, /refusing drifted ledger/)
  assert.match(
    source,
    /emit_pending_migration\(\)[\s\S]*SKIP exact ledger[\s\S]*emit_ledger_exact_preflight "\$migration"/
  )
  assert.match(source, /apply-predeploy\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/)
  assert.match(source, /apply-postdeploy\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/)
  assert.match(source, /echo "\$phase requires exact ledger: \$migration \(\$state\)"/)
})

test('transactional exact-ledger checks re-attest and lock every skipped prerequisite', () => {
  assert.match(
    source,
    /emit_ledger_exact_preflight\(\)[\s\S]*ledger\.name = '\$name'[\s\S]*ledger\.created_by = 'codex'/
  )
  assert.match(
    source,
    /emit_ledger_exact_preflight\(\)[\s\S]*ledger\.idempotency_key = 'codex:\$version:\$hash'/
  )
  assert.match(
    source,
    /emit_ledger_exact_preflight\(\)[\s\S]*extensions\.digest\(ledger\.statements\[1\], 'sha256'\)/
  )
  assert.match(source, /emit_ledger_exact_preflight\(\)[\s\S]*FOR SHARE;/)
  assert.match(
    source,
    /emit_predeploy_ledger_requirement\(\)[\s\S]*emit_ledger_exact_preflight "\$migration" 'postdeploy'/
  )
  assert.match(
    source,
    /emit_cutover_ledger_requirement\(\)[\s\S]*emit_ledger_exact_preflight "\$migration" 'recovery'/
  )
})

test('candidate production write requires governance plus artifact-bound confirmations', () => {
  assert.match(
    source,
    /require_session_connection\(\)[\s\S]*psql-from-database-url\.mjs"[\s\S]*--check-session-connection/
  )
  assert.match(source, /if \[\[ "\$command" != "status" \]\]/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "\$confirmation"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_BODY_SHA256:-}" != "\$body_sha"/)
  assert.match(source, /ARENA_PRODUCTION_RELEASE_SHA:-}" != "\$head_sha"/)
  assert.match(source, /ARENA_PRODUCTION_PROJECT_REF:-}" != "\$PRODUCTION_PROJECT_REF"/)
  assert.match(source, /ORDERED_PSQL_CHANNEL_APPROVAL='ADR_023_FUTURE_ADDENDUM_/)
  assert.match(source, /ARENA_ORDERED_PSQL_CHANNEL_APPROVAL:-}" !=/)
  assert.match(source, /candidate is dormant pending an ADR-023 addendum/)
  assert.match(
    source,
    /ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM:-}" !=[\s\\]*"\$TIP_CHECKOUT_CUTOVER_ATTESTATION"/
  )
  assert.match(source, /TIP_CHECKOUT_FROZEN_PENDING_ZERO/)
  assert.match(
    source,
    /apply-predeploy-one\)[\s\S]*require_ordered_psql_channel_approval[\s\S]*require_tip_checkout_cutover_for_target "\$migration"[\s\S]*emit_ordered_predeploy_transaction 'COMMIT'/
  )
  for (const command of [
    'apply-predeploy',
    'apply-postdeploy',
    'apply-recovery',
    'apply-concurrent-recovery',
  ]) {
    assert.match(
      source,
      new RegExp(`${command.replaceAll('-', '\\-')}\\)[\\s\\S]*disabled by ADR-023`)
    )
  }
  assert.match(source, /dry-run-all[\s\S]*emit_all_dry_run/)
  assert.match(source, /dry-run-recovery[\s\S]*emit_cutover_ledger_requirement/)
  assert.match(source, /printf '%s\\n' 'ROLLBACK;'/)
  assert.match(source, /emit_ledger_exact_preflight "\$migration" 'postdeploy'/)
  assert.match(source, /emit_ledger_exact_preflight "\$migration" 'recovery'/)
})

test('single predeploy is ordered, provenance-bound and serialized before BEGIN', () => {
  assert.match(
    source,
    /require_predeploy_target\(\)[\s\S]*PREDEPLOY_MIGRATIONS\[@\][\s\S]*not in the ordered candidate manifest/
  )
  assert.doesNotMatch(source, /INDEPENDENT_PREDEPLOY_MIGRATIONS/)
  assert.match(source, /git -C "\$ROOT" ls-files --error-unmatch/)
  assert.match(source, /status --porcelain=v1 --untracked-files=all/)
  assert.match(source, /ls-remote --exit-code origin refs\/heads\/main/)
  assert.match(source, /rev-parse --verify HEAD/)
  assert.match(source, /rev-parse --verify refs\/remotes\/origin\/main/)
  assert.match(source, /PRODUCTION_PROJECT_REF='iknktzifjdyujdccyhsv'/)
  assert.match(source, /aws-0-us-west-2\.pooler\.supabase\.com/)
  assert.match(source, /sslModes\.length === 1 && sslModes\[0\] === 'verify-full'/)
  assert.match(
    source,
    /prepare_ordered_predeploy_target\(\)[\s\S]*ledger_state[\s\S]*first missing migration/
  )
  assert.match(
    source,
    /emit_ordered_predeploy_transaction\(\)[\s\S]*pg_advisory_lock[\s\S]*"\$begin_statement"[\s\S]*LOCK TABLE supabase_migrations\.schema_migrations[\s\S]*IN SHARE ROW EXCLUSIVE MODE[\s\S]*emit_ledger_exact_preflight[\s\S]*emit_migration "\$target"/
  )
  assert.match(
    source,
    /dry-run-predeploy-one\)[\s\S]*prepare_ordered_predeploy_target "\$migration"[\s\S]*emit_ordered_predeploy_transaction 'ROLLBACK' "\$migration"/
  )
  assert.match(
    source,
    /apply-predeploy-one\)[\s\S]*require_ordered_psql_channel_approval[\s\S]*require_single_predeploy_confirmation "\$migration"[\s\S]*prepare_ordered_predeploy_target "\$migration"[\s\S]*emit_ordered_predeploy_transaction 'COMMIT' "\$migration"/
  )
  assert.match(source, /IF NOT pg_catalog\.pg_advisory_unlock/)
  assert.match(source, /ordered predeploy advisory unlock failed/)
  assert.match(source, /BASH_SOURCE\[0\].*==.*\$0/)
  const applyCase = /apply-predeploy-one\)([\s\S]*?)\n\s*;;/.exec(source)?.[1]
  assert.ok(applyCase)
  assert.doesNotMatch(applyCase, /psql_with_database/)
})

test('production endpoint allowlist requires the exact project session URL and verified TLS', () => {
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const invoke = (databaseUrl) =>
    spawnSync('bash', ['-c', 'source "$1"; require_production_project_ref', 'bash', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })
  const project = 'iknktzifjdyujdccyhsv'
  const direct =
    `postgresql://postgres:allowlist-secret@db.${project}.supabase.co:5432/postgres` +
    '?sslmode=verify-full'
  const pooler =
    `postgresql://postgres.${project}:allowlist-secret@` +
    'aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full'

  for (const accepted of [direct, pooler]) {
    const result = invoke(accepted)
    assert.equal(result.status, 0, result.stderr)
  }

  for (const rejected of [
    direct.replace('?sslmode=verify-full', ''),
    direct.replace('verify-full', 'require'),
    direct.replace('verify-full', 'verify-ca'),
    `${direct}&sslmode=verify-full`,
    direct.replace(':5432/', '/'),
    direct.replace(`db.${project}`, 'db.wrongprojectref.supabase.co'),
    direct.replace('postgres:allowlist-secret', `postgres.${project}:allowlist-secret`),
    direct.replace('/postgres?', '/arena?'),
    direct.replace(':5432/', ':6543/'),
    pooler.replace('aws-0-us-west-2', 'aws-0-us-west-1'),
    pooler.replace(`postgres.${project}:`, 'postgres:'),
    pooler.replace(`postgres.${project}:`, `postgres.${project}.extra:`),
    pooler.replace('aws-0-us-west-2.pooler.supabase.com', 'evil.pooler.supabase.com'),
  ]) {
    const result = invoke(rejected)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires the exact production session endpoint/)
    assert.doesNotMatch(result.stderr, /allowlist-secret|postgresql:|supabase\.com/)
  }
})

test('single predeploy dry-run and apply execute the first missing target only', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-single-predeploy-'))
  const fakePsql = resolve(directory, 'psql')
  const sqlPath = resolve(directory, 'sql')
  const callsPath = resolve(directory, 'psql-calls')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const target = '20260718123000_shadow_sources_without_roi_basis.sql'
  const version = '20260718123000'
  const bodySha = migrationBodySha(target)
  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(
      fakePsql,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"',
        'if [[ " $* " == *" -Atc "* ]]; then',
        '  if [[ -n "${FAKE_LEDGER_DRIFT_VERSION:-}" && "$*" == *"ledger.version = \'$FAKE_LEDGER_DRIFT_VERSION\'"* ]]; then',
        "    printf '%s\\n' drift",
        '  elif [[ -n "${FAKE_LEDGER_MISSING_VERSION:-}" && "$*" == *"ledger.version = \'$FAKE_LEDGER_MISSING_VERSION\'"* ]]; then',
        "    printf '%s\\n' missing",
        '  else',
        "    printf '%s\\n' exact",
        '  fi',
        '  exit 0',
        'fi',
        'cat > "$FAKE_PSQL_STREAM"',
        '',
      ].join('\n')
    )
    chmodSync(fakePsql, 0o755)
    const cleanEnvironment = { ...process.env }
    for (const name of [
      'ARENA_PRODUCTION_MIGRATION_CONFIRM',
      'ARENA_PRODUCTION_MIGRATION_BODY_SHA256',
      'ARENA_PRODUCTION_RELEASE_SHA',
      'ARENA_PRODUCTION_PROJECT_REF',
      'ARENA_ORDERED_PSQL_CHANNEL_APPROVAL',
      'ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM',
    ]) {
      delete cleanEnvironment[name]
    }
    const baseOptions = {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...cleanEnvironment,
        ...cleanReleaseEnvironment(directory),
        DATABASE_URL:
          'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full',
        FAKE_LEDGER_MISSING_VERSION: version,
        FAKE_PSQL_CALLS: callsPath,
        FAKE_PSQL_STREAM: sqlPath,
      },
    }
    const resetEvidence = () => {
      rmSync(callsPath, { force: true })
      rmSync(sqlPath, { force: true })
    }

    const dryRun = spawnSync('bash', [script, 'dry-run-predeploy-one', target], baseOptions)
    assert.equal(dryRun.status, 0, dryRun.stderr)
    const dryRunSql = readFileSync(sqlPath, 'utf8')
    assert.match(dryRunSql, /\\echo APPLY 20260718123000_shadow_sources_without_roi_basis\.sql/)
    assert.equal(dryRunSql.match(/^\\echo APPLY /gm)?.length, 1)
    assert.match(dryRunSql, /^BEGIN ISOLATION LEVEL REPEATABLE READ;$/m)
    assert.match(dryRunSql, /ordered predeploy requires exact ledger/)
    assert.match(dryRunSql, /migration ledger version already exists: 20260718123000/)
    assert.match(dryRunSql, new RegExp(`codex:${version}:${bodySha}`))
    const advisory = dryRunSql.indexOf('pg_advisory_lock')
    const sessionLockTimeout = dryRunSql.indexOf("SET lock_timeout = '10s';")
    const sessionStatementTimeout = dryRunSql.indexOf("SET statement_timeout = '15min';")
    const begin = dryRunSql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ;')
    const localLockTimeout = dryRunSql.indexOf("SET LOCAL lock_timeout = '10s';")
    const localStatementTimeout = dryRunSql.indexOf("SET LOCAL statement_timeout = '15min';")
    const localIdleTimeout = dryRunSql.indexOf(
      "SET LOCAL idle_in_transaction_session_timeout = '60s';"
    )
    const tableLock = dryRunSql.indexOf('LOCK TABLE supabase_migrations.schema_migrations')
    const prefixCheck = dryRunSql.indexOf('ordered predeploy requires exact ledger')
    const applyBody = dryRunSql.indexOf(`\\echo APPLY ${target}`)
    const rollback = dryRunSql.lastIndexOf('ROLLBACK;')
    const unlock = dryRunSql.lastIndexOf('pg_advisory_unlock')
    assert.match(dryRunSql, /IF NOT pg_catalog\.pg_advisory_unlock/)
    assert.match(dryRunSql, /ordered predeploy advisory unlock failed/)
    assert.ok(sessionLockTimeout < sessionStatementTimeout)
    assert.ok(sessionStatementTimeout < advisory)
    assert.ok(advisory < begin)
    assert.ok(begin < localLockTimeout)
    assert.ok(localLockTimeout < localStatementTimeout)
    assert.ok(localStatementTimeout < localIdleTimeout)
    assert.ok(localIdleTimeout < tableLock)
    assert.ok(begin < tableLock)
    assert.ok(tableLock < prefixCheck)
    assert.ok(prefixCheck < applyBody)
    assert.ok(applyBody < rollback)
    assert.ok(rollback < unlock)

    resetEvidence()
    const apply = spawnSync('bash', [script, 'apply-predeploy-one', target], {
      ...baseOptions,
      env: {
        ...baseOptions.env,
        ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
        ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
        ARENA_PRODUCTION_RELEASE_SHA: baseOptions.env.FAKE_GIT_HEAD,
        ARENA_PRODUCTION_PROJECT_REF: 'iknktzifjdyujdccyhsv',
        ARENA_ORDERED_PSQL_CHANNEL_APPROVAL: 'ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED',
      },
    })
    assert.equal(apply.status, 0, apply.stderr)
    const applySql = readFileSync(sqlPath, 'utf8')
    assert.equal(applySql.match(/^\\echo APPLY /gm)?.length, 1)
    assert.ok(applySql.indexOf('COMMIT;') < applySql.lastIndexOf('pg_advisory_unlock'))

    resetEvidence()
    const dormant = spawnSync('bash', [script, 'apply-predeploy-one', target], {
      ...baseOptions,
      env: {
        ...baseOptions.env,
        ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
        ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
        ARENA_PRODUCTION_RELEASE_SHA: baseOptions.env.FAKE_GIT_HEAD,
        ARENA_PRODUCTION_PROJECT_REF: 'iknktzifjdyujdccyhsv',
      },
    })
    assert.equal(dormant.status, 1)
    assert.match(dormant.stderr, /candidate is dormant pending an ADR-023 addendum/)
    assert.equal(existsSync(callsPath), false)
    assert.equal(existsSync(sqlPath), false)

    resetEvidence()
    const unapprovedLiteral = spawnSync('bash', [script, 'apply-predeploy-one', target], {
      ...baseOptions,
      env: {
        ...baseOptions.env,
        ARENA_ORDERED_PSQL_CHANNEL_APPROVAL: 'ADR_023_NOT_APPROVED',
      },
    })
    assert.equal(unapprovedLiteral.status, 1)
    assert.match(unapprovedLiteral.stderr, /candidate is dormant pending an ADR-023 addendum/)
    assert.equal(existsSync(callsPath), false)
    assert.equal(existsSync(sqlPath), false)

    for (const [environment, message] of [
      [{}, /APPLY_PREDEPLOY_ONE_20260718123000/],
      [
        { ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}` },
        new RegExp(`ARENA_PRODUCTION_MIGRATION_BODY_SHA256=${bodySha}`),
      ],
      [
        {
          ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
          ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
        },
        new RegExp(`ARENA_PRODUCTION_RELEASE_SHA=${baseOptions.env.FAKE_GIT_HEAD}`),
      ],
      [
        {
          ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
          ARENA_PRODUCTION_MIGRATION_BODY_SHA256: '0'.repeat(64),
          ARENA_PRODUCTION_RELEASE_SHA: baseOptions.env.FAKE_GIT_HEAD,
        },
        new RegExp(`ARENA_PRODUCTION_MIGRATION_BODY_SHA256=${bodySha}`),
      ],
      [
        {
          ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
          ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
          ARENA_PRODUCTION_RELEASE_SHA: baseOptions.env.FAKE_GIT_HEAD,
        },
        /ARENA_PRODUCTION_PROJECT_REF=iknktzifjdyujdccyhsv/,
      ],
      [
        {
          ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
          ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
          ARENA_PRODUCTION_RELEASE_SHA: baseOptions.env.FAKE_GIT_HEAD,
          ARENA_PRODUCTION_PROJECT_REF: 'wrong-project',
        },
        /ARENA_PRODUCTION_PROJECT_REF=iknktzifjdyujdccyhsv/,
      ],
      [
        {
          ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${version}`,
          ARENA_PRODUCTION_MIGRATION_BODY_SHA256: bodySha,
          ARENA_PRODUCTION_RELEASE_SHA: '2'.repeat(40),
          ARENA_PRODUCTION_PROJECT_REF: 'iknktzifjdyujdccyhsv',
        },
        new RegExp(`ARENA_PRODUCTION_RELEASE_SHA=${baseOptions.env.FAKE_GIT_HEAD}`),
      ],
    ]) {
      resetEvidence()
      const rejected = spawnSync('bash', [script, 'apply-predeploy-one', target], {
        ...baseOptions,
        env: {
          ...baseOptions.env,
          ARENA_ORDERED_PSQL_CHANNEL_APPROVAL: 'ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED',
          ...environment,
        },
      })
      assert.equal(rejected.status, 1)
      assert.match(rejected.stderr, message)
      assert.equal(existsSync(callsPath), false)
      assert.equal(existsSync(sqlPath), false)
    }

    resetEvidence()
    const earlierMissing = spawnSync('bash', [script, 'dry-run-predeploy-one', target], {
      ...baseOptions,
      env: { ...baseOptions.env, FAKE_LEDGER_MISSING_VERSION: '20260718120000' },
    })
    assert.equal(earlierMissing.status, 1)
    assert.match(earlierMissing.stderr, /requested .*18123000.*first missing .*18120000/)
    assert.equal(existsSync(sqlPath), false)

    resetEvidence()
    const earlierDrift = spawnSync('bash', [script, 'dry-run-predeploy-one', target], {
      ...baseOptions,
      env: {
        ...baseOptions.env,
        FAKE_LEDGER_MISSING_VERSION: version,
        FAKE_LEDGER_DRIFT_VERSION: '20260718120000',
      },
    })
    assert.equal(earlierDrift.status, 1)
    assert.match(earlierDrift.stderr, /refusing drifted predeploy ledger before target/)
    assert.equal(existsSync(sqlPath), false)

    resetEvidence()
    const targetAlreadyExact = spawnSync('bash', [script, 'dry-run-predeploy-one', target], {
      ...baseOptions,
      env: { ...baseOptions.env, FAKE_LEDGER_MISSING_VERSION: '20260718130000' },
    })
    assert.equal(targetAlreadyExact.status, 1)
    assert.match(targetAlreadyExact.stderr, /requested .*18123000.*first missing .*18130000/)
    assert.equal(existsSync(sqlPath), false)

    resetEvidence()
    const nothingPending = spawnSync('bash', [script, 'dry-run-predeploy-one', target], {
      ...baseOptions,
      env: { ...baseOptions.env, FAKE_LEDGER_MISSING_VERSION: '99999999999999' },
    })
    assert.equal(nothingPending.status, 1)
    assert.match(nothingPending.stderr, /manifest has no missing migration/)
    assert.equal(existsSync(sqlPath), false)

    const outsideManifest = spawnSync(
      'bash',
      [script, 'dry-run-predeploy-one', '20260721000000_not_a_manifest_migration.sql'],
      baseOptions
    )
    assert.equal(outsideManifest.status, 2)
    assert.match(outsideManifest.stderr, /not in the ordered candidate manifest/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('single predeploy rejects untrusted release provenance before ledger reads', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-single-provenance-'))
  const fakePsql = resolve(directory, 'psql')
  const callsPath = resolve(directory, 'psql-calls')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const target = '20260716111600_atomic_group_application_review.sql'
  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(fakePsql, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"\n')
    chmodSync(fakePsql, 0o755)
    const baseOptions = {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...cleanReleaseEnvironment(directory),
        DATABASE_URL:
          'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full',
        FAKE_PSQL_CALLS: callsPath,
      },
    }
    const cases = [
      [{ FAKE_GIT_TRACKED: 'false' }, /must be tracked by git/, 1],
      [{ FAKE_GIT_DIRTY: ' M changed.sql' }, /requires a clean worktree/, 1],
      [{ FAKE_GIT_DIRTY: '?? untracked.sql' }, /requires a clean worktree/, 1],
      [{ FAKE_GIT_ORIGIN_MAIN: 'different-sha' }, /HEAD to equal the pushed origin\/main SHA/, 1],
      [
        { FAKE_GIT_LIVE_MAIN: '2222222222222222222222222222222222222222' },
        /HEAD to equal the live pushed origin\/main SHA/,
        1,
      ],
      [{ FAKE_GIT_REMOTE_AVAILABLE: 'false' }, /could not verify the live origin\/main SHA/, 1],
      [
        { DATABASE_URL: 'postgresql://runner:secret@db.example.test:5432/arena' },
        /requires the exact production session endpoint/,
        1,
      ],
      [
        {
          DATABASE_URL:
            'https://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full',
        },
        /psql connection configuration error/,
        2,
      ],
      [
        {
          DATABASE_URL:
            'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/arena?sslmode=verify-full',
        },
        /requires the exact production session endpoint/,
        1,
      ],
      [
        {
          DATABASE_URL:
            'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=verify-full',
        },
        /refuses transaction-pooler port 6543/,
        2,
      ],
    ]
    for (const [environment, message, status] of cases) {
      rmSync(callsPath, { force: true })
      const result = spawnSync('bash', [script, 'dry-run-predeploy-one', target], {
        ...baseOptions,
        env: { ...baseOptions.env, ...environment },
      })
      assert.equal(result.status, status, result.stderr)
      assert.match(result.stderr, message)
      assert.equal(existsSync(callsPath), false)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Tip freeze is required only when the selected ordered target is protected', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-tip-checkout-cutover-'))
  const fakePsql = resolve(directory, 'psql')
  const callsPath = resolve(directory, 'psql-calls')
  const sqlPath = resolve(directory, 'sql')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const lifecycle = '20260721210000_tip_checkout_lifecycle_atomic.sql'
  const afterTip = '20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql'
  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(
      fakePsql,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"',
        'if [[ " $* " == *" -Atc "* ]]; then',
        '  if [[ "$*" == *"ledger.version = \'$FAKE_LEDGER_MISSING_VERSION\'"* ]]; then',
        "    printf '%s\\n' missing",
        '  else',
        "    printf '%s\\n' exact",
        '  fi',
        '  exit 0',
        'fi',
        'cat > "$FAKE_PSQL_STREAM"',
        '',
      ].join('\n')
    )
    chmodSync(fakePsql, 0o755)
    const inheritedEnvironment = { ...process.env }
    delete inheritedEnvironment.ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM
    const baseEnvironment = {
      ...inheritedEnvironment,
      ...cleanReleaseEnvironment(directory),
      DATABASE_URL:
        'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full',
      FAKE_PSQL_CALLS: callsPath,
      FAKE_PSQL_STREAM: sqlPath,
    }
    const confirmedEnvironment = (migration) => ({
      ...baseEnvironment,
      ARENA_PRODUCTION_MIGRATION_CONFIRM: `APPLY_PREDEPLOY_ONE_${migration.split('_')[0]}`,
      ARENA_PRODUCTION_MIGRATION_BODY_SHA256: migrationBodySha(migration),
      ARENA_PRODUCTION_RELEASE_SHA: baseEnvironment.FAKE_GIT_HEAD,
      ARENA_PRODUCTION_PROJECT_REF: 'iknktzifjdyujdccyhsv',
      ARENA_ORDERED_PSQL_CHANNEL_APPROVAL: 'ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED',
      FAKE_LEDGER_MISSING_VERSION: migration.split('_')[0],
    })
    const resetEvidence = () => {
      rmSync(callsPath, { force: true })
      rmSync(sqlPath, { force: true })
    }

    resetEvidence()
    const blocked = spawnSync('bash', [script, 'apply-predeploy-one', lifecycle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: confirmedEnvironment(lifecycle),
    })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /freeze the old Tip checkout route/)
    assert.equal(existsSync(callsPath), false)

    resetEvidence()
    const lifecycleApply = spawnSync('bash', [script, 'apply-predeploy-one', lifecycle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...confirmedEnvironment(lifecycle),
        ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM: 'TIP_CHECKOUT_FROZEN_PENDING_ZERO',
      },
    })
    assert.equal(lifecycleApply.status, 0, lifecycleApply.stderr)
    assert.match(readFileSync(sqlPath, 'utf8'), /\\echo APPLY 20260721210000_/)

    resetEvidence()
    const afterTipApply = spawnSync('bash', [script, 'apply-predeploy-one', afterTip], {
      cwd: ROOT,
      encoding: 'utf8',
      env: confirmedEnvironment(afterTip),
    })
    assert.equal(afterTipApply.status, 0, afterTipApply.stderr)
    assert.match(readFileSync(sqlPath, 'utf8'), /\\echo APPLY 20260722030000_/)

    for (const command of [
      'apply-predeploy',
      'apply-postdeploy',
      'apply-recovery',
      'apply-concurrent-recovery',
    ]) {
      resetEvidence()
      const disabled = spawnSync('bash', [script, command], {
        cwd: ROOT,
        encoding: 'utf8',
        env: baseEnvironment,
      })
      assert.equal(disabled.status, 2)
      assert.match(disabled.stderr, /disabled by ADR-023/)
      assert.equal(existsSync(callsPath), false)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps the database credential out of psql process arguments', () => {
  assert.match(source, /psql_with_database\(\)[\s\S]*psql-from-database-url\.mjs" "\$@"/)
  assert.doesNotMatch(source, /psql\s+"\$DATABASE_URL"/)
  assert.equal(source.match(/\bpsql_with_database\b/g)?.length, 4)

  const directory = mkdtempSync(resolve(tmpdir(), 'arena-migration-psql-'))
  try {
    const fakePsql = resolve(directory, 'psql')
    const argsPath = resolve(directory, 'args')
    const environmentPath = resolve(directory, 'environment')
    writeFileSync(
      fakePsql,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$@" > "$FAKE_PSQL_ARGS"',
        'printf "%s\\n" \\',
        '  "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$PGPASSWORD" \\',
        '  "$PGSSLMODE" "$PGAPPNAME" "${DATABASE_URL-unset}" \\',
        '  "${PGSERVICE-unset}" "${PGPASSFILE-unset}" "${PGHOSTADDR-unset}" \\',
        '  > "$FAKE_PSQL_ENVIRONMENT"',
        'cat >/dev/null',
        '',
      ].join('\n')
    )
    chmodSync(fakePsql, 0o755)
    const databaseUrl =
      'postgresql://runner%40team:argv%2Dsecret@db.example.test:5433/' +
      'arena%2Dprod?application_name=launch%20runner'
    const result = spawnSync(
      'bash',
      [resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh'), 'status'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          DATABASE_URL: databaseUrl,
          FAKE_PSQL_ARGS: argsPath,
          FAKE_PSQL_ENVIRONMENT: environmentPath,
          PGSERVICE: 'must-not-survive',
          PGPASSFILE: '/must/not/survive',
          PGHOSTADDR: '192.0.2.1',
        },
      }
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(environmentPath, 'utf8').trimEnd().split('\n'), [
      'db.example.test',
      '5433',
      'arena-prod',
      'runner@team',
      'argv-secret',
      'require',
      'launch runner',
      'unset',
      'unset',
      'unset',
      'unset',
    ])
    assert.doesNotMatch(readFileSync(argsPath, 'utf8'), /argv-secret|postgresql:\/\//)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('database URL parser fails closed on unsupported or duplicate libpq options', () => {
  const helper = resolve(ROOT, 'scripts/maintenance/psql-from-database-url.mjs')
  for (const databaseUrl of [
    'postgresql://runner:secret@db.example.test:5432/arena?unknown=value',
    'postgresql://runner:secret@db.example.test:5432/arena?sslmode=require&sslmode=verify-full',
  ]) {
    const result = spawnSync(process.execPath, [helper, '--version'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /psql connection configuration error/)
    assert.doesNotMatch(result.stderr, /runner|secret|db\.example|postgresql/)
  }
})

test('session-pooler guard is bound to the parsed URL and ignores ambient libpq values', () => {
  const helper = resolve(ROOT, 'scripts/maintenance/psql-from-database-url.mjs')
  const result = spawnSync(process.execPath, [helper, '--check-session-connection'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://runner:secret@db.example.test:6543/arena',
      PGPORT: '5432',
      PGSERVICE: 'bypass-attempt',
    },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /refuses transaction-pooler port 6543/)
  assert.doesNotMatch(result.stderr, /runner|secret|db\.example|postgresql/)

  const accepted = spawnSync(process.execPath, [helper, '--check-session-connection'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://runner:secret@db.example.test:5432/arena',
      PGPORT: '6543',
    },
  })
  assert.equal(accepted.status, 0, accepted.stderr)
})

test('legacy schema write commands stay disabled pending channel governance', () => {
  assert.match(source, /validate_concurrent_migration_file/)
  assert.match(source, /CREATE INDEX CONCURRENTLY/)
  assert.match(source, /dry-run-recovery[\s\S]*ledger_state[\s\S]*ROLLBACK/)
  assert.match(source, /apply-concurrent-recovery\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/)
  assert.match(source, /apply-postdeploy\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/)
  assert.match(source, /apply-recovery\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/)
})

test('status makes the intentionally superseded migration explicit', () => {
  assert.match(source, /phase in predeploy postdeploy concurrent-recovery recovery superseded/)
  assert.match(source, /superseded-by-20260717230000/)
  assert.match(source, /missing-superseder/)
  assert.match(source, /THEN 'exact'/)
  assert.match(source, /ELSE 'drift'/)
})
