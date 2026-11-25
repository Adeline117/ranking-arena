#!/usr/bin/env bash

# Launch migration diagnostics and dormant ordered-channel candidate.
#
# Usage:
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh status
#   scripts/maintenance/apply-launch-migrations.sh \
#     render-predeploy-one 20260721120000_metric_trust_shadow_gate.sql
#   dry-run-predeploy-one is a compatibility alias for the same render-only
#   command. dry-run-all and dry-run-recovery are disabled.
#   Inside an owner-opened launch window only (ADR-023 amendment 2026-11-14):
#   ARENA_LAUNCH_WINDOW_CONFIRM=... DATABASE_URL=... \
#     scripts/maintenance/apply-launch-migrations.sh \
#       apply-predeploy-one <first-missing-manifest-migration.sql>
#   ARENA_LAUNCH_WINDOW_CONFIRM=... DATABASE_URL=... \
#     scripts/maintenance/apply-launch-migrations.sh \
#       apply-single-file <single-file-or-postdeploy-migration.sql>
#   The bulk psql commands (apply-predeploy, apply-postdeploy, recovery) stay
#   disabled.
#
# ADR-023 names Supabase MCP apply_migration as the production channel for a
# single reviewed file. The launch backlog is 91 predeploy files (2.9 MB): it
# cannot be re-typed through that tool byte-exactly. Its 2026-11-14 amendment
# therefore opens the psql-backed ordered emitter for one operator, one file
# per invocation, under an explicit window attestation. Every invocation takes
# the same session advisory lock and locks the ledger, so two operators cannot
# interleave. The targeted preview performs no database access and only prints
# SQL; it never sends the migration body to production. Preview bytes come from
# one snapshot of the verified origin/main Git object, never the mutable
# worktree. Manually executing rendered ROLLBACK SQL can still advance sequences
# or trigger other non-transactional side effects and is not an approved path.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
PRODUCTION_PROJECT_REF='iknktzifjdyujdccyhsv'
ORDERED_PREDEPLOY_RELEASE_SHA=''
ORDERED_PREDEPLOY_SNAPSHOT_DIR=''

# Order follows the 2026-11-11 whole-database rehearsal: 20261111* forward
# replacements take the slot of the original they supersede, and three inserts
# run where the rehearsal ran them (191927/191928 bracket 20260722053000;
# 140053 precedes 20260725016500). The record-provenance chain (20260803*) and
# the GMX source-contract pair (20260715231500/232500) stay outside this
# manifest on purpose; their replacements are classified explicitly in
# ADR023_SINGLE_FILE_MIGRATIONS below.
# 20261117130152 re-creates public.arena_metric_trust_release_readiness with
# one changed clause: the score-input encoder pin. 20261113014105 and
# 20261114101514 (earlier in this list) re-created the encoder with the
# PnL-domain guard spelled with jsonb_typeof, so the 20260722055000 pin on
# 'jsonb_path_query_array' reports metric_trust_object_contract missing and
# the ingest worker startup gate fails closed. The worker cannot start until
# it is applied, so it is predeploy; it reads no other launch object.
PREDEPLOY_MIGRATIONS=(
  20260716111600_atomic_group_application_review.sql
  20260716111700_group_application_read_write_boundary.sql
  20260716111800_group_creation_membership_write_boundary.sql
  20260716112100_channel_membership_server_boundary.sql
  20260716112300_atomic_content_report_submission.sql
  20260716113800_private_report_evidence_storage.sql
  20260716113900_atomic_group_membership.sql
  20260716114000_atomic_direct_message_send.sql
  20260716114100_atomic_group_member_moderation.sql
  20260716114200_atomic_direct_message_delete.sql
  20260716114500_atomic_comment_block_authorization.sql
  20260716114600_group_membership_identity_guard.sql
  20260716114700_atomic_group_join_requests.sql
  20260716114800_atomic_group_invites.sql
  20260716114900_atomic_deleted_account_group_purge.sql
  20260716152647_atomic_existing_channel_member_add.sql
  20260716154731_atomic_report_moderation_queue.sql
  20260716160000_report_moderation_operation_id.sql
  20260716161000_atomic_group_channel_create.sql
  20260716163000_atomic_single_report_resolution.sql
  20260716164000_group_application_operation_replay.sql
  20260716165000_atomic_group_mute.sql
  20260716170000_group_edit_application_operation_replay.sql
  20260716171000_group_member_read_privacy.sql
  20260716172000_group_subscriptions_server_authority.sql
  20260716173000_group_audit_log_read_boundary.sql
  20260716174000_group_subscription_expiry_owner_compat.sql
  20260716175000_atomic_group_dissolution.sql
  20260716176000_atomic_group_pass.sql
  20260716176100_group_premium_entitlement.sql
  20260716177000_atomic_pro_official_groups.sql
  20260716178000_user_profile_write_authority.sql
  20260716178100_atomic_post_child_interactions.sql
  20260716179000_user_profile_handle_contract.sql
  20260716179100_user_profile_read_audience.sql
  20260716179200_user_profile_wallet_authority.sql
  20260716190000_atomic_user_follow.sql
  20260716191000_atomic_user_block.sql
  20260717130000_hero_stats_count_live_source_boards.sql
  20260717220000_notification_read_authority.sql
  20260717222500_notification_type_contract.sql
  20260718120000_leaderboard_source_freshness.sql
  20260718123000_shadow_sources_without_roi_basis.sql
  20260718130000_count_trader_account_followers.sql
  20260718131000_source_scope_trader_follow_activity.sql
  20260718132000_active_source_platform_freshness.sql
  20260718133000_history_partition_range_guard.sql
  20260718134000_freshness_expected_sources.sql
  20260718135000_partition_child_rls_convergence.sql
  20260718140000_add_metric_completeness_daily.sql
  20260718182917_arena_resolver_fetch_region.sql
  20260718183000_atomic_stripe_entitlement_identity.sql
  20260718183500_harden_stripe_entitlement_null_validation.sql
  20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql
  20260718184000_arena_score_inputs_board_as_of.sql
  20260718184500_classify_non_entitlement_stripe_payments.sql
  20260718184550_durable_tip_completion_notification.sql
  20260721120000_metric_trust_shadow_gate.sql
  20260721130000_raw_object_gc_outbox.sql
  20260721140000_idempotent_equivalent_refund_events.sql
  20260721150000_metric_trust_raw_artifact_identity.sql
  20260721180903_metric_rankable_score_inputs_shadow.sql
  20260721175746_arena_score_inputs_publish_bundle.sql
  20260721210000_tip_checkout_lifecycle_atomic.sql
  20260721211000_tip_checkout_completion_identity.sql
  20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql
  20260722040000_leaderboard_acquisition_manifest_v3_compat.sql
  20260722041000_pure_arena_score_v4_scorer.sql
  20260722042000_leaderboard_terminal_publication_fence.sql
  20260722050000_metric_trust_attempt_outcome_authority.sql
  20260722051000_leaderboard_score_input_manifest_contract.sql
  20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql
  20261111191927_binance_spot_contract_registration_serving_hold.sql
  20260722053000_binance_spot_metric_source_contract.sql
  20261111191928_binance_spot_contract_registration_serving_restore.sql
  20260722055000_metric_trust_source_page_lineage_forward_repair.sql
  20260724010000_shadow_unverified_okx_web3_ranks.sql
  20260724232500_allow_pipeline_logs_partial_success.sql
  20260724234000_optimize_arena_score_inputs_json_hot_path.sql
  20260724235000_leaderboard_publication_mutation_fence.sql
  20260725011000_durable_ingest_worker_fence_substrate.sql
  20260725012000_strengthen_arena_score_publish_evidence.sql
  20260725013000_cleanup_leaderboard_rank_publication.sql
  20260725014000_strengthen_leaderboard_publication_proof_authority.sql
  20260725014500_close_rank_cleanup_public_execute.sql
  20260725015000_leaderboard_rank_generation_claim.sql
  20260725015500_bound_leaderboard_rank_generation_batches.sql
  20260725016000_leaderboard_rank_generation_receipt_substrate.sql
  20261111140053_leaderboard_ranks_codec_layout_rebuild.sql
  20260725016500_leaderboard_rank_persisted_codec.sql
  20260725017000_leaderboard_rank_typed_batch_contract.sql
  20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql
  20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql
  20261111134210_bitget_bots_canonical_timeframe_partial_seed.sql
  20260728123000_arena_bot_header_canonical_snapshot.sql
  20261115013558_quarantine_bitget_bot_cumulative_rank_authority_join_order.sql
  20260729010000_api_keys_server_authority.sql
  20260729011000_leaderboard_rank_manifest_attestation_substrate.sql
  20260729012000_partitioned_bot_acquisition_manifest_v4.sql
  20260729013000_bitget_bot_attempt_health_contract.sql
  20260729014000_bitget_bot_copier_aggregate_authority.sql
  20260729014500_leaderboard_rank_generation_canonical_batches.sql
  20260729015000_leaderboard_rank_generation_attested_batch_writer.sql
  20260729015500_tier_a_execution_claim_fence.sql
  20260729054400_leaderboard_rank_generation_private_staging.sql
  20260729060000_stale_leaderboard_attempt_report.sql
  20260729061533_leaderboard_rank_generation_staging_only_writer.sql
  20260729063000_leaderboard_rank_staging_full_xid_guard.sql
  20260729064500_leaderboard_rank_generation_publication_plan.sql
  20260729065000_normalize_arena_score_input_platform_aliases.sql
  20260729070000_pure_arena_score_v5_zero_metric_scorer.sql
  20260729070500_leaderboard_score_input_manifest_v2.sql
  20260729071000_leaderboard_metric_trust_projection_v2.sql
  20260729071500_tier_a_one_phase_commit_guard.sql
  20260729220908_season_scoped_leaderboard_count_cache.sql
  20260729223000_rerank_public_eligible_rows_only.sql
  20260729224000_rank_eligible_leaderboard_count_cache.sql
  20260729225000_token_trader_rank_authority.sql
  20261111133259_token_ranking_generation_barrier_cron_api.sql
  20261111133300_retire_legacy_token_rankings_cron_api.sql
  20260730033000_token_trade_fact_authority_shadow.sql
  20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql
  20260804050000_harden_serving_trader_resolver.sql
  20260804051000_harden_serving_source_capabilities.sql
  20260804052000_fail_closed_unbound_copier_aggregates.sql
  20260804053000_copier_snapshot_publication_substrate.sql
  20260804054000_publish_copier_snapshot_atomically.sql
  20260808010000_copier_snapshot_trust_raw_role.sql
  20260808020000_copier_snapshot_trust_publication_substrate.sql
  20260808021000_publish_copier_snapshot_trust_v2.sql
  20260808090000_quarantine_legacy_trader_daily_snapshots.sql
  20260816130000_quarantine_v1_trader_alert_browser_mutations.sql
  20260816151614_public_ranked_leaderboard.sql
  20260816184500_public_ranked_leaderboard_source_freshness_gate.sql
  20260817000000_finalize_trader_alert_delivery_epoch_fence.sql
  20261111132444_rank_history_service_only_acl_hosted_role_graph.sql
  20261111132445_trader_activities_publication_fence_hosted_role_graph.sql
  20261111132446_notification_ranking_change_reader_fence_hosted_role_graph.sql
  20261111132447_arena_bot_legacy_publication_isolation_hosted_role_graph.sql
  20261111132448_trader_series_publication_isolation_hosted_role_graph.sql
  20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql
  20260817134214_quarantine_legacy_platform_stats_rpc.sql
  20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql
  20261113014105_arena_score_unknown_trades_confidence.sql
  20261114101514_arena_score_true_zero_trades_confidence.sql
  20261114104438_sealed_publication_data_gap_summary.sql
  20261113010326_release_leaderboard_rank_generation_lease_after_seal.sql
  20261113011058_leaderboard_publication_source_isolation.sql
  20261113012028_public_snapshot_readers_sealed_freshness.sql
  20261113105605_retention_preserves_metric_trust_evidence.sql
  20261113110021_leaderboard_snapshot_retention.sql
  20261113110430_rank_publication_source_evidence_binding.sql
  20261114101605_first_screen_core_modules_sealed_only.sql
  20261114103025_hero_stats_sealed_public_cohort.sql
  20261114193017_rank_publication_requires_attempt_bound_evidence.sql
  20261114211033_public_source_board_metric_contracts.sql
  20261115141050_leaderboard_exhaustion_completeness_evidence.sql
  20261116203816_metric_source_contract_retirement.sql
  20261116205144_trader_stats_score_input_evidence_pointer.sql
  20261116215328_profile_acquisition_evidence_ledger.sql
  20261117130152_metric_trust_readiness_encoder_pnl_domain_pin.sql
)
readonly -a PREDEPLOY_MIGRATIONS
# The final six (season publication follow-ups, PR #419) must stay LAST: they
# need the public serving authority (20260816184500), and 20261113011058
# rewrites the freshness authority after the Bitget-bot quarantine
# (20261115013558, which replaces 20260728124000 in its slot). They follow
# #415's reordered manifest (2026-11-11 whole-database rehearsal order).
# 20261114101605 (profile readers: sealed boards only, no stale stats) follows
# them: it replaces the two readers 20261113012028 rewrote and needs its
# arena.public_sealed_rank_sources().
# 20261114103025 (hero stats from the sealed cohort) keeps the RPC's return
# shape, so either app version reads it; it needs the public serving view.
# 20261114193017 (publication requires attempt-bound evidence, audit-2 P1-4)
# replaces 20261113110430's evidence RPC and adds a deferred seal fence, so it
# must follow 110430. It is predeploy: the new orchestrator refuses every
# season without it, and the old orchestrator already calls the replaced RPC
# (an untrusted source then refuses that season instead of being isolated
# until the new worker ships, which publishes nothing unbound either way).
# 20261114211033 (board metric contracts for the newly captured public sources)
# is inert for the deployed worker, which reads metric contracts only for
# sources it already captures; its postdeploy partner 20261114211034 registers
# their attempt-bound capture after the worker that implements it ships.
# 20261115141050 (exhausted completeness mode) must follow 193017, whose
# publication predicate it replaces, and 20260722050000, whose metric-trust
# outcome authority it replaces (both pinned by prior-body sha256). It changes
# no ledger table and is inert until a source registers an exhaustion contract
# (its registry starts empty), so it is predeploy: the worker that records
# exhaustion proofs calls arena.record_leaderboard_exhaustion_evidence.
# 20261116203816 (append-only metric source contract retirement) is inert
# until a version is retired: the current contract set equals the active set
# and the deployed worker never reads the new table. It is predeploy because
# the worker that resolves contracts through the retirement table needs that
# table before it ships; its preflight refuses a source that already holds two
# active versions. It needs only 20260721120000.
# 20261116205144 (score-input evidence binding, step 2a) adds the per-value
# evidence pointer to arena.trader_stats and its guard trigger. It is inert for
# the deployed worker, which never sets the pointer (every row stays NULL), and
# the worker release that stamps attempt-bound board writes needs the columns,
# so it is predeploy. It reads no other launch object.
# 20261116215328 (attempt-bound Tier-B profile evidence) adds the empty
# profile capture contract registry, the append-only profile acquisition
# ledger and its two RPCs, and the per-value profile pointer on
# arena.trader_stats with its guard trigger. It is inert for the deployed
# worker (no contract is registered, nothing calls the RPCs, every pointer
# stays NULL); the worker release that records profile attempts needs it, so
# it is predeploy. It needs 20261116205144 (shared metric value helper).
#
# 20261113014105 (unknown-trade-count sample confidence, issue #435) and its
# follow-up 20261114101514 (true-zero trade counts, audit P1-2), in that order,
# are predeploy and must follow every migration whose pre/postflight pins the old
# v4/v5 scorer or manifest-encoder prosrc digests (latest: 20260729071000),
# otherwise those preflights abort. Public publication (protocol plan A,
# docs/RANK_PUBLICATION_PROTOCOL.md) scores in TypeScript and never calls the
# PG17 scorer, so neither deploy order breaks it; predeploy guarantees the
# manifest substrate created earlier in this same run never seals a manifest
# under the old definition digest, and a failure stops the release before the
# new scorer ships instead of leaving TS and PG17 diverged after it.
# 20260721180903, 20260729220908 and 20260730033000 were in no array and not in
# the production ledger until the 2026-11-14 whole-database rehearsal: 180903
# creates arena.metric_rankable_score_inputs_shadow, a hard preflight
# prerequisite of 20260729064500; 220908 creates the season-scoped count-cache
# refresh that 20260729224000 and the app call; 033000 is an additive token
# shadow substrate with no reader. Each sits in its chronological slot.
# 20261114104438 (data gap summary judged on sealed publication, audit P2-2)
# only replaces the body of a cron/admin-only reader; it needs the public
# serving view (20260816151614/184500) and sits before the final six, which do
# not depend on it.

# 054 is retained as immutable history but is never an ordered candidate. 055
# accepts it only when its exact reviewed ledger and complete object contract
# are already present; a missing 054 is intentionally skipped.
QUARANTINED_PREDEPLOY_MIGRATIONS=(
  20260722054000_metric_trust_source_page_lineage.sql
)
readonly -a QUARANTINED_PREDEPLOY_MIGRATIONS

TIP_CHECKOUT_CUTOVER_VERSIONS=(
  20260721210000
  20260721211000
)
readonly -a TIP_CHECKOUT_CUTOVER_VERSIONS
TIP_CHECKOUT_CUTOVER_ATTESTATION='TIP_CHECKOUT_FROZEN_PENDING_ZERO'

# These contracts revoke compatibility writes or change identity uniqueness
# used by old routes. They must run only after the target application is serving
# production.
# 20261113150757 (formal win-rate cleanup, #441) is a data repair, not a
# contract: old code still runs correctly after it, but the pre-60f4cc288 BTCC
# parser and the pre-bf3fa8a4d on-chain enrichment rewrite the very values it
# cleans. It therefore runs only after the ingest-worker release carrying both
# fixes has replaced every old writer, and before the next derive-boards run
# and publication. It touches no table 192134 guards, so 192134 stays last.
# 20261114211034 registers attempt-bound capture for the public sources whose
# adapters gained captureLeaderboard; registered before that worker serves,
# every Tier-A run of those sources would fail. It inserts capture-registry
# rows only (no table 192134 guards) and requires predeploy 20261114211033.
# 20261115160917 registers the next public sources the same way (V3 capture
# for total-mode and exhausted-mode boards, their metric and exhaustion
# contracts, and the source windows/currency/page_size those captures need).
# Registered before the worker that ships the captures, every Tier-A run of
# those sources would fail, so it is postdeploy, after 211034. It requires
# predeploy 20261115141050 (exhaustion registry) and 20261114211033 (kucoin's
# contract) and touches no table 192134 guards, so 192134 stays last.
# 20261116204359 replaces 20261115170535, whose preflight accepts only the
# seed pre-state; production already holds the four as active/serving, so it
# refuses there. The replacement accepts either pre-state per row.
# 20261115170535 activates okx_futures, okx_spot, toobit_futures and
# xt_futures (owner decision 2026-11-15) as active/serving sources on the
# `local` region. An active source is scheduled for Tier-A at once and Tier-A
# fails closed without a deployed capture and its registration, so it follows
# the worker release and 160917 (its preflight requires 160917's capture and
# exhaustion rows and post-160917 windows/page_size). It updates arena.sources
# only (no table 192134 guards), so 192134 stays last.
# 20261116203817 registers binance_web3_bsc metric contract v2 and retires v1
# (predeploy 20261116203816). The worker before this release reads v1, so it
# follows the worker whose registry holds v2; until then that worker fails its
# contract parity check for binance_web3_bsc only. It needs binance_web3_bsc in
# USD (160917); it follows 20261116204359 (the forward replacement of the
# superseded 170535 activation) and touches no table 192134 guards, so 192134
# stays last.
# 20261116204006 (score-input evidence binding, step 1) moves the score-input
# bundle's scoreRows to arena.publication_score_rows_json: board headline
# metrics only, plus a per-row unevidenced_metrics list. The deployed
# orchestrator's strict bundle schema rejects that key (it would refuse every
# season), so it follows the worker release that accepts it; it pins the
# bundle body 20261115013558 installed and touches no table 192134 guards.
# 20261116210122 (step 2b) makes that reader accept a trader_stats value only
# when an attempt-bound write of the selected board's RAW attested it. Before
# the worker that stamps board writes serves, no row is attested and every
# trader_stats metric would publish as NULL, so it is postdeploy, after
# 204006 (whose reader it replaces) and predeploy 20261116205144 (the pointer).
# 20261116210657 (step 3) adds score_input_sha256 to the rank-publication
# evidence rows and makes the evidence RPC (@3) and the deferred seal fence
# require it. The deployed orchestrator sends no digest, so @3 would refuse
# every season; the release that sends one accepts @2 and @3. Postdeploy,
# after 210122; it replaces predeploy 20261114193017's RPC and fence bodies.
# 20261116215329 makes arena.publication_score_rows_json (@3) also accept a
# trader_stats value attested by a complete, fresh profile capture of the same
# source, trader and timeframe (predeploy 20261116215328). It replaces the @2
# body of 210122, so it follows it; with no profile attestation it returns
# exactly the @2 rows. It touches no table 192134 guards.
# 20261117015119 registers every profile capture contract of the worker's code
# registry (PROFILE_CAPTURE_CONTRACTS: binance_futures, binance_spot,
# bybit_copytrade, blofin_futures, toobit_futures) in the registry of predeploy
# 20261116215328. A registered contract is only meaningful to the worker release
# that carries the same contract document, so it follows that release; it
# follows 215329 (the reader that consumes profile attestations) and touches
# no table 192134 guards, so 192134 stays last. It refuses a replay, an earlier
# registration for a listed source, and a missing or re-adaptered source.
# 20261117204948 moves binance_futures and binance_spot from fetch_region
# vps_sg to local (owner decision 2026-11-17; a local read-only browser probe
# reached both boards). It changes fetch_region only, needs a running local
# worker release with both profile capture contracts registered, so it follows
# 015119; it touches no table 192134 guards.
# 20261118112703 adds the exhaustion-completeness branch (20261115141050) to
# the observation lineage trigger, the rankable view and the readiness RPC:
# without it okx_futures, okx_spot and binance_web3_bsc fail every real
# publication. It re-creates the 20261117130152 readiness body, so it follows
# it; no worker code depends on it and it touches no table 192134 guards.
# 20261118114230 lets the exhausted completeness proof accept a third board
# version kind, reported_total_drift (bounded relative drift, at most 1%), for
# live boards that change while they are paged. It only replaces two function
# bodies and is inert until a source registers such a declaration; it follows
# 112703 (which makes exhausted outcomes publishable) and touches no table
# 192134 guards.
# 20261118135918 (trust evidence retention) adds a count-first purge function
# with an owner-only delete switch (off), its audit ledger, two lookup indexes
# (non-concurrent: metric_trust_observations(source_run_id) and the Tier-A
# receipt snapshot index) and lets reject_direct_metric_trust_mutation accept
# a run DELETE the same transaction authorized. The worker release that calls
# it treats a missing function as not_installed, so it follows that release;
# it touches no table 192134 guards.
# 20261118144144 makes public.rank_publication_trust_evidence require the
# board's own metric-trust run and no in_progress / runs_only retention purge.
# It reads the 20261118135918 audit table, so it follows it. A source whose
# boards carry outcomes but no metric-trust run becomes untrusted (isolated)
# at the next publication; it touches no table 192134 guards.
# 20261118134316 (RAW retention backlog census) adds a switch table (off),
# an orphan GC queue and count-only census/scan functions; the worker release
# that calls them treats a missing function as not_installed, so it follows
# that release. It reads storage.objects, deletes nothing, and touches no
# table 192134 guards.
# 040440 forward replacement. V1_EXECUTION_STATUS requires the RAW-only
# bridge SHA to be deployed and legacy callers drained before the legacy
# position-history relations are frozen. Current main never reads or writes
# them (only database.types.ts declares them), so freezing after the deploy
# breaks no caller, while freezing before it could break the old release
# still serving during predeploy. No predeploy or later postdeploy file
# references these relations or create_next_tph_partition.
# 20261117204557 rebuilds arena.mv_source_capabilities with per-trader index
# probes (the */30 pg_cron refresh ran into the statement timeout on every run
# and its locks blocked the ingest worker's startup ensurePartitions) and moves
# the refresh to hourly at :17. It depends on no worker release and touches no
# table 192134 guards; apply it outside a running refresh (it waits 5s for the
# view lock, then rolls back).
# 20261118113319 raises the leaderboard page size of binance_futures (20 -> 30)
# and binance_spot (20 -> 100), the largest pages those endpoints serve, so a
# live board has less time to move while it is paged. It requires the
# page_size 20 pre-state that 204948 also requires, so it follows 204948; it
# changes page_size only and touches no table 192134 guards.
# 20261118113759 makes the season expected-source set (the publication
# denominator in public.arena_freshness_expected_sources) require a valid
# attempt-bound capture contract registration and lists the rest as
# unsupported. The orchestrator release that records unsupported sources and
# refuses below the expected-set floor must serve first: the previous one would
# publish the reduced set without either. It pins the body 20261113011058
# leaves (prosrc sha256) and touches no table 192134 guards, so 192134 stays
# last.
# 20261118141652 raises the leaderboard page size of toobit_futures (1000 -> 5000)
# so the whole board is one request: the server orders tied traders differently
# between requests, which repeated rows across its three pages. It changes
# page_size only, depends on no worker release and touches no table 192134
# guards.
# 20261118150737 raises the leaderboard page size of xt_futures (1000 -> 5000,
# one request), bitget_cfd and bitget_spot (30 -> 50) and bybit_copytrade
# (16 -> 50), the largest pages those endpoints serve, so a board has less time
# to move and fewer page boundaries while it is paged. It changes page_size
# only, depends on no worker release and touches no table 192134 guards.
# 20261118161307 lets arena.record_tier_a_execution_window_receipt receipt an
# exhausted outcome whose exhaustion proof holds (the 20261115141050 branch):
# without it every exhaustion publication (okx_futures, okx_spot,
# binance_web3_bsc) fails its job after the snapshot committed. The worker
# pins the receipt body, so the release that accepts both the previous and
# the new digest must serve first. It requires predeploy 20261115141050,
# replaces no function 192134 pins and touches no table 192134 guards, so
# 192134 stays last.
# 20261118134500 registers binance_futures as a live board
# (reported_total_drift, 1% of the board) in the append-only exhaustion
# registry. It needs the declaration 114230 makes valid, so it follows it; the
# worker release that captures binance in this mode is deployed after it. It
# touches no table 192134 guards.
# 20261120233328 replaces arena.publication_score_rows_json (@3 of 215329)
# with @4: a trader_stats value the selected board attested is as fresh as that
# board, instead of being dropped when the row's as_of is frozen by an old
# column the board never re-sends. It follows 215329, depends on no worker
# release and touches no table 192134 guards.
# 20261120190124 registers bybit_mt5 as a live board (reported_total_drift,
# 0.1% of the board, at most 100 rows) in the append-only exhaustion registry.
# It needs the declaration 114230 makes valid, so it follows it; it takes
# effect with the worker release that captures bybit_mt5 in this mode. It
# touches no table 192134 guards.
# 20261121185937 replaces public.arena_metric_trust_release_readiness() (the
# 112703 body): its lineage count is evaluated once per run and only over
# observations that can still be ranked, instead of re-parsing every run's
# page ordinals for every observation ever written (15-17s in production
# against the worker's 10s startup timeout). It follows 112703, depends on no
# worker release and touches no table 192134 guards.
# 20261121201553 makes public.arena_visible_sources() count the ranks the
# public view serves instead of reading leaderboard_count_cache, which the
# sealed publication path never refreshes (zero visible sources in production
# while 3,546 ranks were served). Independent of every other entry.
# 20261122152622 validates an observation batch's source-page lineage once per
# acquisition run (AFTER INSERT ... FOR EACH STATEMENT) instead of once per
# row; the per-row trigger re-verified the run's exhaustion proof for every
# observation (63.5 ms x 12,900 rows for binance_futures against a 300 s
# query timeout). It replaces the 112703 trigger function, so it follows it.
# 20261122154211 re-creates the score bundle (204006 body) so its per-snapshot
# entry counts come from index-only scans instead of fetching every entry row
# from the 53 GB heap (5.5 s of a 9.9 s warm run; first 7D attempt timing out
# at 30 s when cold). Output is unchanged. Independent of the other entries.
# 20261124114140 makes a serving source whose sealed watermark leaves the
# 48-hour window hide only its own rows instead of the whole season, and
# applies the publisher's isolation bound at read time. It replaces the
# 20261121201553 body of arena_visible_sources, so it follows it.
# 20261120235710 registers the blofin_spot profile capture contract
# (win_rate, total_positions from the spot detail endpoints) in the registry of
# predeploy 20261116215328. It is only meaningful to the worker release that
# carries the same contract document and crawls the spot detail route, so it
# follows that release; an older worker opens no blofin_spot profile attempt.
# It is independent of 015119 (which leaves blofin_spot unregistered), refuses
# a replay or an earlier blofin_spot registration, and touches no table 192134
# guards.
POSTDEPLOY_MIGRATIONS=(
  20261111135144_freeze_legacy_position_history_relations_prod_creator.sql
  20260716192000_social_edge_write_contract.sql
  20260717120000_trader_follows_composite_identity.sql
  20261115142045_clean_derived_formal_win_rate_scoped_probe.sql
  20261114211034_public_source_attempt_bound_capture_contracts.sql
  20261115160917_public_source_exhaustion_and_total_capture_contracts.sql
  20261116204359_move_public_sources_to_local_region_prod_state.sql
  20261116203817_binance_web3_bsc_metric_contract_v2.sql
  20261116204006_publication_score_rows_board_headline_only.sql
  20261116210122_publication_score_rows_require_stats_evidence.sql
  20261116210657_rank_publication_evidence_score_input_digest.sql
  20261116215329_publication_score_rows_profile_attested.sql
  20261117015119_register_profile_capture_contracts.sql
  20261117204948_move_binance_sources_to_local_region.sql
  20261117204557_source_capabilities_refresh_index_probe.sql
  20261118112703_metric_trust_exhaustion_observation_authority.sql
  20261118113319_binance_leaderboard_page_size_served_caps.sql
  20261118114230_leaderboard_exhaustion_reported_total_drift.sql
  20261118113759_expected_sources_require_capture_contract.sql
  20261118141652_toobit_leaderboard_single_page.sql
  20261118150737_public_boards_larger_served_pages.sql
  20261118161307_tier_a_window_receipt_exhaustion_branch.sql
  20261118134500_register_binance_live_board_exhaustion_contracts.sql
  20261120233328_publication_score_rows_board_attested_freshness.sql
  20261120190124_register_bybit_mt5_live_board_exhaustion_contract.sql
  20261121185937_metric_trust_readiness_bounded_lineage_count.sql
  20261118135918_trust_evidence_retention.sql
  20261118144144_rank_publication_trust_requires_run.sql
  20261121201553_visible_sources_from_served_ranks.sql
  20261122152622_metric_trust_observation_lineage_per_statement.sql
  20261122154211_score_bundle_index_only_entry_counts.sql
  20261124114140_stale_source_hides_only_its_own_rows.sql
  20261118134316_raw_retention_backlog_census.sql
  20261120235710_register_blofin_spot_profile_capture_contract.sql
  20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql
)
readonly -a POSTDEPLOY_MIGRATIONS

# Classified but NEVER emitted by this runner: each is applied by itself through
# the ADR-023 single-file channel inside its own operational window, at the
# position docs/LAUNCH_CHECKLIST.md ("ADR-023 单文件迁移") fixes. They are not a
# phase of the ordered manifest; render-predeploy-one rejects them.
# - 20261111134937 replaces 20260803090000, the first file of the
#   record/publication chain (0900 -> 20260803100000 -> 20260803101000) that
#   docs/V1_EXECUTION_STATUS_2026-08-03.md interleaves with the RAW-only bridge
#   deploy and legacy-call drain. Predeploy 20260804052000 requires the copier
#   aggregate body it installs, so it must be exact before 052000 runs.
# - 20261111194845 replaces 20260715231500 (GMX PnL v2 PREPARE). It and the
#   CUTOVER 20260715232500 run back to back with GMX ingest and
#   compute-leaderboard stopped throughout, before the first predeploy file
#   (the slot the 2026-11-11 whole-database rehearsal proved).
ADR023_SINGLE_FILE_MIGRATIONS=(
  20261111194845_fix_gmx_source_contract_current_population.sql
  20261111134937_record_provenance_clocks_prod_reader.sql
)
readonly -a ADR023_SINGLE_FILE_MIGRATIONS

# Files that run through apply-single-file, in addition to POSTDEPLOY: the two
# ADR-023 single-file replacements and the followers that the checklist pins to
# the same slots (GMX CUTOVER right after its PREPARE; the record/publication
# chain right after 20261111134937). The 2026-11-14 rehearsal applied them in
# exactly this order at exactly these positions.
SINGLE_FILE_CHANNEL_MIGRATIONS=(
  20261111194845_fix_gmx_source_contract_current_population.sql
  20260715232500_quarantine_gmx_mixed_pnl.sql
  20261111134937_record_provenance_clocks_prod_reader.sql
  20260803100000_record_surface_publication_substrate.sql
  20260803101000_verified_position_history_publication_writer.sql
)

# ADR-023 amendment 2026-11-14. The value is deliberately not a secret: it is
# an attestation the operator must type, recorded in docs/DECISIONS.md, that
# the owner opened this window for a single serialized operator. Closing the
# window means changing this constant.
LAUNCH_WINDOW_ATTESTATION='adr-023-amendment-2026-11-14:single-operator-ordered-psql'

require_launch_window() {
  if [[ "${ARENA_LAUNCH_WINDOW_CONFIRM:-}" != "$LAUNCH_WINDOW_ATTESTATION" ]]; then
    echo "$1 requires an owner-opened launch window: set ARENA_LAUNCH_WINDOW_CONFIRM to the ADR-023 amendment attestation" >&2
    exit 2
  fi
}

# Recovery repairs the immutable application snapshot whose original cutover
# was exactly these 41 migrations. Keep this prerequisite frozen: later launch
# additions must not delay an independently resumable recovery.
RECOVERY_PREREQUISITE_MIGRATIONS=(
  20260716111600_atomic_group_application_review.sql
  20260716111700_group_application_read_write_boundary.sql
  20260716111800_group_creation_membership_write_boundary.sql
  20260716112100_channel_membership_server_boundary.sql
  20260716112300_atomic_content_report_submission.sql
  20260716113800_private_report_evidence_storage.sql
  20260716113900_atomic_group_membership.sql
  20260716114000_atomic_direct_message_send.sql
  20260716114100_atomic_group_member_moderation.sql
  20260716114200_atomic_direct_message_delete.sql
  20260716114500_atomic_comment_block_authorization.sql
  20260716114600_group_membership_identity_guard.sql
  20260716114700_atomic_group_join_requests.sql
  20260716114800_atomic_group_invites.sql
  20260716114900_atomic_deleted_account_group_purge.sql
  20260716152647_atomic_existing_channel_member_add.sql
  20260716154731_atomic_report_moderation_queue.sql
  20260716160000_report_moderation_operation_id.sql
  20260716161000_atomic_group_channel_create.sql
  20260716163000_atomic_single_report_resolution.sql
  20260716164000_group_application_operation_replay.sql
  20260716165000_atomic_group_mute.sql
  20260716170000_group_edit_application_operation_replay.sql
  20260716171000_group_member_read_privacy.sql
  20260716172000_group_subscriptions_server_authority.sql
  20260716173000_group_audit_log_read_boundary.sql
  20260716174000_group_subscription_expiry_owner_compat.sql
  20260716175000_atomic_group_dissolution.sql
  20260716176000_atomic_group_pass.sql
  20260716176100_group_premium_entitlement.sql
  20260716177000_atomic_pro_official_groups.sql
  20260716178000_user_profile_write_authority.sql
  20260716178100_atomic_post_child_interactions.sql
  20260716179000_user_profile_handle_contract.sql
  20260716179100_user_profile_read_audience.sql
  20260716179200_user_profile_wallet_authority.sql
  20260716190000_atomic_user_follow.sql
  20260716191000_atomic_user_block.sql
  20260717220000_notification_read_authority.sql
  20260717222500_notification_type_contract.sql
  20260716192000_social_edge_write_contract.sql
)
readonly -a RECOVERY_PREREQUISITE_MIGRATIONS

# These index migrations were present in the immutable target application
# snapshot but omitted from the original cutover manifest. PostgreSQL forbids
# CREATE INDEX CONCURRENTLY inside a transaction, so each file runs in its own
# resumable autocommit session and receives its exact-body ledger row only after
# every index postflight succeeds.
CONCURRENT_RECOVERY_MIGRATIONS=(
  20260716090000_add_account_export_cursor_indexes.sql
  20260716091500_add_security_export_cursor_indexes.sql
  20260716094500_add_bookmark_export_cursor_indexes.sql
  20260716101500_add_interaction_export_cursor_indexes.sql
  20260716110000_add_domain_export_cursor_indexes.sql
)
readonly -a CONCURRENT_RECOVERY_MIGRATIONS

# These transactional migrations were also present in the immutable target
# application snapshot but omitted from the original cutover manifest. Apply
# them only after all 41 original cutover ledger rows exist. Each migration and
# its exact-body ledger row commit together in a short, resumable transaction so
# unrelated table locks are never held across the whole recovery phase.
RECOVERY_MIGRATIONS=(
  20260716112000_exchange_connections_server_only.sql
  20260716112200_atomic_impression_recording.sql
  20260716083256_repair_legacy_exchange_logo_paths.sql
)
readonly -a RECOVERY_MIGRATIONS

# Never replay these. Each one names, in superseder_version, the ledger version
# whose presence makes it unnecessary:
# - 20260716104500: the separately applied 20260717230000 migration replaces its
#   policies with current-owner/current-resource audience checks and atomic
#   service-only writes.
# - 20260808001418: production already applied this body under ledger version
#   20260808071456 (docs/LAUNCH_REHEARSAL_2026-11-11.md).
# - The rest fail on production state and were replaced by 20261111* forward
#   migrations that run in the original's ordered slot (PR #400/#401; the
#   whole-database rehearsal passed 113/113 with these replacements).
# - 20260715231500 and 20260803090000 likewise fail on production state; their
#   replacements are ADR-023 single-file migrations (see above), not ordered.
# - 20261111134416 (the first replacement for 20260728124000) never finished on
#   production: one join over arena.leaderboard_entries looped ~1.4M times and
#   hit the file's own 2-minute statement_timeout. 20261115013558 is the same
#   body with that join order pinned and takes the slot.
# - 20261113150757 evaluates a correlated probe of arena.leaderboard_entries
#   for all 180,875 in-scope trader_stats rows (~6 min on production against
#   its own 5-minute statement_timeout). 20261115142045 is the same body with
#   the probe scoped to the 8,883 rows that can use it and takes the slot.
# - 20261113104533, 20261113151848 and 20261113151849 were applied to production
#   on 2026-11-13 through the ADR-023 MCP single-file channel, which records the
#   apply time as the ledger version (233535 / 233625 / 233643). Replaying
#   151848 would also fail there: it drops the trigger it created on
#   auth.users, and postgres holds TRIGGER on that table but does not own it.
SUPERSEDED_MIGRATIONS=(
  20260715231500_fix_gmx_source_contract.sql
  20260716104500_collection_read_write_boundaries.sql
  20260725017250_normalize_leaderboard_rank_max_drawdown.sql
  20260728122000_bitget_bots_canonical_timeframe.sql
  20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql
  20260729061000_tier_a_execution_claim_enforcement.sql
  20260729230000_token_ranking_generation_barrier.sql
  20260803090000_record_provenance_clocks.sql
  20260804043000_retire_legacy_token_rankings.sql
  20260804044000_freeze_legacy_position_history_relations.sql
  20260804045000_quarantine_bingx_rank_authority.sql
  20260808001418_atomic_group_channel_settings_update.sql
  20260817020000_rank_history_service_only_acl.sql
  20260817030000_trader_activities_publication_fence.sql
  20260817040000_notification_ranking_change_reader_fence.sql
  20260817050000_arena_bot_legacy_publication_isolation.sql
  20260817060000_trader_series_publication_isolation.sql
  20260817061000_legacy_raw_metric_publication_isolation.sql
  20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql
  20261113104533_trader_follows_hard_cap_lock.sql
  20261113150757_clean_derived_formal_win_rate.sql
  20261115170535_activate_local_public_sources.sql
  20261113151848_sync_user_profile_email_from_auth.sql
  20261113151849_auth_user_has_password_rpc.sql
)
readonly -a SUPERSEDED_MIGRATIONS

superseder_version() {
  case "$1" in
    20260715231500_fix_gmx_source_contract.sql) printf '%s' 20261111194845 ;;
    20260803090000_record_provenance_clocks.sql) printf '%s' 20261111134937 ;;
    20260716104500_collection_read_write_boundaries.sql) printf '%s' 20260717230000 ;;
    20260725017250_normalize_leaderboard_rank_max_drawdown.sql) printf '%s' 20261111185914 ;;
    20260728122000_bitget_bots_canonical_timeframe.sql) printf '%s' 20261111134210 ;;
    20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql) printf '%s' 20261115013558 ;;
    20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql) printf '%s' 20261115013558 ;;
    20260729061000_tier_a_execution_claim_enforcement.sql) printf '%s' 20261111192134 ;;
    20260729230000_token_ranking_generation_barrier.sql) printf '%s' 20261111133259 ;;
    20260804043000_retire_legacy_token_rankings.sql) printf '%s' 20261111133300 ;;
    20260804044000_freeze_legacy_position_history_relations.sql) printf '%s' 20261111135144 ;;
    20260804045000_quarantine_bingx_rank_authority.sql) printf '%s' 20261111135302 ;;
    20260808001418_atomic_group_channel_settings_update.sql) printf '%s' 20260808071456 ;;
    20260817020000_rank_history_service_only_acl.sql) printf '%s' 20261111132444 ;;
    20260817030000_trader_activities_publication_fence.sql) printf '%s' 20261111132445 ;;
    20260817040000_notification_ranking_change_reader_fence.sql) printf '%s' 20261111132446 ;;
    20260817050000_arena_bot_legacy_publication_isolation.sql) printf '%s' 20261111132447 ;;
    20260817060000_trader_series_publication_isolation.sql) printf '%s' 20261111132448 ;;
    20260817061000_legacy_raw_metric_publication_isolation.sql) printf '%s' 20261111132450 ;;
    20261113104533_trader_follows_hard_cap_lock.sql) printf '%s' 20261113233535 ;;
    20261113150757_clean_derived_formal_win_rate.sql) printf '%s' 20261115142045 ;;
    20261115170535_activate_local_public_sources.sql) printf '%s' 20261116204359 ;;
    20261113151848_sync_user_profile_email_from_auth.sql) printf '%s' 20261113233625 ;;
    20261113151849_auth_user_has_password_rpc.sql) printf '%s' 20261113233643 ;;
    *)
      echo "superseded migration has no superseder: $1" >&2
      exit 1
      ;;
  esac
}

require_environment() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required" >&2
    exit 1
  fi
}

# PGDATABASE is a literal database name, not a connection-URI expansion point.
# Parse DATABASE_URL in the wrapper and pass only individual libpq environment
# variables to psql. The credential never enters psql's argv.
psql_with_database() {
  node "$ROOT/scripts/maintenance/psql-from-database-url.mjs" "$@"
}

require_session_connection() {
  node "$ROOT/scripts/maintenance/psql-from-database-url.mjs" \
    --check-session-connection
}

migration_version() {
  printf '%s' "${1%%_*}"
}

migration_name() {
  local without_extension="${1%.sql}"
  printf '%s' "${without_extension#*_}"
}

migration_body_sha256() {
  local migration="$1"
  local cached_hash="$ORDERED_PREDEPLOY_SNAPSHOT_DIR/.sha256-$migration"

  if [[ -n "$ORDERED_PREDEPLOY_SNAPSHOT_DIR" && -f "$cached_hash" ]]; then
    perl -0pe '' "$cached_hash"
    return
  fi
  shasum -a 256 "$MIGRATIONS_DIR/$migration" | awk '{print $1}'
}

validate_transactional_migration_file() {
  local migration="$1"
  local file="$MIGRATIONS_DIR/$migration"
  local begin_count
  local commit_count
  local transaction_mode_count
  local repeatable_read_count
  local read_committed_count

  [[ -f "$file" ]] || {
    echo "migration file is missing: $migration" >&2
    exit 1
  }
  begin_count="$(grep -c '^BEGIN;$' "$file" || true)"
  commit_count="$(grep -c '^COMMIT;$' "$file" || true)"
  transaction_mode_count="$(grep -c '^SET TRANSACTION ' "$file" || true)"
  repeatable_read_count="$(
    grep -c '^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$' "$file" || true
  )"
  read_committed_count="$(
    grep -c '^SET TRANSACTION ISOLATION LEVEL READ COMMITTED;$' "$file" || true
  )"
  transaction_mode_count="${transaction_mode_count:-0}"
  repeatable_read_count="${repeatable_read_count:-0}"
  read_committed_count="${read_committed_count:-0}"
  # Either one exact outer BEGIN/COMMIT (stripped below so the runner owns the
  # transaction) or none at all: a file with no transaction statements is
  # already a plain body the runner can wrap. A lone BEGIN or COMMIT is not.
  if ! { [[ "$begin_count" == "1" && "$commit_count" == "1" ]] ||
    [[ "$begin_count" == "0" && "$commit_count" == "0" ]]; }; then
    echo "migration must contain one exact outer BEGIN/COMMIT or none: $migration" >&2
    exit 1
  fi
  if ((
    transaction_mode_count != repeatable_read_count + read_committed_count
    || repeatable_read_count + read_committed_count > 1
  )); then
    echo "migration has an unsupported transaction mode: $migration" >&2
    exit 1
  fi
}

transaction_begin_for_migrations() {
  local migration
  local begin_statement='BEGIN;'
  local isolation_level=''

  for migration in "$@"; do
    validate_transactional_migration_file "$migration"
    if grep -q '^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$' \
      "$MIGRATIONS_DIR/$migration"; then
      if [[ -n "$isolation_level" && "$isolation_level" != 'REPEATABLE READ' ]]; then
        echo "migration batch mixes incompatible transaction isolation levels" >&2
        exit 1
      fi
      isolation_level='REPEATABLE READ'
    elif grep -q '^SET TRANSACTION ISOLATION LEVEL READ COMMITTED;$' \
      "$MIGRATIONS_DIR/$migration"; then
      if [[ -n "$isolation_level" && "$isolation_level" != 'READ COMMITTED' ]]; then
        echo "migration batch mixes incompatible transaction isolation levels" >&2
        exit 1
      fi
      isolation_level='READ COMMITTED'
    fi
  done

  if [[ -n "$isolation_level" ]]; then
    begin_statement="BEGIN ISOLATION LEVEL $isolation_level;"
  fi

  printf '%s' "$begin_statement"
}

validate_concurrent_migration_file() {
  local migration="$1"
  local file="$MIGRATIONS_DIR/$migration"
  local begin_count
  local commit_count
  local concurrent_count

  [[ -f "$file" ]] || {
    echo "migration file is missing: $migration" >&2
    exit 1
  }
  begin_count="$(grep -c '^BEGIN;$' "$file" || true)"
  commit_count="$(grep -c '^COMMIT;$' "$file" || true)"
  concurrent_count="$(grep -c '^CREATE INDEX CONCURRENTLY ' "$file" || true)"
  if ((begin_count != 0 || commit_count != 0 || concurrent_count < 1)); then
    echo "concurrent migration must have CREATE INDEX CONCURRENTLY and no outer transaction: $migration" >&2
    exit 1
  fi
}

emit_ledger_absence_preflight() {
  local version="$1"
  local tag="arena_ledger_preflight_${version}"
  printf '%s\n' \
    "DO \$$tag\$" \
    'BEGIN' \
    "  IF EXISTS (" \
    "    SELECT 1 FROM supabase_migrations.schema_migrations" \
    "    WHERE version = '$version'" \
    "  ) THEN" \
    "    RAISE EXCEPTION 'migration ledger version already exists: $version';" \
    "  END IF;" \
    'END' \
    "\$$tag\$;"
}

emit_ledger_exact_preflight() {
  local migration="$1"
  local phase="${2:-migration}"
  local version
  local name
  local hash
  local tag
  local file="$MIGRATIONS_DIR/$migration"

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(migration_body_sha256 "$migration")"
  tag="arena_ledger_exact_${version}"

  # Re-attest and lock an exact ledger row inside the migration transaction.
  # The host-side status check decides whether to emit a migration, but it
  # cannot protect the interval before psql begins the transaction.
  printf '%s\n' \
    "DO \$$tag\$" \
    'BEGIN' \
    '  PERFORM 1' \
    '  FROM supabase_migrations.schema_migrations AS ledger' \
    "  WHERE ledger.version = '$version'" \
    "    AND ledger.name = '$name'" \
    "    AND ledger.created_by = 'codex'" \
    "    AND ledger.idempotency_key = 'codex:$version:$hash'" \
    '    AND pg_catalog.array_length(ledger.statements, 1) = 1' \
    '    AND pg_catalog.encode(' \
    "      extensions.digest(ledger.statements[1], 'sha256')," \
    "      'hex'" \
    "    ) = '$hash'" \
    '  FOR SHARE;' \
    '  IF NOT FOUND THEN' \
    "    RAISE EXCEPTION '$phase requires exact ledger: $migration';" \
    '  END IF;' \
    'END' \
    "\$$tag\$;"
}

emit_ledger_insert() {
  local migration="$1"
  local version
  local name
  local hash
  local tag
  local file="$MIGRATIONS_DIR/$migration"

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(migration_body_sha256 "$migration")"
  tag="arena_ledger_body_${version}"

  if grep -F -q "\$$tag\$" "$file"; then
    echo "ledger dollar-quote tag collides with migration: $migration" >&2
    exit 1
  fi

  printf '%s' \
    "INSERT INTO supabase_migrations.schema_migrations" \
    " (version, statements, name, created_by, idempotency_key)" \
    " VALUES ('$version', ARRAY[\$$tag\$"
  perl -0pe '' "$file"
  printf '%s\n' \
    "\$$tag\$]::text[], '$name', 'codex'," \
    " 'codex:$version:$hash');"
}

emit_migration() {
  local migration="$1"
  local version
  local file="$MIGRATIONS_DIR/$migration"
  validate_transactional_migration_file "$migration"
  version="$(migration_version "$migration")"

  printf '\\echo APPLY %s\n' "$migration"
  emit_ledger_absence_preflight "$version"
  # The exact outer COMMIT may be followed by rollback documentation. Strip
  # the validated transaction statements wherever their exact lines occur;
  # otherwise a dry run could change isolation too late or commit before the
  # runner emits its terminal ROLLBACK.
  perl -0pe \
    's/(^|\n)BEGIN;\n/$1/; s/(^|\n)SET TRANSACTION ISOLATION LEVEL (?:REPEATABLE READ|READ COMMITTED);\n/$1/; s/(^|\n)COMMIT;(?:\n|\z)/$1/' \
    "$file"
  printf '%s\n' \
    'SET LOCAL search_path TO DEFAULT;' \
    'SET LOCAL lock_timeout TO DEFAULT;' \
    'SET LOCAL statement_timeout TO DEFAULT;'
  emit_ledger_insert "$migration"
}

emit_pending_migration() {
  local migration="$1"
  local state

  validate_transactional_migration_file "$migration"
  state="$(ledger_state "$migration")"
  if [[ "$state" == "exact" ]]; then
    printf '\\echo SKIP exact ledger: %s\n' "$migration"
    emit_ledger_exact_preflight "$migration"
    return
  fi
  if [[ "$state" != "missing" ]]; then
    echo "refusing drifted ledger: $migration" >&2
    exit 1
  fi
  emit_migration "$migration"
}

require_exact_migrations() {
  local phase="$1"
  shift
  local migration
  local state

  for migration in "$@"; do
    validate_transactional_migration_file "$migration"
    state="$(ledger_state "$migration")"
    if [[ "$state" != "exact" ]]; then
      echo "$phase requires exact ledger: $migration ($state)" >&2
      exit 1
    fi
  done
}

require_predeploy_target() {
  local target="$1"
  local migration

  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    if [[ "$migration" == "$target" ]]; then
      return
    fi
  done
  echo "predeploy target is not in the ordered candidate manifest: $target" >&2
  exit 2
}

require_tracked_migration() {
  local migration="$1"
  local relative_path="supabase/migrations/$migration"

  if ! git -C "$ROOT" ls-files --error-unmatch -- "$relative_path" >/dev/null 2>&1; then
    echo "predeploy target must be tracked by git: $relative_path" >&2
    exit 1
  fi
}

require_production_project_ref() {
  EXPECTED_PROJECT_REF="$PRODUCTION_PROJECT_REF" node <<'NODE'
const expected = process.env.EXPECTED_PROJECT_REF
let parsed
try {
  parsed = new URL(process.env.DATABASE_URL)
} catch {
  process.stderr.write('single predeploy requires a valid production DATABASE_URL\n')
  process.exit(1)
}
const host = parsed.hostname.toLowerCase()
let username
let database
try {
  username = decodeURIComponent(parsed.username)
  database = decodeURIComponent(parsed.pathname)
} catch {
  process.stderr.write('single predeploy requires a valid production DATABASE_URL\n')
  process.exit(1)
}
const isPostgresProtocol = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
const isSessionPort = parsed.port === '5432'
const isPostgresDatabase = database === '/postgres'
const sslModes = parsed.searchParams.getAll('sslmode')
const hasVerifiedTls = sslModes.length === 1 && sslModes[0] === 'verify-full'
const hasOnlyApprovedParameters = [...parsed.searchParams.keys()].every(
  (parameter) => parameter === 'sslmode'
)
const isDirect = host === `db.${expected}.supabase.co` && username === 'postgres'
const isPooler =
  host === 'aws-0-us-west-2.pooler.supabase.com' && username === `postgres.${expected}`
if (
  !isPostgresProtocol ||
  !isSessionPort ||
  !isPostgresDatabase ||
  !hasVerifiedTls ||
  !hasOnlyApprovedParameters ||
  (!isDirect && !isPooler)
) {
  process.stderr.write('single predeploy requires the exact production session endpoint\n')
  process.exit(1)
}
NODE
}

require_release_provenance() {
  local migration="$1"
  local head_sha
  local origin_main_sha
  local dirty

  require_tracked_migration "$migration"
  # Cleanliness is an operator guard, not artifact provenance: index flags can
  # hide worktree edits. Snapshot bytes come from the verified HEAD object, so
  # hidden or concurrent worktree changes can never enter the preview.
  dirty="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
  if [[ -n "$dirty" ]]; then
    echo "single predeploy requires a clean worktree" >&2
    exit 1
  fi
  head_sha="$(git -C "$ROOT" rev-parse --verify HEAD)"
  origin_main_sha="$(git -C "$ROOT" rev-parse --verify refs/remotes/origin/main)"
  if [[ "$head_sha" != "$origin_main_sha" ]]; then
    echo "single predeploy requires HEAD to equal the pushed origin/main SHA" >&2
    exit 1
  fi
  ORDERED_PREDEPLOY_RELEASE_SHA="$head_sha"
  require_live_origin_main
}

require_live_origin_main() {
  local remote_main_line
  local remote_main_sha

  if [[ ! "$ORDERED_PREDEPLOY_RELEASE_SHA" =~ ^[0-9a-f]{40,64}$ ]]; then
    echo "single predeploy has no verified release SHA" >&2
    exit 1
  fi
  if ! remote_main_line="$(
    GIT_TERMINAL_PROMPT=0 git -C "$ROOT" ls-remote --exit-code origin refs/heads/main 2>/dev/null
  )"; then
    echo "single predeploy could not verify the live origin/main SHA" >&2
    exit 1
  fi
  remote_main_sha="$(printf '%s\n' "$remote_main_line" | awk 'NR == 1 {print $1}')"
  if [[ ! "$remote_main_sha" =~ ^[0-9a-f]{40,64}$ || \
    "$ORDERED_PREDEPLOY_RELEASE_SHA" != "$remote_main_sha" ]]; then
    echo "single predeploy release no longer equals the live pushed origin/main SHA" >&2
    exit 1
  fi
}

cleanup_ordered_predeploy_snapshot() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$ORDERED_PREDEPLOY_SNAPSHOT_DIR" && \
    -d "$ORDERED_PREDEPLOY_SNAPSHOT_DIR" ]]; then
    chmod -R u+w "$ORDERED_PREDEPLOY_SNAPSHOT_DIR" 2>/dev/null || true
    rm -rf -- "$ORDERED_PREDEPLOY_SNAPSHOT_DIR"
  fi
  exit "$status"
}

snapshot_ordered_predeploy_manifest() {
  local target="$1"
  local migration
  local relative_path
  local snapshot
  local found=false

  if [[ ! "$ORDERED_PREDEPLOY_RELEASE_SHA" =~ ^[0-9a-f]{40,64}$ ]]; then
    echo "cannot snapshot predeploy without a verified release SHA" >&2
    exit 1
  fi
  snapshot="$(mktemp -d "${TMPDIR:-/tmp}/arena-predeploy-snapshot.XXXXXX")"
  ORDERED_PREDEPLOY_SNAPSHOT_DIR="$snapshot"
  trap cleanup_ordered_predeploy_snapshot EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    relative_path="supabase/migrations/$migration"
    if ! git -C "$ROOT" show \
      "$ORDERED_PREDEPLOY_RELEASE_SHA:$relative_path" >"$snapshot/$migration"; then
      echo "verified release is missing migration object: $relative_path" >&2
      exit 1
    fi
    shasum -a 256 "$snapshot/$migration" | awk '{print $1}' \
      >"$snapshot/.sha256-$migration"
    chmod 0400 "$snapshot/$migration" "$snapshot/.sha256-$migration"
    if [[ "$migration" == "$target" ]]; then
      found=true
      break
    fi
  done
  if [[ "$found" != "true" ]]; then
    echo "predeploy target was not captured in the verified release snapshot: $target" >&2
    exit 1
  fi
  chmod 0500 "$snapshot"
  MIGRATIONS_DIR="$snapshot"
}

prepare_ordered_predeploy_artifacts() {
  local target="$1"

  require_predeploy_target "$target"
  require_release_provenance "$target"
  snapshot_ordered_predeploy_manifest "$target"
}

ORDERED_PREDEPLOY_PREREQUISITES=()

prepare_ordered_predeploy_preview_target() {
  local target="$1"
  local migration

  require_predeploy_target "$target"
  ORDERED_PREDEPLOY_PREREQUISITES=()
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    validate_transactional_migration_file "$migration"
    if [[ "$migration" == "$target" ]]; then
      return
    fi
    ORDERED_PREDEPLOY_PREREQUISITES+=("$migration")
  done

  echo "predeploy preview target is not in the ordered manifest: $target" >&2
  exit 1
}

# Database-aware target selection is exercised only by the disposable PG17
# harness. No production CLI command wires this helper to a SQL write path.
prepare_ordered_predeploy_target() {
  local target="$1"
  local migration
  local state

  require_predeploy_target "$target"
  ORDERED_PREDEPLOY_PREREQUISITES=()
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    validate_transactional_migration_file "$migration"
    state="$(ledger_state "$migration")"
    case "$state" in
      exact)
        ORDERED_PREDEPLOY_PREREQUISITES+=("$migration")
        ;;
      missing)
        if [[ "$migration" != "$target" ]]; then
          echo \
            "predeploy target must be the first missing migration: requested $target, first missing $migration" \
            >&2
          exit 1
        fi
        return
        ;;
      *)
        echo "refusing drifted predeploy ledger before target: $migration ($state)" >&2
        exit 1
        ;;
    esac
  done

  echo "predeploy manifest has no missing migration; requested target is not pending: $target" >&2
  exit 1
}

require_tip_checkout_cutover_attestation() {
  if [[ "${ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM:-}" != \
    "$TIP_CHECKOUT_CUTOVER_ATTESTATION" ]]; then
    echo \
      "Tip checkout lifecycle apply is blocked: freeze the old Tip checkout route, verify pending Tips are zero, then set ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM=$TIP_CHECKOUT_CUTOVER_ATTESTATION" \
      >&2
    exit 1
  fi
}

require_tip_checkout_cutover_for_target() {
  local migration="$1"
  local version
  local protected_version
  version="$(migration_version "$migration")"
  for protected_version in "${TIP_CHECKOUT_CUTOVER_VERSIONS[@]}"; do
    if [[ "$version" == "$protected_version" ]]; then
      require_tip_checkout_cutover_attestation
      return
    fi
  done
}

emit_concurrent_migration() {
  local migration="$1"
  local version
  local file="$MIGRATIONS_DIR/$migration"
  local lock_key

  validate_concurrent_migration_file "$migration"
  version="$(migration_version "$migration")"
  lock_key="arena:concurrent-recovery:$version"

  printf '\\echo APPLY %s\n' "$migration"
  printf '%s\n' \
    "SELECT pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');'
  emit_ledger_absence_preflight "$version"
  perl -0pe '' "$file"
  emit_ledger_insert "$migration"
  printf '%s\n' \
    "SELECT pg_catalog.pg_advisory_unlock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');'
}

ledger_state() {
  local migration="$1"
  local version
  local name
  local hash

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(migration_body_sha256 "$migration")"

  psql_with_database -X -q -v ON_ERROR_STOP=1 -Atc \
    "SELECT CASE
       WHEN ledger.version IS NULL THEN 'missing'
       WHEN ledger.name = '$name'
        AND ledger.created_by = 'codex'
        AND ledger.idempotency_key = 'codex:$version:$hash'
        AND pg_catalog.array_length(ledger.statements, 1) = 1
        AND pg_catalog.encode(
          extensions.digest(ledger.statements[1], 'sha256'),
          'hex'
        ) = '$hash'
       THEN 'exact'
       ELSE 'drift'
     END
     FROM (SELECT 1) AS seed
     LEFT JOIN supabase_migrations.schema_migrations AS ledger
       ON ledger.version = '$version';"
}

emit_predeploy_ledger_requirement() {
  local migration
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    emit_ledger_exact_preflight "$migration" 'postdeploy'
  done
}

emit_cutover_ledger_requirement() {
  local migration
  for migration in "${RECOVERY_PREREQUISITE_MIGRATIONS[@]}"; do
    emit_ledger_exact_preflight "$migration" 'recovery'
  done
}

emit_transaction() {
  local terminal="$1"
  shift
  local migration
  local begin_statement

  begin_statement="$(transaction_begin_for_migrations "$@")"
  printf '%s\n' \
    "$begin_statement" \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "$@"; do
    emit_pending_migration "$migration"
  done
  printf '%s\n' "$terminal;"
}

emit_ordered_predeploy_transaction() {
  local terminal="$1"
  local target="$2"
  local migration
  local begin_statement
  local lock_key='arena:production-schema-migration'

  begin_statement="$(transaction_begin_for_migrations "$target")"
  # Take the session lock before BEGIN. A repeatable-read target must not
  # establish its snapshot and then wait behind another ordered apply.
  printf '%s\n' \
    "SET lock_timeout = '10s';" \
    "SET statement_timeout = '15min';" \
    "SELECT pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');' \
    "$begin_statement" \
    "SET LOCAL lock_timeout = '10s';" \
    "SET LOCAL statement_timeout = '15min';" \
    "SET LOCAL idle_in_transaction_session_timeout = '60s';" \
    'LOCK TABLE supabase_migrations.schema_migrations' \
    '  IN SHARE ROW EXCLUSIVE MODE;' \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "${ORDERED_PREDEPLOY_PREREQUISITES[@]}"; do
    emit_ledger_exact_preflight "$migration" 'ordered predeploy'
  done
  emit_migration "$target"
  printf '%s\n' \
    "$terminal;" \
    'DO $arena_ordered_predeploy_unlock$' \
    'BEGIN' \
    '  IF NOT pg_catalog.pg_advisory_unlock(' \
    "    pg_catalog.hashtextextended('$lock_key', 0)" \
    '  ) THEN' \
    "    RAISE EXCEPTION 'ordered predeploy advisory unlock failed';" \
    '  END IF;' \
    'END' \
    '$arena_ordered_predeploy_unlock$;'
}

emit_all_dry_run() {
  local migration
  local begin_statement

  begin_statement="$(
    transaction_begin_for_migrations \
      "${PREDEPLOY_MIGRATIONS[@]}" \
      "${POSTDEPLOY_MIGRATIONS[@]}" \
      "${RECOVERY_MIGRATIONS[@]}"
  )"
  printf '%s\n' \
    "$begin_statement" \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  emit_predeploy_ledger_requirement
  for migration in "${POSTDEPLOY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  emit_cutover_ledger_requirement
  for migration in "${RECOVERY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  printf '%s\n' 'ROLLBACK;'
}

status() {
  local migration
  local phase
  {
    printf '%s\n' \
      'WITH target(version, phase, ordinal, expected_name, expected_hash, superseder) AS (VALUES'
    local ordinal=0
    local separator=''
    for phase in predeploy single-file postdeploy concurrent-recovery recovery quarantined superseded; do
      local -a phase_migrations
      if [[ "$phase" == "predeploy" ]]; then
        phase_migrations=("${PREDEPLOY_MIGRATIONS[@]}")
      elif [[ "$phase" == "single-file" ]]; then
        phase_migrations=("${ADR023_SINGLE_FILE_MIGRATIONS[@]}")
      elif [[ "$phase" == "postdeploy" ]]; then
        phase_migrations=("${POSTDEPLOY_MIGRATIONS[@]}")
      elif [[ "$phase" == "concurrent-recovery" ]]; then
        phase_migrations=("${CONCURRENT_RECOVERY_MIGRATIONS[@]}")
      elif [[ "$phase" == "recovery" ]]; then
        phase_migrations=("${RECOVERY_MIGRATIONS[@]}")
      elif [[ "$phase" == "quarantined" ]]; then
        phase_migrations=("${QUARANTINED_PREDEPLOY_MIGRATIONS[@]}")
      else
        phase_migrations=("${SUPERSEDED_MIGRATIONS[@]}")
      fi
      for migration in "${phase_migrations[@]}"; do
        ordinal=$((ordinal + 1))
        local version
        local name
        local hash
        local superseder='NULL'
        version="$(migration_version "$migration")"
        name="$(migration_name "$migration")"
        hash="$(migration_body_sha256 "$migration")"
        if [[ "$phase" == "superseded" ]]; then
          superseder="$(superseder_version "$migration")"
          superseder="'$superseder'"
        fi
        printf "%s  ('%s', '%s', %d, '%s', '%s', %s)" \
          "$separator" "$version" "$phase" "$ordinal" "$name" "$hash" "$superseder"
        separator=$',\n'
      done
    done
    printf '%s\n' \
      ')' \
      "SELECT target.phase || '|' || target.version || '|' ||" \
      "  CASE" \
      "    WHEN target.phase = 'superseded' AND EXISTS (" \
      "      SELECT 1 FROM supabase_migrations.schema_migrations AS replacement" \
      "      WHERE replacement.version = target.superseder" \
      "    ) THEN 'superseded-by-' || target.superseder" \
      "    WHEN target.phase = 'superseded' THEN 'missing-superseder'" \
      "    WHEN target.phase = 'quarantined' AND NOT EXISTS (" \
      "      SELECT 1 FROM supabase_migrations.schema_migrations AS candidate" \
      "      WHERE candidate.name = target.expected_name" \
      "         OR candidate.version = target.version" \
      "    ) THEN 'quarantined-unapplied'" \
      "    WHEN target.phase = 'quarantined' AND (" \
      "      SELECT pg_catalog.count(*)" \
      "      FROM supabase_migrations.schema_migrations AS candidate" \
      "      WHERE candidate.name = target.expected_name" \
      "         OR candidate.version = target.version" \
      "    ) = 1 AND EXISTS (" \
      "      SELECT 1 FROM supabase_migrations.schema_migrations AS candidate" \
      "      WHERE candidate.name = target.expected_name" \
      "        AND pg_catalog.array_length(candidate.statements, 1) = 1" \
      "        AND pg_catalog.encode(" \
      "          extensions.digest(candidate.statements[1], 'sha256')," \
      "          'hex'" \
      "        ) = target.expected_hash" \
      "    ) THEN 'quarantined-exact-forward-repair-required'" \
      "    WHEN target.phase = 'quarantined' THEN 'quarantined-drift'" \
      "    WHEN ledger.version IS NULL THEN 'missing'" \
      "    WHEN ledger.name = target.expected_name" \
      "      AND ledger.created_by = 'codex'" \
      "      AND ledger.idempotency_key =" \
      "        'codex:' || target.version || ':' || target.expected_hash" \
      "      AND pg_catalog.array_length(ledger.statements, 1) = 1" \
      "      AND pg_catalog.encode(" \
      "        extensions.digest(ledger.statements[1], 'sha256')," \
      "        'hex'" \
      "      ) = target.expected_hash" \
      "    THEN 'exact'" \
      "    ELSE 'drift'" \
      "  END" \
      'FROM target' \
      'LEFT JOIN supabase_migrations.schema_migrations AS ledger USING (version)' \
      'ORDER BY target.ordinal;'
  } | psql_with_database -X -q -v ON_ERROR_STOP=1 -At
}

run_sql_stream() {
  psql_with_database -X -q -v ON_ERROR_STOP=1
}

require_single_file_target() {
  local target="$1"
  local migration
  for migration in "${SINGLE_FILE_CHANNEL_MIGRATIONS[@]}" "${POSTDEPLOY_MIGRATIONS[@]}"; do
    if [[ "$migration" == "$target" ]]; then
      return
    fi
  done
  echo "apply-single-file target is not a single-file or postdeploy migration: $target" >&2
  exit 2
}

# Bytes come from the verified release object, never the mutable worktree.
snapshot_single_file() {
  local target="$1"
  local snapshot
  local relative_path="supabase/migrations/$target"

  snapshot="$(mktemp -d "${TMPDIR:-/tmp}/arena-single-file-snapshot.XXXXXX")"
  ORDERED_PREDEPLOY_SNAPSHOT_DIR="$snapshot"
  trap cleanup_ordered_predeploy_snapshot EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! git -C "$ROOT" show "$ORDERED_PREDEPLOY_RELEASE_SHA:$relative_path" >"$snapshot/$target"; then
    echo "verified release is missing migration object: $relative_path" >&2
    exit 1
  fi
  shasum -a 256 "$snapshot/$target" | awk '{print $1}' >"$snapshot/.sha256-$target"
  chmod 0400 "$snapshot/$target" "$snapshot/.sha256-$target"
  chmod 0500 "$snapshot"
  MIGRATIONS_DIR="$snapshot"
}

# One file, one transaction, under the same session advisory lock and ledger
# lock as the ordered channel: refuses a version already in the ledger, runs
# the body, records the exact body and hash.
emit_single_file_transaction() {
  local migration="$1"
  local begin_statement
  local lock_key='arena:production-schema-migration'

  begin_statement="$(transaction_begin_for_migrations "$migration")"
  printf '%s\n' \
    "SET lock_timeout = '10s';" \
    "SET statement_timeout = '15min';" \
    "SELECT pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');' \
    "$begin_statement" \
    "SET LOCAL lock_timeout = '10s';" \
    "SET LOCAL statement_timeout = '15min';" \
    "SET LOCAL idle_in_transaction_session_timeout = '60s';" \
    'LOCK TABLE supabase_migrations.schema_migrations' \
    '  IN SHARE ROW EXCLUSIVE MODE;' \
    "SET LOCAL client_min_messages = 'warning';"
  emit_migration "$migration"
  printf '%s\n' \
    'COMMIT;' \
    'DO $arena_single_file_unlock$' \
    'BEGIN' \
    '  IF NOT pg_catalog.pg_advisory_unlock(' \
    "    pg_catalog.hashtextextended('$lock_key', 0)" \
    '  ) THEN' \
    "    RAISE EXCEPTION 'single-file advisory unlock failed';" \
    '  END IF;' \
    'END' \
    '$arena_single_file_unlock$;'
}

main() {
  local command="${1:-status}"

  # ADR-023 approves only the Supabase MCP production channel. Reject every
  # psql-backed schema write before environment parsing, ledger access or a
  # psql connection; no public environment literal can activate these paths.
  case "$command" in
    apply-concurrent-recovery | apply-predeploy | apply-postdeploy | apply-recovery)
      echo "$command is disabled by ADR-023 pending shared production-channel serialization" >&2
      exit 2
      ;;
    apply-predeploy-one | apply-single-file)
      # Fail closed before environment parsing, git or psql unless the owner
      # opened the window (ADR-023 amendment 2026-11-14).
      require_launch_window "$command"
      ;;
    dry-run-all | dry-run-recovery)
      echo "$command is disabled because rollback is not a side-effect-free dry run" >&2
      exit 2
      ;;
  esac

  case "$command" in
    status)
      require_environment
      status
      ;;
    dry-run-predeploy-one | render-predeploy-one)
      if [[ "$#" != "2" ]]; then
        echo "usage: $0 $command <manifest-migration.sql>" >&2
        exit 2
      fi
      local migration="$2"
      prepare_ordered_predeploy_artifacts "$migration"
      prepare_ordered_predeploy_preview_target "$migration"
      # The manifest can take time to render. Refuse a preview labeled with a
      # release that ceased to be current during preparation.
      require_live_origin_main
      printf '\\echo VERIFIED_RELEASE %s\n' "$ORDERED_PREDEPLOY_RELEASE_SHA"
      emit_ordered_predeploy_transaction 'ROLLBACK' "$migration"
      ;;
    apply-predeploy-one)
      if [[ "$#" != "2" ]]; then
        echo "usage: $0 $command <manifest-migration.sql>" >&2
        exit 2
      fi
      local migration="$2"
      require_environment
      require_production_project_ref
      require_session_connection
      prepare_ordered_predeploy_artifacts "$migration"
      # Database-aware: the target must be the first missing manifest entry and
      # every earlier entry must be exact in the ledger.
      prepare_ordered_predeploy_target "$migration"
      require_tip_checkout_cutover_for_target "$migration"
      require_live_origin_main
      printf 'APPLY %s at release %s\n' "$migration" "$ORDERED_PREDEPLOY_RELEASE_SHA" >&2
      emit_ordered_predeploy_transaction 'COMMIT' "$migration" | run_sql_stream
      ;;
    apply-single-file)
      if [[ "$#" != "2" ]]; then
        echo "usage: $0 $command <single-file-or-postdeploy-migration.sql>" >&2
        exit 2
      fi
      local migration="$2"
      require_single_file_target "$migration"
      require_environment
      require_production_project_ref
      require_session_connection
      require_release_provenance "$migration"
      snapshot_single_file "$migration"
      validate_transactional_migration_file "$migration"
      require_live_origin_main
      printf 'APPLY %s at release %s\n' "$migration" "$ORDERED_PREDEPLOY_RELEASE_SHA" >&2
      emit_single_file_transaction "$migration" | run_sql_stream
      ;;
    *)
      echo "usage: $0 {status|render-predeploy-one|apply-predeploy-one|apply-single-file|dry-run-predeploy-one|dry-run-all|dry-run-recovery|apply-concurrent-recovery|apply-predeploy|apply-predeploy-one|apply-postdeploy|apply-recovery}" >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
