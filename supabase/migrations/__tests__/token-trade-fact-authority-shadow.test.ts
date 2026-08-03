import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260730033000_token_trade_fact_authority_shadow.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const binanceParser = readFileSync(join(root, 'lib/ingest/adapters/binance/parsers.ts'), 'utf8')
const okxParser = readFileSync(join(root, 'lib/ingest/adapters/okx/parsers.ts'), 'utf8')
const behaviorProof = readFileSync(
  join(root, 'supabase/migrations/__tests__/token-trade-fact-authority-shadow.pg17.sh'),
  'utf8'
)

const contractStart = migration.indexOf('CREATE TABLE arena.token_trade_source_contracts')
const factStart = migration.indexOf('CREATE TABLE arena.token_trade_fact_evidence')
const coverageStart = migration.indexOf('CREATE TABLE arena.token_history_coverage_evidence')
const viewStart = migration.indexOf('CREATE VIEW arena.token_trade_fact_authority_shadow')
const aclStart = migration.indexOf('REVOKE ALL ON TABLE arena.token_trade_source_contracts')

const contract = migration.slice(contractStart, factStart)
const fact = migration.slice(factStart, coverageStart)
const coverage = migration.slice(coverageStart, viewStart)
const view = migration.slice(viewStart, aclStart)

describe('token trade fact authority shadow migration', () => {
  it('is atomic, bounded, private, and does not cut over current token serving', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    expect(migration).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED VIEW/i)
    expect(migration).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.get_(?:popular_tokens|token_trader_rankings)/i
    )
    expect(migration).not.toMatch(/REFRESH\s+MATERIALIZED\s+VIEW/i)
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*leaderboard_ranks/i)
  })

  it('owns reviewed Binance and OKX field contracts outside writer authority', () => {
    for (const token of [
      "'binance-futures-position-history@1'",
      "'okx-futures-position-history@1'",
      "'tuple(portfolioId,response.data.list[].id,response.data.list[].symbol,response.data.list[].side)'",
      "'response.data.list[].symbol'",
      "'response.data.list[].closingPnl'",
      "'response.data.list[].avgCost'",
      "'response.data.list[].avgClosePrice'",
      "'response.data.list[].status'",
      "'tuple(historyTraderIdentity,data[].subPosId)'",
      "'data[].instId'",
      "'data[].pnl'",
      "'data[].openAvgPx'",
      "'data[].closeAvgPx'",
      "'data[].closeTime'",
      "'exact_literal'",
      "'All Closed'",
      "'positive_epoch_ms'",
      "'arena.binance-futures-token-trade-fact@1'",
      "'arena.okx-futures-token-trade-fact@1'",
      "'arena.usdt-usd-price-history-fx@1'",
      "'arena.binance-futures-history-coverage@1'",
      "'arena.okx-futures-history-coverage@1'",
    ]) {
      expect(contract).toContain(token)
    }

    expect(contract).toContain("required_raw_artifact_role = 'event_history'")
    expect(contract).toContain("required_raw_job_type = 'history:position_history'")
    expect(contract).toContain("required_pnl_trust_state IN ('source_owned', 'verified')")
    expect(contract).toContain("required_fx_trust_state IN ('not_required', 'verified')")
    expect(contract).not.toContain("'response[].symbol'")
    expect(contract).not.toContain("'endpoint:public-subpositions-history'")
    for (const path of [
      "'portfolioId'",
      "'response.data.list[].id'",
      "'response.data.list[].symbol'",
      "'response.data.list[].side'",
      "'response.data.list[].status'",
    ]) {
      expect(binanceParser).toContain(path)
    }
    for (const path of ["'historyTraderIdentity'", "'data[].subPosId'", "'data[].closeTime'"]) {
      expect(okxParser).toContain(path)
    }
    expect(migration).toContain('REVOKE ALL ON TABLE arena.token_trade_source_contracts')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE arena.token_trade_source_contracts TO service_role'
    )
    expect(migration).not.toContain('GRANT INSERT ON TABLE arena.token_trade_source_contracts')
    expect(migration).toContain(
      "pg_catalog.has_table_privilege(\n       'service_role', 'arena.token_trade_source_contracts', 'INSERT'"
    )
  })

  it('requires typed fact identity, normalization, lifecycle, PnL, FX, and trust evidence', () => {
    for (const field of [
      'contract_id text NOT NULL',
      'source_id smallint NOT NULL',
      'trader_id bigint NOT NULL',
      'source_run_id text NOT NULL',
      'source_raw_object_id bigint',
      'source_row_identity text NOT NULL',
      'closed_at timestamptz NOT NULL',
      'position_dedupe_hash text NOT NULL',
      'source_symbol text NOT NULL',
      'source_asset_locator text NOT NULL',
      'asset_id text NOT NULL',
      'asset_namespace text NOT NULL',
      'asset_chain_id text',
      'asset_protocol_slug text',
      'token_address text',
      'normalized_token text',
      'token_normalization_state text NOT NULL',
      'token_normalization_method_version text NOT NULL',
      'opened_at timestamptz',
      'entry_price numeric',
      'exit_price numeric',
      'realized_pnl_source numeric',
      'reported_currency text NOT NULL',
      'fx_evidence_id bigint',
      'fx_rate_to_usd numeric',
      'realized_pnl_usd numeric GENERATED ALWAYS AS',
      'lifecycle_state text NOT NULL',
      'source_lifecycle_marker text',
      'pnl_trust_state text NOT NULL',
      'price_trust_state text NOT NULL',
      'cost_basis_trust_state text NOT NULL',
      'fx_trust_state text NOT NULL',
      'authority_method_version text NOT NULL',
      "DEFAULT ARRAY['unreviewed']::text[]",
    ]) {
      expect(fact).toContain(field)
    }

    expect(fact).toContain(
      "(token_normalization_state = 'normalized') = (normalized_token IS NOT NULL)"
    )
    expect(fact).toContain("fx_trust_state IN ('not_required', 'verified')")
    expect(fact).toContain("fx_trust_state = 'unknown' AND fx_rate_to_usd IS NULL")
    for (const special of ["'NaN'::numeric", "'Infinity'::numeric", "'-Infinity'::numeric"]) {
      expect(fact).toContain(special)
    }
    expect(migration).toContain('CREATE TABLE arena.token_trade_fx_evidence')
    expect(migration).toContain("fx_raw.trust_artifact_role = 'price_history'")
    expect(migration).toContain("fx_raw.job_type = 'price_history:USDT-USD'")
    expect(migration).toContain("fx_trust_state = 'unknown' AND fx_rate_to_usd IS NULL")
    expect(migration).toContain('latest_fx_evidence AS MATERIALIZED')
    expect(migration).toContain('latest_fx.fx_evidence_id AS latest_fx_evidence_id')
    expect(migration.match(/REFERENCES arena\.raw_objects\(id\) ON DELETE SET NULL/g)).toHaveLength(
      3
    )
    expect(fact).toContain(
      'REFERENCES arena.token_trade_fx_evidence(fx_evidence_id) ON DELETE SET NULL'
    )
    expect(migration).toContain("WHEN 'binance_futures' THEN asset.canonical_ticker || 'USDT'")
    expect(migration).toContain("WHEN 'okx_futures' THEN asset.canonical_ticker || '-USDT-SWAP'")
    expect(migration).not.toContain('REFERENCES arena.raw_objects(id) ON DELETE CASCADE')
  })

  it('derives 7/30/90D completeness from exact bounds and typed cap flags', () => {
    for (const token of [
      'window_days smallint NOT NULL CHECK (window_days IN (7, 30, 90))',
      'window_start_at timestamptz NOT NULL',
      'window_end_at timestamptz NOT NULL',
      'covered_from_at timestamptz',
      'covered_through_at timestamptz',
      'source_as_of timestamptz NOT NULL',
      'evaluator_state text NOT NULL',
      'scan_terminal_state text NOT NULL',
      'terminal_cursor_value text',
      'overlap_closed_at timestamptz',
      'caller_limited boolean NOT NULL',
      'page_limited boolean NOT NULL',
      'retention_limited boolean NOT NULL',
      'coverage_evaluator_method_version text NOT NULL',
      'scan_complete boolean GENERATED ALWAYS AS',
      'history_completeness_state text GENERATED ALWAYS AS',
      "WHEN evaluator_state = 'unknown' THEN 'unknown'",
      "THEN 'partial'",
      "ELSE 'complete'",
      "window_start_at = window_end_at - (window_days::integer * interval '1 day')",
      'covered_through_at IS NULL OR covered_through_at <= source_as_of',
    ]) {
      expect(coverage).toContain(token)
    }

    expect(coverage).not.toMatch(/history_completeness_state\s+text\s+NOT NULL/)
    expect(coverage).not.toMatch(/history_completeness_state\s+IN\s*\(/)
    expect(coverage).toContain("scan_terminal_state = 'exhausted'")
    expect(coverage).toContain("scan_terminal_state = 'cursor_overlap'")
    expect(coverage).toContain("scan_terminal_state = 'window_prefix_proven'")
  })

  it('selects latest evidence before trust filters and binds exact contracts plus RAW digests', () => {
    const latestFact = view.slice(
      view.indexOf('latest_fact_versions AS MATERIALIZED'),
      view.indexOf('), latest_fact_evidence AS MATERIALIZED')
    )
    const latestCoverage = view.slice(
      view.indexOf('latest_coverage_evidence AS MATERIALIZED'),
      view.indexOf('), latest_fx_evidence AS MATERIALIZED')
    )
    expect(view).toContain('WITH authority_windows(window_days) AS MATERIALIZED')
    expect(view).toContain('latest_fact_versions AS MATERIALIZED')
    expect(view).toContain(
      'evidence.source_id,\n    evidence.trader_id,\n    evidence.source_row_identity'
    )
    expect(latestFact).toContain('evidence.evidence_id DESC')
    expect(latestFact).not.toContain('evidence.recorded_at DESC')
    expect(view).toContain('latest_fact_evidence AS MATERIALIZED')
    expect(view.indexOf('latest_fact_versions AS MATERIALIZED')).toBeLessThan(
      view.indexOf('WHERE latest.closed_at >=')
    )
    expect(view).toContain('latest_coverage_evidence AS MATERIALIZED')
    expect(view).toContain('coverage.asset_id,')
    expect(latestCoverage).toContain('coverage.coverage_evidence_id DESC')
    expect(latestCoverage).not.toContain('coverage.recorded_at DESC')
    expect(view).toContain('latest_fx_evidence AS MATERIALIZED')
    expect(view).toContain('fx.fx_evidence_id DESC')

    for (const token of [
      'fact_raw.source_run_id = fact.source_run_id',
      'fact_raw.content_hash = fact.source_run_id',
      'fact_raw.trust_artifact_role = contract.required_raw_artifact_role',
      'fact_raw.job_type = contract.required_raw_job_type',
      'coverage_raw.source_run_id = coverage.source_run_id',
      'coverage_raw.content_hash = coverage.source_run_id',
      'fact_bound.authority_method_version',
      'fact_bound.contract_fact_method',
      'fact_bound.coverage_evaluator_method_version',
      'fact_bound.contract_coverage_method',
      'fact_bound.pnl_provenance',
      'fact_bound.contract_pnl_provenance',
      'fact_bound.required_price_trust_state',
      'fact_bound.required_cost_basis_trust_state',
      'fact_bound.required_fx_trust_state',
      'fact_bound.coverage_source_run_id',
      'fact_bound.fact_source_run_id',
      'mapping.source_asset_locator = fact.source_asset_locator',
      'mapping.source_asset_locator = fact.source_symbol',
      'mapping.asset_id = fact.asset_id',
      'fx_raw.content_hash = fact_fx.source_run_id',
    ]) {
      expect(view).toContain(token)
    }

    expect(view).not.toMatch(/position\.raw|fact_raw\.meta|coverage_raw\.meta|fx_raw\.meta|->>?/)
  })

  it('fails closed on source lifecycle and every incomplete fact/coverage state', () => {
    for (const blocker of [
      'source_not_active',
      'source_not_serving',
      'source_contract_missing',
      'source_contract_registry_mismatch',
      'fact_contract_or_identity_mismatch',
      'fact_raw_lineage_mismatch',
      'fact_raw_quarantined',
      'fact_raw_capture_time_mismatch',
      'legacy_projection_mismatch',
      'closed_at_unknown',
      'opened_at_unknown',
      'lifecycle_partial',
      'lifecycle_unknown',
      'source_lifecycle_marker_unknown',
      'source_lifecycle_marker_mismatch',
      'source_lifecycle_marker_contract_missing',
      'token_normalization_unknown',
      'token_normalization_method_mismatch',
      'canonical_asset_mapping_mismatch',
      'source_instrument_mapping_mismatch',
      'currency_contract_mismatch',
      'fact_method_or_provenance_mismatch',
      'pnl_unknown',
      'price_unknown',
      'cost_basis_unknown',
      'fx_unknown',
      'fx_evidence_missing',
      'fx_evidence_superseded',
      'fx_evidence_contract_mismatch',
      'fx_raw_lineage_mismatch',
      'fx_raw_quarantined',
      'fx_raw_capture_time_mismatch',
      'fx_evidence_future',
      'fx_price_time_mismatch',
      'history_coverage_missing',
      'coverage_contract_mismatch',
      'coverage_fact_run_mismatch',
      'coverage_raw_lineage_mismatch',
      'coverage_raw_quarantined',
      'coverage_raw_capture_time_mismatch',
      'coverage_evaluator_method_mismatch',
      'history_scan_incomplete',
      'history_unknown',
      'history_partial',
      'history_caller_limited',
      'history_page_limited',
      'history_retention_limited',
      'history_bounds_incomplete',
      'history_bounds_after_source_as_of',
      'history_fact_absent',
      'trade_outside_window',
      'window_end_source_as_of_mismatch',
      'coverage_future',
      'coverage_stale',
    ]) {
      expect(view).toContain(`'${blocker}'`)
    }

    expect(view).toContain("fact_bound.source_status <> 'active'")
    expect(view).toContain("fact_bound.source_serving_mode <> 'serving'")
    expect(view).toContain('pg_catalog.statement_timestamp() - fact_bound.max_coverage_freshness')
  })

  it('makes legacy/unattested rows observably unknown and never rank eligible', () => {
    expect(view).toContain('FROM arena.position_history AS position')
    expect(view).toContain('CROSS JOIN authority_windows AS window_row')
    expect(view).toContain('FROM latest_fact_evidence AS fact')
    expect(view).toContain('LEFT JOIN latest_coverage_evidence AS coverage')
    expect(view).toContain("COALESCE(evaluated.history_completeness_state, 'unknown')")
    expect(view).toContain("COALESCE(evaluated.token_normalization_state, 'unknown')")
    expect(view).toContain("'unknown'::text AS authority_state")
    expect(view).toContain("ARRAY['legacy_position_unattested']::text[]")
    expect(view).toContain('SELECT * FROM fact_rows\nUNION ALL\nSELECT * FROM legacy_rows')
    expect(view).toContain('pg_catalog.cardinality(evaluated.blocker_reasons) = 0 AS rank_eligible')
  })

  it('enforces service-only append/read ACLs, RLS, owner, and invoker-safe view options', () => {
    const fxInsertGrant = migration.slice(
      migration.indexOf('GRANT INSERT (\n  contract_id,', aclStart),
      migration.indexOf('REVOKE ALL ON TABLE arena.token_trade_fact_evidence')
    )
    const factInsertGrant = migration.slice(
      migration.indexOf('GRANT INSERT (\n  contract_id,\n  source_id,\n  trader_id,', aclStart),
      migration.indexOf('REVOKE ALL ON TABLE arena.token_history_coverage_evidence')
    )
    const coverageInsertGrant = migration.slice(
      migration.indexOf(
        'GRANT INSERT (\n  contract_id,\n  source_id,\n  trader_id,',
        migration.indexOf('REVOKE ALL ON TABLE arena.token_history_coverage_evidence')
      ),
      migration.indexOf('REVOKE ALL ON SEQUENCE')
    )
    expect(migration).toContain('WITH (security_invoker = true, security_barrier = true)')
    expect(migration).toContain(
      'ALTER VIEW arena.token_trade_fact_authority_shadow OWNER TO postgres'
    )

    for (const table of [
      'arena.token_trade_source_contracts',
      'arena.token_assets',
      'arena.token_trade_contract_assets',
      'arena.token_trade_fx_evidence',
      'arena.token_trade_fact_evidence',
      'arena.token_history_coverage_evidence',
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} OWNER TO postgres`)
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`REVOKE ALL ON TABLE ${table}`)
    }

    expect(migration).toContain(
      'GRANT SELECT ON TABLE arena.token_trade_fx_evidence TO service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT ON TABLE arena.token_trade_fact_evidence TO service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT ON TABLE arena.token_history_coverage_evidence TO service_role'
    )
    for (const grant of [fxInsertGrant, factInsertGrant, coverageInsertGrant]) {
      expect(grant).toContain('GRANT INSERT (')
      expect(grant).not.toContain('recorded_at')
    }
    expect(fxInsertGrant).not.toContain('\n  fx_evidence_id,')
    expect(factInsertGrant).not.toContain('\n  evidence_id,')
    expect(factInsertGrant).not.toContain('realized_pnl_usd')
    expect(coverageInsertGrant).not.toContain('coverage_evidence_id')
    expect(coverageInsertGrant).not.toContain('scan_complete')
    expect(coverageInsertGrant).not.toContain('history_completeness_state')
    expect(migration).toContain('REVOKE ALL ON TABLE arena.token_trade_fact_authority_shadow')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE arena.token_trade_fact_authority_shadow TO service_role'
    )

    expect(behaviorProof).toContain('PostgreSQL 17')
    expect(behaviorProof).toContain('p_raw_digest_mismatch => true')
    expect(behaviorProof).toContain('p_raw_quarantined => true')
    expect(behaviorProof).toContain('p_cross_run_coverage => true')
    expect(behaviorProof).toContain('p_omit_fx_artifact => true')
    expect(behaviorProof).toContain("p_authority_method_version => 'forged.writer-contract@9'")
    expect(behaviorProof).toContain('p_caller_limited => true')
    expect(behaviorProof).toContain('p_page_limited => true')
    expect(behaviorProof).toContain("p_source_age => interval '30 hours'")
    expect(behaviorProof).toContain('backdated newer unknown fact suppresses older trusted fact')
    expect(behaviorProof).toContain(
      'backdated newer unknown coverage suppresses older complete coverage'
    )
    expect(behaviorProof).toContain('newer unknown FX correction withdraws old verified FX')
    expect(behaviorProof).toContain('contract-owned exact CEX instrument locators')
    expect(behaviorProof).toContain('independent recent 7/30/90 windows')
    expect(behaviorProof).toContain('authority identity survives global legacy collision')
    expect(behaviorProof).toContain('newer final version promotes partial identity')
    expect(behaviorProof).toContain(
      'newer out-of-window version cannot resurrect old complete fact'
    )
    expect(behaviorProof).toContain(
      'FX RAW GC preserves correction tombstone and cannot revive verified FX'
    )
    expect(behaviorProof).toContain(
      'RAW retention preserves latest fail-closed evidence tombstones'
    )
  })
})
