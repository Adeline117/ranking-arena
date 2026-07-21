import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721120000_metric_trust_shadow_gate.sql'),
  'utf8'
)

describe('metric trust shadow gate migration', () => {
  it('is atomic and does not cut over the live score view or RPC', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW arena\.score_inputs\b/)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json/)
    expect(migration).not.toMatch(/DROP\s+(?:VIEW|FUNCTION|TABLE)/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('keeps trust data private, append-only, and source contracts read-only', () => {
    for (const relation of [
      'metric_source_contracts',
      'metric_trust_runs',
      'metric_trust_observations',
      'metric_trust_artifacts',
    ]) {
      expect(migration).toContain(`ALTER TABLE arena.${relation} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`REVOKE ALL ON arena.${relation}`)
    }
    expect(migration).toContain('GRANT SELECT ON arena.metric_source_contracts TO service_role')
    expect(migration).toContain('GRANT SELECT, INSERT ON arena.metric_trust_runs TO service_role')
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON arena.metric_trust_observations TO service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON arena.metric_trust_artifacts TO service_role'
    )
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE)[^;]*metric_(?:source_contracts|trust_)/i
    )
    expect(migration).toContain('REVOKE ALL ON FUNCTION arena.validate_metric_trust_observation()')
    expect(migration).toContain('reject_direct_metric_trust_mutation')
    expect(migration).toContain('pg_catalog.pg_trigger_depth() <= 1')
    expect(migration).toContain('metric_trust_artifacts_reject_truncate')
  })

  it('binds observations to a passed source population and immutable RAW run', () => {
    expect(migration).toContain('FOREIGN KEY (snapshot_scraped_at, snapshot_id, trader_id)')
    expect(migration).toContain(
      'REFERENCES arena.leaderboard_entries (scraped_at, snapshot_id, trader_id)'
    )
    expect(migration).toContain(
      'raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE CASCADE'
    )
    expect(migration).toContain('v_raw_source_run_id IS DISTINCT FROM v_source_run_id')
    expect(migration).toContain('v_raw_role IS DISTINCT FROM NEW.role')
    expect(migration).toContain('v_raw_hash IS DISTINCT FROM NEW.content_hash')
    expect(migration).toContain(
      "v_raw_meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'"
    )
    expect(migration).toContain('protect_metric_trust_raw_object_before_write')
    expect(migration).toContain(
      'NEW.population_raw_object_id IS DISTINCT FROM v_snapshot_raw_object_id'
    )
    expect(migration).toContain('v_manifest_hash IS DISTINCT FROM NEW.source_run_id')
    expect(migration).toContain("v_manifest_role IS DISTINCT FROM 'population_manifest'")
  })

  it('seeds the reviewed Binance board/profile and Wallet contracts', () => {
    for (const token of [
      'data.list[].roi',
      'data.list[].pnl',
      'performance.roi',
      'performance.pnl',
      'board.data.data[].realizedPnlPercent',
      'board.data.data[].realizedPnl',
      'rebuild.roi',
    ]) {
      expect(migration).toContain(token)
    }
    expect(migration).toContain('expected 7 initial metric source contracts')
    expect(migration).toContain("ARRAY['USD']::text[]")
    expect(migration).toContain("ARRAY['USDT']::text[]")
  })

  it('fails closed on quality, ownership, time, and required RAW roles', () => {
    const shadow = migration.slice(
      migration.indexOf('CREATE VIEW arena.metric_rankable_observations'),
      migration.indexOf('CREATE VIEW arena.metric_rankable_input_sets_shadow')
    )
    expect(shadow).toContain("observation.quality = 'complete'")
    expect(shadow).toContain("source.status = 'active'")
    expect(shadow).toContain("source.serving_mode = 'serving'")
    expect(shadow).toContain('source.currency = observation.currency')
    expect(shadow).toContain("observation.population_state = 'verified'")
    expect(shadow).toContain("observation.window_state = 'verified'")
    expect(shadow).toContain("observation.unit_state = 'verified'")
    expect(shadow).toContain("observation.freshness_state = 'verified'")
    expect(shadow).toContain("observation.blocking_reasons = '[]'::jsonb")
    expect(shadow).toContain('observation.valid_until > pg_catalog.now()')
    expect(shadow).toContain('observation.valid_until - observation.source_as_of')
    expect(shadow).toContain('pg_catalog.unnest(contract.required_raw_roles)')
    expect(shadow).toContain("raw.content_hash ~ '^[0-9a-f]{64}$'")
    expect(shadow).toContain('raw.source_run_id = observation.source_run_id')
    expect(shadow).toContain('raw.trust_artifact_role = artifact.role')
    expect(shadow).toContain('acquisition.population_raw_object_id = snapshot.raw_object_id')
    expect(shadow).toContain("acquisition.acquisition_state = 'complete'")
    expect(shadow).toContain("acquisition.population_state = 'verified'")
  })

  it('pairs only same-run same-window ROI and PnL and prefers upstream values', () => {
    const setView = migration.slice(
      migration.indexOf('CREATE VIEW arena.metric_rankable_input_sets_shadow')
    )
    expect(setView).toMatch(
      /WHEN 'source_reported' THEN 1[\s\S]*WHEN 'source_normalized' THEN 2[\s\S]*WHEN 'arena_rebuilt' THEN 3/
    )
    expect(setView).not.toContain('WITH preferred AS')
    expect(setView).toContain('FROM arena.metric_rankable_observations AS roi')
    expect(setView).toContain('JOIN arena.metric_rankable_observations AS pnl')
    expect(setView).toContain('pnl.source_run_id = roi.source_run_id')
    expect(setView).toContain('pnl.source_contract_version = roi.source_contract_version')
    expect(setView).toContain('pnl.metric_set_id = roi.metric_set_id')
    expect(setView).toContain('pnl.window_start = roi.window_start')
    expect(setView).toContain('pnl.window_end = roi.window_end')
    expect(setView).toContain('pnl.currency = roi.currency')
    expect(setView).toContain('true AS rank_eligible')
  })
})
