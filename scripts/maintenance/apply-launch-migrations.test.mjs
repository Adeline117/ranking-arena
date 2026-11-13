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
      'if [[ -n "${FAKE_GIT_CALLS:-}" ]]; then',
      '  printf "%s\\n" "$*" >> "$FAKE_GIT_CALLS"',
      'fi',
      'if [[ "$args" == *" ls-files --error-unmatch -- "* ]]; then',
      '  [[ "${FAKE_GIT_TRACKED:-true}" == "true" ]] || exit 1',
      '  printf "%s\\n" "${*: -1}"',
      'elif [[ "$args" == *" status --porcelain=v1 --untracked-files=all "* ]]; then',
      '  printf "%s" "${FAKE_GIT_DIRTY:-}"',
      'elif [[ "$args" == *" ls-remote --exit-code origin refs/heads/main "* ]]; then',
      '  [[ "${FAKE_GIT_REMOTE_AVAILABLE:-true}" == "true" ]] || exit 2',
      '  printf "%s\\trefs/heads/main\\n" "$FAKE_GIT_LIVE_MAIN"',
      'elif [[ "$args" == *" rev-parse --verify refs/remotes/origin/main "* ]]; then',
      '  printf "%s\\n" "$FAKE_GIT_ORIGIN_MAIN"',
      'elif [[ "$args" == *" rev-parse --verify HEAD "* ]]; then',
      '  printf "%s\\n" "$FAKE_GIT_HEAD"',
      'elif [[ "$args" == *" show "* ]]; then',
      '  object="${*: -1}"',
      '  relative_path="${object#*:}"',
      '  if [[ "$relative_path" == "${FAKE_GIT_TARGET_PATH:-}" && -n "${FAKE_GIT_TARGET_BODY+x}" ]]; then',
      '    printf "%s" "$FAKE_GIT_TARGET_BODY"',
      '  else',
      '    perl -0pe \'\' "$FAKE_GIT_ROOT/$relative_path"',
      '  fi',
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
    FAKE_GIT_DIRTY: '',
    ...overrides,
  }
}

function migrationBodySha(migration) {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, 'supabase/migrations', migration)))
    .digest('hex')
}

test('runner uses baseline grep instead of optional ripgrep', () => {
  assert.doesNotMatch(source, /\brg\s/)
  assert.match(source, /grep -c '\^BEGIN;\$'/)
})

test('concurrent migration validation treats grep counts numerically', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-concurrent-migration-'))
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const validate = (migration) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; MIGRATIONS_DIR="$2"; validate_concurrent_migration_file "$3"',
        'bash',
        script,
        directory,
        migration,
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )

  try {
    writeFileSync(
      resolve(directory, 'valid.sql'),
      'CREATE INDEX CONCURRENTLY idx_valid ON arena.valid_table (id);\n'
    )
    writeFileSync(
      resolve(directory, 'transactional.sql'),
      'BEGIN;\nCREATE INDEX CONCURRENTLY idx_bad ON arena.valid_table (id);\nCOMMIT;\n'
    )
    writeFileSync(resolve(directory, 'missing.sql'), 'SELECT 1;\n')

    const valid = validate('valid.sql')
    assert.equal(valid.status, 0, valid.stderr)
    for (const migration of ['transactional.sql', 'missing.sql']) {
      const rejected = validate(migration)
      assert.equal(rejected.status, 1)
      assert.match(rejected.stderr, /concurrent migration must have CREATE INDEX CONCURRENTLY/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('predeploy, postdeploy and recovery phases are exact, unique and ordered', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const recoveryPrerequisites = migrationArray('RECOVERY_PREREQUISITE_MIGRATIONS')
  const concurrentRecovery = migrationArray('CONCURRENT_RECOVERY_MIGRATIONS')
  const recovery = migrationArray('RECOVERY_MIGRATIONS')
  const quarantined = migrationArray('QUARANTINED_PREDEPLOY_MIGRATIONS')
  const superseded = migrationArray('SUPERSEDED_MIGRATIONS')
  const all = [
    ...predeploy,
    ...postdeploy,
    ...concurrentRecovery,
    ...recovery,
    ...quarantined,
    ...superseded,
  ]

  assert.equal(predeploy.length, 147)
  // Season publication follow-ups stay last; 011058 must follow the Bitget-bot
  // freshness-authority rewrite slot (20261111134416, #415's replacement for 20260728124000).
  assert.deepEqual(predeploy.slice(-6), [
    '20261113010326_release_leaderboard_rank_generation_lease_after_seal.sql',
    '20261113011058_leaderboard_publication_source_isolation.sql',
    '20261113012028_public_snapshot_readers_sealed_freshness.sql',
    '20261113105605_retention_preserves_metric_trust_evidence.sql',
    '20261113110021_leaderboard_snapshot_retention.sql',
    '20261113110430_rank_publication_source_evidence_binding.sql',
  ])
  assert.ok(
    predeploy.indexOf('20261113011058_leaderboard_publication_source_isolation.sql') >
      predeploy.indexOf(
        '20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql'
      )
  )
  assert.deepEqual(postdeploy, [
    '20260716192000_social_edge_write_contract.sql',
    '20260717120000_trader_follows_composite_identity.sql',
    '20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql',
  ])
  assert.equal(recoveryPrerequisites.length, 41)
  // Recovery repairs the frozen 41-migration cutover: every predeploy migration
  // before the 2026-07-17 hero-stats change plus the two notification
  // contracts. Later launch additions must never join it.
  assert.deepEqual(recoveryPrerequisites, [
    ...predeploy.filter(
      (migration) =>
        migration < '20260717130000' ||
        [
          '20260717220000_notification_read_authority.sql',
          '20260717222500_notification_type_contract.sql',
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
  assert.deepEqual(quarantined, ['20260722054000_metric_trust_source_page_lineage.sql'])
  assert.deepEqual(superseded, [
    '20260716104500_collection_read_write_boundaries.sql',
    '20260725017250_normalize_leaderboard_rank_max_drawdown.sql',
    '20260728122000_bitget_bots_canonical_timeframe.sql',
    '20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql',
    '20260729061000_tier_a_execution_claim_enforcement.sql',
    '20260729230000_token_ranking_generation_barrier.sql',
    '20260804043000_retire_legacy_token_rankings.sql',
    '20260804044000_freeze_legacy_position_history_relations.sql',
    '20260804045000_quarantine_bingx_rank_authority.sql',
    '20260808001418_atomic_group_channel_settings_update.sql',
    '20260817020000_rank_history_service_only_acl.sql',
    '20260817030000_trader_activities_publication_fence.sql',
    '20260817040000_notification_ranking_change_reader_fence.sql',
    '20260817050000_arena_bot_legacy_publication_isolation.sql',
    '20260817060000_trader_series_publication_isolation.sql',
    '20260817061000_legacy_raw_metric_publication_isolation.sql',
  ])
  assert.equal(new Set(all).size, 175)
  assert.equal(predeploy[0], '20260716111600_atomic_group_application_review.sql')
  assert.deepEqual(predeploy.slice(-106), [
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
    '20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql',
    '20261111191927_binance_spot_contract_registration_serving_hold.sql',
    '20260722053000_binance_spot_metric_source_contract.sql',
    '20261111191928_binance_spot_contract_registration_serving_restore.sql',
    '20260722055000_metric_trust_source_page_lineage_forward_repair.sql',
    '20260724010000_shadow_unverified_okx_web3_ranks.sql',
    '20260724232500_allow_pipeline_logs_partial_success.sql',
    '20260724234000_optimize_arena_score_inputs_json_hot_path.sql',
    '20260724235000_leaderboard_publication_mutation_fence.sql',
    '20260725011000_durable_ingest_worker_fence_substrate.sql',
    '20260725012000_strengthen_arena_score_publish_evidence.sql',
    '20260725013000_cleanup_leaderboard_rank_publication.sql',
    '20260725014000_strengthen_leaderboard_publication_proof_authority.sql',
    '20260725014500_close_rank_cleanup_public_execute.sql',
    '20260725015000_leaderboard_rank_generation_claim.sql',
    '20260725015500_bound_leaderboard_rank_generation_batches.sql',
    '20260725016000_leaderboard_rank_generation_receipt_substrate.sql',
    '20261111140053_leaderboard_ranks_codec_layout_rebuild.sql',
    '20260725016500_leaderboard_rank_persisted_codec.sql',
    '20260725017000_leaderboard_rank_typed_batch_contract.sql',
    '20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql',
    '20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql',
    '20261111134210_bitget_bots_canonical_timeframe_partial_seed.sql',
    '20260728123000_arena_bot_header_canonical_snapshot.sql',
    '20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql',
    '20260729010000_api_keys_server_authority.sql',
    '20260729011000_leaderboard_rank_manifest_attestation_substrate.sql',
    '20260729012000_partitioned_bot_acquisition_manifest_v4.sql',
    '20260729013000_bitget_bot_attempt_health_contract.sql',
    '20260729014000_bitget_bot_copier_aggregate_authority.sql',
    '20260729014500_leaderboard_rank_generation_canonical_batches.sql',
    '20260729015000_leaderboard_rank_generation_attested_batch_writer.sql',
    '20260729015500_tier_a_execution_claim_fence.sql',
    '20260729054400_leaderboard_rank_generation_private_staging.sql',
    '20260729060000_stale_leaderboard_attempt_report.sql',
    '20260729061533_leaderboard_rank_generation_staging_only_writer.sql',
    '20260729063000_leaderboard_rank_staging_full_xid_guard.sql',
    '20260729064500_leaderboard_rank_generation_publication_plan.sql',
    '20260729065000_normalize_arena_score_input_platform_aliases.sql',
    '20260729070000_pure_arena_score_v5_zero_metric_scorer.sql',
    '20260729070500_leaderboard_score_input_manifest_v2.sql',
    '20260729071000_leaderboard_metric_trust_projection_v2.sql',
    '20260729071500_tier_a_one_phase_commit_guard.sql',
    '20260729223000_rerank_public_eligible_rows_only.sql',
    '20260729224000_rank_eligible_leaderboard_count_cache.sql',
    '20260729225000_token_trader_rank_authority.sql',
    '20261111133259_token_ranking_generation_barrier_cron_api.sql',
    '20261111133300_retire_legacy_token_rankings_cron_api.sql',
    '20261111135144_freeze_legacy_position_history_relations_prod_creator.sql',
    '20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql',
    '20260804050000_harden_serving_trader_resolver.sql',
    '20260804051000_harden_serving_source_capabilities.sql',
    '20260804052000_fail_closed_unbound_copier_aggregates.sql',
    '20260804053000_copier_snapshot_publication_substrate.sql',
    '20260804054000_publish_copier_snapshot_atomically.sql',
    '20260808010000_copier_snapshot_trust_raw_role.sql',
    '20260808020000_copier_snapshot_trust_publication_substrate.sql',
    '20260808021000_publish_copier_snapshot_trust_v2.sql',
    '20260808090000_quarantine_legacy_trader_daily_snapshots.sql',
    '20260816130000_quarantine_v1_trader_alert_browser_mutations.sql',
    '20260816151614_public_ranked_leaderboard.sql',
    '20260816184500_public_ranked_leaderboard_source_freshness_gate.sql',
    '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql',
    '20261111132444_rank_history_service_only_acl_hosted_role_graph.sql',
    '20261111132445_trader_activities_publication_fence_hosted_role_graph.sql',
    '20261111132446_notification_ranking_change_reader_fence_hosted_role_graph.sql',
    '20261111132447_arena_bot_legacy_publication_isolation_hosted_role_graph.sql',
    '20261111132448_trader_series_publication_isolation_hosted_role_graph.sql',
    '20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql',
    '20260817134214_quarantine_legacy_platform_stats_rpc.sql',
    '20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql',
    '20261113010326_release_leaderboard_rank_generation_lease_after_seal.sql',
    '20261113011058_leaderboard_publication_source_isolation.sql',
    '20261113012028_public_snapshot_readers_sealed_freshness.sql',
    '20261113105605_retention_preserves_metric_trust_evidence.sql',
    '20261113110021_leaderboard_snapshot_retention.sql',
    '20261113110430_rank_publication_source_evidence_binding.sql',
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
  assert.ok(
    predeploy.includes('20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql')
  )
  assert.ok(predeploy.includes('20260722053000_binance_spot_metric_source_contract.sql'))
  assert.ok(
    predeploy.includes('20260722055000_metric_trust_source_page_lineage_forward_repair.sql')
  )
  assert.ok(predeploy.includes('20260724010000_shadow_unverified_okx_web3_ranks.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260724010000_shadow_unverified_okx_web3_ranks.sql'))
  assert.ok(predeploy.includes('20260724232500_allow_pipeline_logs_partial_success.sql'))
  assert.ok(predeploy.includes('20260724234000_optimize_arena_score_inputs_json_hot_path.sql'))
  assert.ok(predeploy.includes('20260724235000_leaderboard_publication_mutation_fence.sql'))
  assert.ok(predeploy.includes('20260725011000_durable_ingest_worker_fence_substrate.sql'))
  assert.ok(predeploy.includes('20260725012000_strengthen_arena_score_publish_evidence.sql'))
  assert.ok(predeploy.includes('20260725013000_cleanup_leaderboard_rank_publication.sql'))
  assert.ok(
    predeploy.includes('20260725014000_strengthen_leaderboard_publication_proof_authority.sql')
  )
  assert.ok(predeploy.includes('20260725014500_close_rank_cleanup_public_execute.sql'))
  assert.ok(predeploy.includes('20260725015000_leaderboard_rank_generation_claim.sql'))
  assert.ok(predeploy.includes('20260725015500_bound_leaderboard_rank_generation_batches.sql'))
  assert.ok(predeploy.includes('20260725016000_leaderboard_rank_generation_receipt_substrate.sql'))
  assert.ok(predeploy.includes('20260725016500_leaderboard_rank_persisted_codec.sql'))
  assert.ok(predeploy.includes('20260725017000_leaderboard_rank_typed_batch_contract.sql'))
  assert.ok(!predeploy.includes('20260725017250_normalize_leaderboard_rank_max_drawdown.sql'))
  assert.ok(
    predeploy.includes('20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql')
  )
  assert.ok(!predeploy.includes('20260728122000_bitget_bots_canonical_timeframe.sql'))
  assert.ok(predeploy.includes('20261111134210_bitget_bots_canonical_timeframe_partial_seed.sql'))
  assert.ok(predeploy.includes('20260728123000_arena_bot_header_canonical_snapshot.sql'))
  assert.ok(
    !predeploy.includes('20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql')
  )
  assert.ok(
    predeploy.includes(
      '20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql'
    )
  )
  assert.ok(predeploy.includes('20260729010000_api_keys_server_authority.sql'))
  assert.ok(
    predeploy.includes('20260729011000_leaderboard_rank_manifest_attestation_substrate.sql')
  )
  assert.ok(predeploy.includes('20260729012000_partitioned_bot_acquisition_manifest_v4.sql'))
  assert.ok(predeploy.includes('20260729013000_bitget_bot_attempt_health_contract.sql'))
  assert.ok(predeploy.includes('20260729014000_bitget_bot_copier_aggregate_authority.sql'))
  assert.ok(predeploy.includes('20260729014500_leaderboard_rank_generation_canonical_batches.sql'))
  assert.ok(
    predeploy.includes('20260729015000_leaderboard_rank_generation_attested_batch_writer.sql')
  )
  assert.ok(predeploy.includes('20260729015500_tier_a_execution_claim_fence.sql'))
  assert.ok(predeploy.includes('20260729054400_leaderboard_rank_generation_private_staging.sql'))
  assert.ok(predeploy.includes('20260729060000_stale_leaderboard_attempt_report.sql'))
  assert.ok(!predeploy.includes('20260729061000_tier_a_execution_claim_enforcement.sql'))
  assert.ok(!postdeploy.includes('20260729061000_tier_a_execution_claim_enforcement.sql'))
  assert.ok(superseded.includes('20260729061000_tier_a_execution_claim_enforcement.sql'))
  assert.ok(
    !predeploy.includes('20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql')
  )
  assert.ok(
    predeploy.includes('20260729061533_leaderboard_rank_generation_staging_only_writer.sql')
  )
  assert.ok(predeploy.includes('20260729063000_leaderboard_rank_staging_full_xid_guard.sql'))
  assert.ok(predeploy.includes('20260729064500_leaderboard_rank_generation_publication_plan.sql'))
  assert.ok(predeploy.includes('20260729065000_normalize_arena_score_input_platform_aliases.sql'))
  assert.ok(predeploy.includes('20260729070000_pure_arena_score_v5_zero_metric_scorer.sql'))
  assert.ok(predeploy.includes('20260729070500_leaderboard_score_input_manifest_v2.sql'))
  assert.ok(predeploy.includes('20260729071000_leaderboard_metric_trust_projection_v2.sql'))
  assert.ok(predeploy.includes('20260729071500_tier_a_one_phase_commit_guard.sql'))
  assert.deepEqual(predeploy.slice(-34, -6), [
    '20260729223000_rerank_public_eligible_rows_only.sql',
    '20260729224000_rank_eligible_leaderboard_count_cache.sql',
    '20260729225000_token_trader_rank_authority.sql',
    '20261111133259_token_ranking_generation_barrier_cron_api.sql',
    '20261111133300_retire_legacy_token_rankings_cron_api.sql',
    '20261111135144_freeze_legacy_position_history_relations_prod_creator.sql',
    '20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql',
    '20260804050000_harden_serving_trader_resolver.sql',
    '20260804051000_harden_serving_source_capabilities.sql',
    '20260804052000_fail_closed_unbound_copier_aggregates.sql',
    '20260804053000_copier_snapshot_publication_substrate.sql',
    '20260804054000_publish_copier_snapshot_atomically.sql',
    '20260808010000_copier_snapshot_trust_raw_role.sql',
    '20260808020000_copier_snapshot_trust_publication_substrate.sql',
    '20260808021000_publish_copier_snapshot_trust_v2.sql',
    '20260808090000_quarantine_legacy_trader_daily_snapshots.sql',
    '20260816130000_quarantine_v1_trader_alert_browser_mutations.sql',
    '20260816151614_public_ranked_leaderboard.sql',
    '20260816184500_public_ranked_leaderboard_source_freshness_gate.sql',
    '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql',
    '20261111132444_rank_history_service_only_acl_hosted_role_graph.sql',
    '20261111132445_trader_activities_publication_fence_hosted_role_graph.sql',
    '20261111132446_notification_ranking_change_reader_fence_hosted_role_graph.sql',
    '20261111132447_arena_bot_legacy_publication_isolation_hosted_role_graph.sql',
    '20261111132448_trader_series_publication_isolation_hosted_role_graph.sql',
    '20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql',
    '20260817134214_quarantine_legacy_platform_stats_rpc.sql',
    '20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql',
  ])
  assert.ok(!recoveryPrerequisites.includes('20260729223000_rerank_public_eligible_rows_only.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260729224000_rank_eligible_leaderboard_count_cache.sql')
  )
  assert.ok(!recoveryPrerequisites.includes('20260729225000_token_trader_rank_authority.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260729230000_token_ranking_generation_barrier.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260804043000_retire_legacy_token_rankings.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260804044000_freeze_legacy_position_history_relations.sql')
  )
  assert.ok(!recoveryPrerequisites.includes('20260804045000_quarantine_bingx_rank_authority.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260804050000_harden_serving_trader_resolver.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260804051000_harden_serving_source_capabilities.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260804052000_fail_closed_unbound_copier_aggregates.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260804053000_copier_snapshot_publication_substrate.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260804054000_publish_copier_snapshot_atomically.sql')
  )
  assert.ok(
    predeploy.includes('20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260724232500_allow_pipeline_logs_partial_success.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260724234000_optimize_arena_score_inputs_json_hot_path.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260724235000_leaderboard_publication_mutation_fence.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260725011000_durable_ingest_worker_fence_substrate.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260725012000_strengthen_arena_score_publish_evidence.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260725013000_cleanup_leaderboard_rank_publication.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260725014000_strengthen_leaderboard_publication_proof_authority.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260725014500_close_rank_cleanup_public_execute.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260725015000_leaderboard_rank_generation_claim.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260725015500_bound_leaderboard_rank_generation_batches.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260725016000_leaderboard_rank_generation_receipt_substrate.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260725016500_leaderboard_rank_persisted_codec.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260725017000_leaderboard_rank_typed_batch_contract.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260725017250_normalize_leaderboard_rank_max_drawdown.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260728122000_bitget_bots_canonical_timeframe.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260728123000_arena_bot_header_canonical_snapshot.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260729010000_api_keys_server_authority.sql'))
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729011000_leaderboard_rank_manifest_attestation_substrate.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729012000_partitioned_bot_acquisition_manifest_v4.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729013000_bitget_bot_attempt_health_contract.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729014000_bitget_bot_copier_aggregate_authority.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729014500_leaderboard_rank_generation_canonical_batches.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729015000_leaderboard_rank_generation_attested_batch_writer.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729054400_leaderboard_rank_generation_private_staging.sql'
    )
  )
  assert.ok(!recoveryPrerequisites.includes('20260729015500_tier_a_execution_claim_fence.sql'))
  assert.ok(!recoveryPrerequisites.includes('20260729060000_stale_leaderboard_attempt_report.sql'))
  assert.ok(
    !recoveryPrerequisites.includes('20260729061000_tier_a_execution_claim_enforcement.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729061533_leaderboard_rank_generation_staging_only_writer.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729063000_leaderboard_rank_staging_full_xid_guard.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729064500_leaderboard_rank_generation_publication_plan.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes(
      '20260729065000_normalize_arena_score_input_platform_aliases.sql'
    )
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729070000_pure_arena_score_v5_zero_metric_scorer.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729070500_leaderboard_score_input_manifest_v2.sql')
  )
  assert.ok(
    !recoveryPrerequisites.includes('20260729071000_leaderboard_metric_trust_projection_v2.sql')
  )
  assert.ok(!predeploy.includes('20260722054000_metric_trust_source_page_lineage.sql'))
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
  assert.ok(
    !recoveryPrerequisites.includes('20260722053000_binance_spot_metric_source_contract.sql')
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
  assert.ok(
    source.includes(
      's/(^|\\n)SET TRANSACTION ISOLATION LEVEL (?:REPEATABLE READ|READ COMMITTED);\\n/$1/'
    )
  )

  for (const migration of [
    ...migrationArray('PREDEPLOY_MIGRATIONS'),
    ...migrationArray('POSTDEPLOY_MIGRATIONS'),
    ...migrationArray('RECOVERY_MIGRATIONS'),
  ]) {
    const body = readFileSync(resolve(ROOT, 'supabase/migrations', migration), 'utf8')
    const stripped = body
      .replace(/(^|\n)BEGIN;\n/, '$1')
      .replace(/(^|\n)SET TRANSACTION ISOLATION LEVEL (?:REPEATABLE READ|READ COMMITTED);\n/, '$1')
      .replace(/(^|\n)COMMIT;(?:\n|$)/, '$1')
    assert.doesNotMatch(
      stripped,
      /^BEGIN;$|^COMMIT;$|^SET TRANSACTION ISOLATION LEVEL (?:REPEATABLE READ|READ COMMITTED);$/m,
      migration
    )
  }
})

test('repeatable-read migrations promote isolation to the outer transaction', () => {
  const shadowMigration = '20260718123000_shadow_sources_without_roi_basis.sql'
  const shadowBody = readFileSync(resolve(ROOT, 'supabase/migrations', shadowMigration), 'utf8')

  assert.match(shadowBody, /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$/m)
  assert.match(source, /transaction_begin_for_migrations/)
  assert.match(source, /isolation_level='REPEATABLE READ'/)
  assert.match(source, /begin_statement="BEGIN ISOLATION LEVEL \$isolation_level;"/)
  assert.match(source, /migration has an unsupported transaction mode/)
  assert.match(source, /migration batch mixes incompatible transaction isolation levels/)
  assert.match(
    source,
    /emit_all_dry_run[\s\S]*transaction_begin_for_migrations[\s\S]*PREDEPLOY_MIGRATIONS/
  )
})

test('read-committed migrations pin isolation on the outer transaction', () => {
  const migration = '20260804045000_quarantine_bingx_rank_authority.sql'
  const body = readFileSync(resolve(ROOT, 'supabase/migrations', migration), 'utf8')

  assert.match(body, /^SET TRANSACTION ISOLATION LEVEL READ COMMITTED;$/m)
  assert.match(source, /begin_statement="BEGIN ISOLATION LEVEL \$isolation_level;"/)
  assert.match(source, /isolation_level='READ COMMITTED'/)
  assert.match(source, /read_committed_count/)
})

test('disposable diagnostic emitters retain exact-ledger drift checks', () => {
  assert.match(source, /emit_pending_migration/)
  assert.match(source, /SKIP exact ledger/)
  assert.match(source, /refusing drifted ledger/)
  assert.match(
    source,
    /emit_pending_migration\(\)[\s\S]*SKIP exact ledger[\s\S]*emit_ledger_exact_preflight "\$migration"/
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

test('every public write-shaped command fails closed before environment parsing', () => {
  const mainSource = source.slice(source.indexOf('main() {'))
  const rejection = mainSource.indexOf(
    'apply-concurrent-recovery | apply-predeploy | apply-predeploy-one | apply-postdeploy | apply-recovery)'
  )
  const environmentParsing = mainSource.indexOf('require_environment')

  assert.notEqual(rejection, -1)
  assert.notEqual(environmentParsing, -1)
  assert.ok(rejection < environmentParsing)
  assert.match(
    mainSource,
    /apply-concurrent-recovery \| apply-predeploy \| apply-predeploy-one \| apply-postdeploy \| apply-recovery\)[\s\S]*disabled by ADR-023[\s\S]*exit 2/
  )
  assert.match(
    mainSource,
    /dry-run-all \| dry-run-recovery\)[\s\S]*not a side-effect-free dry run[\s\S]*exit 2/
  )
  assert.doesNotMatch(mainSource, /emit_ordered_predeploy_transaction 'COMMIT'/)
})

test('single predeploy preview is Git-object-bound, offline and serialized before BEGIN', () => {
  assert.match(
    source,
    /require_predeploy_target\(\)[\s\S]*PREDEPLOY_MIGRATIONS\[@\][\s\S]*not in the ordered candidate manifest/
  )
  assert.doesNotMatch(source, /INDEPENDENT_PREDEPLOY_MIGRATIONS/)
  assert.match(
    source,
    /ROOT="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/\.\." && pwd\)"/
  )
  assert.doesNotMatch(source, /ROOT="\$\(git rev-parse --show-toplevel\)"/)
  assert.match(source, /git -C "\$ROOT" ls-files --error-unmatch/)
  assert.match(source, /status --porcelain=v1 --untracked-files=all/)
  assert.match(source, /ls-remote --exit-code origin refs\/heads\/main/)
  assert.match(source, /rev-parse --verify HEAD/)
  assert.match(source, /rev-parse --verify refs\/remotes\/origin\/main/)
  assert.match(
    source,
    /snapshot_ordered_predeploy_manifest\(\)[\s\S]*git -C "\$ROOT" show[\s\S]*"\$ORDERED_PREDEPLOY_RELEASE_SHA:\$relative_path"/
  )
  assert.match(source, /migration_body_sha256\(\)[\s\S]*\.sha256-\$migration/)
  assert.match(source, /PRODUCTION_PROJECT_REF='iknktzifjdyujdccyhsv'/)
  assert.match(source, /aws-0-us-west-2\.pooler\.supabase\.com/)
  assert.match(source, /sslModes\.length === 1 && sslModes\[0\] === 'verify-full'/)
  assert.match(
    source,
    /prepare_ordered_predeploy_preview_target\(\)[\s\S]*ORDERED_PREDEPLOY_PREREQUISITES[\s\S]*validate_transactional_migration_file/
  )
  assert.match(
    source,
    /emit_ordered_predeploy_transaction\(\)[\s\S]*pg_advisory_lock[\s\S]*"\$begin_statement"[\s\S]*LOCK TABLE supabase_migrations\.schema_migrations[\s\S]*IN SHARE ROW EXCLUSIVE MODE[\s\S]*emit_ledger_exact_preflight[\s\S]*emit_migration "\$target"/
  )
  assert.match(
    source,
    /dry-run-predeploy-one \| render-predeploy-one\)[\s\S]*prepare_ordered_predeploy_artifacts "\$migration"[\s\S]*prepare_ordered_predeploy_preview_target "\$migration"[\s\S]*require_live_origin_main[\s\S]*emit_ordered_predeploy_transaction 'ROLLBACK' "\$migration"/
  )
  assert.match(source, /IF NOT pg_catalog\.pg_advisory_unlock/)
  assert.match(source, /ordered predeploy advisory unlock failed/)
  assert.match(source, /BASH_SOURCE\[0\].*==.*\$0/)
  const renderCase = /dry-run-predeploy-one \| render-predeploy-one\)([\s\S]*?)\n\s*;;/.exec(
    source
  )?.[1]
  assert.ok(renderCase)
  assert.doesNotMatch(renderCase, /psql_with_database|run_sql_stream|ledger_state/)
})

test('production endpoint allowlist requires the exact project session URL and verified TLS', () => {
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const invoke = (databaseUrl) =>
    spawnSync('bash', ['-c', 'source "$1"; require_production_project_ref', 'bash', script], {
      cwd: tmpdir(),
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
    `${direct}&application_name=unapproved`,
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

test('write-shaped commands exit 2 before any git or psql access', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-disabled-migration-commands-'))
  const fakePsql = resolve(directory, 'psql')
  const psqlCalls = resolve(directory, 'psql-calls')
  const gitCalls = resolve(directory, 'git-calls')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(
      fakePsql,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"\nexit 99\n'
    )
    chmodSync(fakePsql, 0o755)
    const baseOptions = {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...cleanReleaseEnvironment(directory),
        DATABASE_URL: 'not-a-database-url',
        FAKE_GIT_CALLS: gitCalls,
        FAKE_PSQL_CALLS: psqlCalls,
      },
    }
    const commands = [
      ['apply-concurrent-recovery'],
      ['apply-predeploy'],
      ['apply-predeploy-one', '20260716111600_atomic_group_application_review.sql'],
      ['apply-postdeploy'],
      ['apply-recovery'],
      ['dry-run-all'],
      ['dry-run-recovery'],
    ]

    for (const args of commands) {
      rmSync(gitCalls, { force: true })
      rmSync(psqlCalls, { force: true })
      const result = spawnSync('bash', [script, ...args], baseOptions)
      assert.equal(result.status, 2, result.stderr)
      if (args[0].startsWith('apply-')) {
        assert.match(result.stderr, /disabled by ADR-023/)
      } else {
        assert.match(result.stderr, /not a side-effect-free dry run/)
      }
      assert.equal(existsSync(gitCalls), false, `${args[0]} reached git`)
      assert.equal(existsSync(psqlCalls), false, `${args[0]} reached psql`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('single predeploy render ignores clean-worktree simulation and uses one Git snapshot', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-single-predeploy-render-'))
  const fakePsql = resolve(directory, 'psql')
  const psqlCalls = resolve(directory, 'psql-calls')
  const gitCalls = resolve(directory, 'git-calls')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const target = '20260718123000_shadow_sources_without_roi_basis.sql'
  const targetPath = `supabase/migrations/${target}`
  const version = target.split('_')[0]
  const gitObjectBody = [
    'BEGIN;',
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
    "SELECT 'verified-git-object-snapshot'::text;",
    'COMMIT;',
    '',
  ].join('\n')
  const objectHash = createHash('sha256').update(gitObjectBody).digest('hex')
  const worktreeHash = migrationBodySha(target)
  // The fake status stays clean, as it would for an assume-unchanged path, while
  // the verified commit object deliberately differs from the mutable worktree.
  assert.notEqual(objectHash, worktreeHash)

  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(
      fakePsql,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"\nexit 99\n'
    )
    chmodSync(fakePsql, 0o755)
    const inheritedEnvironment = { ...process.env }
    delete inheritedEnvironment.DATABASE_URL
    const baseOptions = {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...inheritedEnvironment,
        ...cleanReleaseEnvironment(directory),
        FAKE_GIT_CALLS: gitCalls,
        FAKE_GIT_TARGET_PATH: targetPath,
        FAKE_GIT_TARGET_BODY: gitObjectBody,
        FAKE_PSQL_CALLS: psqlCalls,
      },
    }

    for (const command of ['dry-run-predeploy-one', 'render-predeploy-one']) {
      rmSync(gitCalls, { force: true })
      rmSync(psqlCalls, { force: true })
      const result = spawnSync('bash', [script, command, target], baseOptions)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(existsSync(psqlCalls), false, `${command} reached psql`)
      assert.equal(
        result.stdout.split('\n')[0],
        `\\echo VERIFIED_RELEASE ${baseOptions.env.FAKE_GIT_HEAD}`
      )
      assert.equal(result.stdout.match(/^\\echo APPLY /gm)?.length, 1)
      assert.match(result.stdout, /^BEGIN ISOLATION LEVEL REPEATABLE READ;$/m)
      assert.match(result.stdout, /SELECT 'verified-git-object-snapshot'::text;/)
      assert.match(result.stdout, new RegExp(`codex:${version}:${objectHash}`))
      assert.doesNotMatch(result.stdout, new RegExp(`codex:${version}:${worktreeHash}`))
      assert.match(result.stdout, /^ROLLBACK;$/m)

      const ledgerTag = `$arena_ledger_body_${version}$`
      const applyStart = result.stdout.indexOf(`\\echo APPLY ${target}`)
      const executionBody = result.stdout.indexOf(
        "SELECT 'verified-git-object-snapshot'::text;",
        applyStart
      )
      const ledgerStart = result.stdout.indexOf(`ARRAY[${ledgerTag}`)
      const ledgerEnd = result.stdout.indexOf(`${ledgerTag}]::text[]`, ledgerStart)
      assert.notEqual(applyStart, -1)
      assert.notEqual(executionBody, -1)
      assert.notEqual(ledgerStart, -1)
      assert.notEqual(ledgerEnd, -1)
      assert.ok(executionBody < ledgerStart)
      const ledgerBody = result.stdout.slice(ledgerStart + `ARRAY[${ledgerTag}`.length, ledgerEnd)
      assert.equal(ledgerBody, gitObjectBody)

      const calls = readFileSync(gitCalls, 'utf8')
      assert.match(
        calls,
        new RegExp(
          `-C ${ROOT.replaceAll('/', '\\/')} show ${baseOptions.env.FAKE_GIT_HEAD}:${targetPath}`
        )
      )
      assert.equal(calls.match(/ls-remote --exit-code origin refs\/heads\/main/g)?.length, 2)
      assert.doesNotMatch(calls, /rev-parse --show-toplevel/)
    }

    rmSync(gitCalls, { force: true })
    rmSync(psqlCalls, { force: true })
    const outsideManifest = spawnSync(
      'bash',
      [script, 'render-predeploy-one', '20260721000000_not_a_manifest_migration.sql'],
      baseOptions
    )
    assert.equal(outsideManifest.status, 2)
    assert.match(outsideManifest.stderr, /not in the ordered candidate manifest/)
    assert.equal(existsSync(gitCalls), false)
    assert.equal(existsSync(psqlCalls), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('single predeploy rejects untrusted release provenance before rendering', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-single-provenance-'))
  const fakePsql = resolve(directory, 'psql')
  const psqlCalls = resolve(directory, 'psql-calls')
  const gitCalls = resolve(directory, 'git-calls')
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  const target = '20260716111600_atomic_group_application_review.sql'
  try {
    writeFakeCleanReleaseGit(directory)
    writeFileSync(
      fakePsql,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_PSQL_CALLS"\nexit 99\n'
    )
    chmodSync(fakePsql, 0o755)
    const baseOptions = {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...cleanReleaseEnvironment(directory),
        FAKE_GIT_CALLS: gitCalls,
        FAKE_PSQL_CALLS: psqlCalls,
      },
    }
    const cases = [
      [{ FAKE_GIT_TRACKED: 'false' }, /must be tracked by git/],
      [{ FAKE_GIT_DIRTY: ' M changed.sql' }, /requires a clean worktree/],
      [{ FAKE_GIT_DIRTY: '?? untracked.sql' }, /requires a clean worktree/],
      [{ FAKE_GIT_ORIGIN_MAIN: 'different-sha' }, /HEAD to equal the pushed origin\/main SHA/],
      [
        { FAKE_GIT_LIVE_MAIN: '2222222222222222222222222222222222222222' },
        /release no longer equals the live pushed origin\/main SHA/,
      ],
      [{ FAKE_GIT_REMOTE_AVAILABLE: 'false' }, /could not verify the live origin\/main SHA/],
      [
        { FAKE_GIT_HEAD: 'not-a-release-sha', FAKE_GIT_ORIGIN_MAIN: 'not-a-release-sha' },
        /no verified release SHA/,
      ],
    ]
    for (const [environment, message] of cases) {
      rmSync(gitCalls, { force: true })
      rmSync(psqlCalls, { force: true })
      const result = spawnSync('bash', [script, 'render-predeploy-one', target], {
        ...baseOptions,
        env: { ...baseOptions.env, ...environment },
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, message)
      assert.equal(existsSync(psqlCalls), false)
      const calls = readFileSync(gitCalls, 'utf8')
      assert.match(calls, new RegExp(`^-C ${ROOT.replaceAll('/', '\\/')} `, 'm'))
      assert.doesNotMatch(calls, / show /)
      assert.doesNotMatch(calls, /rev-parse --show-toplevel/)
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

test('recovery emitters remain internal while every public recovery path is disabled', () => {
  assert.match(source, /validate_concurrent_migration_file/)
  assert.match(source, /CREATE INDEX CONCURRENTLY/)
  assert.match(
    source,
    /apply-concurrent-recovery \| apply-predeploy \| apply-predeploy-one \| apply-postdeploy \| apply-recovery\)[\s\S]*exit 2/
  )
  assert.match(source, /dry-run-all \| dry-run-recovery\)[\s\S]*exit 2/)
})

test('status makes intentionally quarantined and superseded migrations explicit', () => {
  assert.match(
    source,
    /phase in predeploy postdeploy concurrent-recovery recovery quarantined superseded/
  )
  assert.match(source, /quarantined-unapplied/)
  assert.match(source, /quarantined-exact-forward-repair-required/)
  assert.match(source, /quarantined-drift/)
  assert.match(source, /'superseded-by-' \|\| target\.superseder/)
  assert.match(source, /replacement\.version = target\.superseder/)
  assert.match(source, /missing-superseder/)
  assert.match(source, /THEN 'exact'/)
  assert.match(source, /ELSE 'drift'/)
})

test('every superseded migration names a superseder and forward replacements take its slot', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const superseded = migrationArray('SUPERSEDED_MIGRATIONS')
  const ordered = [...predeploy, ...postdeploy]
  // Superseders that are not ordered launch files: a separately applied repo
  // migration, and the production ledger version that already holds 001418.
  const external = new Map([
    ['20260716104500_collection_read_write_boundaries.sql', '20260717230000'],
    ['20260808001418_atomic_group_channel_settings_update.sql', '20260808071456'],
  ])
  const script = resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh')
  for (const migration of superseded) {
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1"; superseder_version "$2"', 'bash', script, migration],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(result.status, 0, `${migration}: ${result.stderr}`)
    const superseder = result.stdout
    assert.match(superseder, /^\d{14}$/)
    assert.ok(!ordered.includes(migration), `${migration} must not be replayed`)
    if (external.has(migration)) {
      assert.equal(superseder, external.get(migration))
      continue
    }
    const replacement = ordered.filter((file) => file.startsWith(`${superseder}_`))
    assert.equal(replacement.length, 1, `${migration} superseder ${superseder} is not ordered`)
    const body = readFileSync(resolve(ROOT, 'supabase/migrations', replacement[0]), 'utf8')
    assert.ok(body.includes(migration.slice(0, 14)), `${replacement[0]} must cite ${migration}`)
  }
  const unknown = spawnSync(
    'bash',
    ['-c', 'source "$1"; superseder_version 20990101000000_unknown.sql', 'bash', script],
    { cwd: ROOT, encoding: 'utf8' }
  )
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /superseded migration has no superseder/)

  // Forward replacements and inserts run where the rehearsal ran them.
  const before = (a, b) => assert.ok(predeploy.indexOf(a) < predeploy.indexOf(b), `${a} < ${b}`)
  assert.equal(
    predeploy[predeploy.indexOf('20260722053000_binance_spot_metric_source_contract.sql') - 1],
    '20261111191927_binance_spot_contract_registration_serving_hold.sql'
  )
  assert.equal(
    predeploy[predeploy.indexOf('20260722053000_binance_spot_metric_source_contract.sql') + 1],
    '20261111191928_binance_spot_contract_registration_serving_restore.sql'
  )
  assert.equal(
    predeploy[predeploy.indexOf('20260725016500_leaderboard_rank_persisted_codec.sql') - 1],
    '20261111140053_leaderboard_ranks_codec_layout_rebuild.sql'
  )
  before(
    '20260725017000_leaderboard_rank_typed_batch_contract.sql',
    '20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql'
  )
  before(
    '20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql',
    '20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql'
  )
  before(
    '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql',
    '20261111132444_rank_history_service_only_acl_hosted_role_graph.sql'
  )
  before(
    '20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql',
    '20260817134214_quarantine_legacy_platform_stats_rpc.sql'
  )
  // 192134 allowlists raw-object guards that later predeploy files install.
  assert.equal(
    postdeploy.at(-1),
    '20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql'
  )
})
