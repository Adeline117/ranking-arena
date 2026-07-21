import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('predeploy, postdeploy and recovery phases are exact, unique and ordered', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const independentPredeploy = migrationArray('INDEPENDENT_PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const recoveryPrerequisites = migrationArray('RECOVERY_PREREQUISITE_MIGRATIONS')
  const concurrentRecovery = migrationArray('CONCURRENT_RECOVERY_MIGRATIONS')
  const recovery = migrationArray('RECOVERY_MIGRATIONS')
  const superseded = migrationArray('SUPERSEDED_MIGRATIONS')
  const all = [...predeploy, ...postdeploy, ...concurrentRecovery, ...recovery, ...superseded]

  assert.equal(predeploy.length, 61)
  assert.deepEqual(independentPredeploy, ['20260721140000_idempotent_equivalent_refund_events.sql'])
  assert.ok(independentPredeploy.every((migration) => predeploy.includes(migration)))
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
  assert.equal(new Set(all).size, 72)
  assert.equal(predeploy[0], '20260716111600_atomic_group_application_review.sql')
  assert.deepEqual(predeploy.slice(-20), [
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

test('predeploy and postdeploy are exact-ledger resumable and fail closed on drift', () => {
  assert.match(source, /emit_pending_migration/)
  assert.match(source, /SKIP exact ledger/)
  assert.match(source, /refusing drifted ledger/)
  assert.match(
    source,
    /emit_pending_migration\(\)[\s\S]*SKIP exact ledger[\s\S]*emit_ledger_exact_preflight "\$migration"/
  )
  assert.match(
    source,
    /apply-predeploy\)[\s\S]*emit_transaction 'COMMIT' "\$\{PREDEPLOY_MIGRATIONS\[@\]\}"/
  )
  assert.match(
    source,
    /apply-postdeploy\)[\s\S]*require_exact_migrations 'postdeploy'[\s\S]*emit_pending_migration/
  )
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

test('production writes require phase-specific confirmations', () => {
  assert.match(
    source,
    /require_session_connection\(\)[\s\S]*psql-from-database-url\.mjs"[\s\S]*--check-session-connection/
  )
  assert.match(source, /if \[\[ "\$command" != "status" \]\]/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_PREDEPLOY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "\$confirmation"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_POSTDEPLOY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_CONCURRENT_RECOVERY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_RECOVERY"/)
  assert.match(source, /dry-run-all[\s\S]*emit_all_dry_run/)
  assert.match(source, /dry-run-recovery[\s\S]*emit_cutover_ledger_requirement/)
  assert.match(source, /printf '%s\\n' 'ROLLBACK;'/)
  assert.match(source, /emit_ledger_exact_preflight "\$migration" 'postdeploy'/)
  assert.match(source, /emit_ledger_exact_preflight "\$migration" 'recovery'/)
})

test('single predeploy runs only an exact audited manifest target', () => {
  assert.match(
    source,
    /require_predeploy_target\(\)[\s\S]*PREDEPLOY_MIGRATIONS\[@\][\s\S]*audited manifest[\s\S]*INDEPENDENT_PREDEPLOY_MIGRATIONS\[@\][\s\S]*approved for an independent apply/
  )
  assert.match(
    source,
    /dry-run-predeploy-one\)[\s\S]*require_predeploy_target "\$migration"[\s\S]*emit_transaction 'ROLLBACK' "\$migration"/
  )
  assert.match(
    source,
    /apply-predeploy-one\)[\s\S]*APPLY_PREDEPLOY_ONE_\$\(migration_version "\$migration"\)[\s\S]*require_predeploy_target "\$migration"[\s\S]*emit_transaction 'COMMIT' "\$migration"/
  )
  const applyCase = /apply-predeploy-one\)([\s\S]*?)\n\s*;;/.exec(source)?.[1]
  assert.ok(applyCase)
  assert.doesNotMatch(applyCase, /psql_with_database/)
})

test('single predeploy dry-run and apply emit only the selected migration', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-single-predeploy-'))
  const fakePsql = resolve(directory, 'psql')
  const sqlPath = resolve(directory, 'sql')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const target = '20260721140000_idempotent_equivalent_refund_events.sql'
  try {
    writeFileSync(
      fakePsql,
      [
        '#!/usr/bin/env bash',
        'if [[ " $* " == *" -Atc "* ]]; then',
        "  printf '%s\\n' missing",
        '  exit 0',
        'fi',
        'cat > "$FAKE_PSQL_STREAM"',
        '',
      ].join('\n')
    )
    chmodSync(fakePsql, 0o755)
    const baseOptions = {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        DATABASE_URL: 'postgresql://runner:secret@db.example.test:5432/arena',
        FAKE_PSQL_STREAM: sqlPath,
      },
    }

    const dryRun = spawnSync('bash', [script, 'dry-run-predeploy-one', target], baseOptions)
    assert.equal(dryRun.status, 0, dryRun.stderr)
    const dryRunSql = readFileSync(sqlPath, 'utf8')
    assert.match(dryRunSql, /\\echo APPLY 20260721140000_idempotent_equivalent_refund_events\.sql/)
    assert.doesNotMatch(dryRunSql, /\\echo APPLY 202607211[23]0000_/)
    assert.match(dryRunSql, /^BEGIN ISOLATION LEVEL REPEATABLE READ;$/m)
    assert.ok(dryRunSql.trimEnd().endsWith('ROLLBACK;'))

    const apply = spawnSync('bash', [script, 'apply-predeploy-one', target], {
      ...baseOptions,
      env: {
        ...baseOptions.env,
        ARENA_PRODUCTION_MIGRATION_CONFIRM: 'APPLY_PREDEPLOY_ONE_20260721140000',
      },
    })
    assert.equal(apply.status, 0, apply.stderr)
    const applySql = readFileSync(sqlPath, 'utf8')
    assert.match(applySql, /\\echo APPLY 20260721140000_idempotent_equivalent_refund_events\.sql/)
    assert.doesNotMatch(applySql, /\\echo APPLY 202607211[23]0000_/)
    assert.ok(applySql.trimEnd().endsWith('COMMIT;'))

    const noConfirmation = spawnSync('bash', [script, 'apply-predeploy-one', target], baseOptions)
    assert.equal(noConfirmation.status, 1)
    assert.match(noConfirmation.stderr, /APPLY_PREDEPLOY_ONE_20260721140000/)

    const outsideManifest = spawnSync(
      'bash',
      [script, 'dry-run-predeploy-one', '20260721000000_not_a_manifest_migration.sql'],
      baseOptions
    )
    assert.equal(outsideManifest.status, 2)
    assert.match(outsideManifest.stderr, /not in the audited manifest/)

    const orderedOnly = spawnSync(
      'bash',
      [script, 'dry-run-predeploy-one', '20260721120000_metric_trust_shadow_gate.sql'],
      baseOptions
    )
    assert.equal(orderedOnly.status, 2)
    assert.match(orderedOnly.stderr, /not approved for an independent apply/)
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

test('concurrent recovery is resumable and never enters a transaction', () => {
  assert.match(source, /validate_concurrent_migration_file/)
  assert.match(source, /CREATE INDEX CONCURRENTLY/)
  assert.match(source, /pg_advisory_lock/)
  assert.match(source, /ledger_state/)
  assert.match(source, /SKIP exact ledger/)
  assert.match(source, /refusing drifted ledger/)
  assert.doesNotMatch(source, /emit_transaction 'COMMIT' "\$\{CONCURRENT_RECOVERY_MIGRATIONS/)
})

test('transactional recovery is resumable and keeps unrelated locks separate', () => {
  assert.match(source, /dry-run-recovery[\s\S]*ledger_state[\s\S]*ROLLBACK/)
  assert.match(
    source,
    /apply-recovery[\s\S]*ledger_state[\s\S]*emit_migration "\$migration"[\s\S]*COMMIT/
  )
  assert.doesNotMatch(source, /emit_transaction 'COMMIT' "\$\{RECOVERY_MIGRATIONS/)
})

test('status makes the intentionally superseded migration explicit', () => {
  assert.match(source, /phase in predeploy postdeploy concurrent-recovery recovery superseded/)
  assert.match(source, /superseded-by-20260717230000/)
  assert.match(source, /missing-superseder/)
  assert.match(source, /THEN 'exact'/)
  assert.match(source, /ELSE 'drift'/)
})
