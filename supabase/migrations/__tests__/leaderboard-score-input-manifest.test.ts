import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260722051000_leaderboard_score_input_manifest_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/leaderboard-score-input-manifest.pg17.sh'),
  'utf8'
)
const fixture = JSON.parse(
  readFileSync(
    resolve(
      root,
      'supabase/migrations/__tests__/fixtures/leaderboard-score-input-manifest-v1.json'
    ),
    'utf8'
  )
) as Record<string, unknown>

describe('private leaderboard score-input manifest contract', () => {
  it('is inert and has no PostgREST-callable builder or leaderboard writer', () => {
    expect(migration).toContain('This migration deliberately exposes no public RPC')
    expect(migration).toContain('changes no leaderboard row')
    expect(migration).toContain('only component allowed to call the private seal function')
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./)
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*public\.leaderboard_ranks/i
    )
    expect(migration).not.toContain('GRANT EXECUTE')
    expect(migration).not.toContain('TO service_role')
  })

  it('binds evidence, canonical nine-field inputs, scorer definitions and outputs', () => {
    for (const field of [
      'sourceBundleDigest',
      'scoreRowsDigest',
      'physicalBoardsDigest',
      'enrichment',
      'eligibility',
      'inputCount',
      'inputs',
      'outputs',
      'validUntil',
      'definitionDigest',
      'inputDigest',
      'outputDigest',
      'manifestDigest',
    ]) {
      expect(migration).toContain(`'${field}'`)
    }
    for (const field of [
      'source',
      'source_trader_id',
      'roi',
      'pnl',
      'max_drawdown',
      'win_rate',
      'sharpe_ratio',
      'profit_factor',
      'trades_count',
    ]) {
      expect(migration).toContain(`'${field}'`)
    }
    expect(migration).toContain('COLLATE "C"')
    expect(migration).toContain('arena.compute_arena_scores_v4_json(p_period, p_inputs)')
    expect(migration).toContain('canonical inputs disagree with private PG17 input digest')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(v_round_oid)')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(v_scorer_oid)')
    expect(migration).toContain("SET quote_all_identifiers = 'off'")
    expect(migration).toContain('845039eaafed171ea040409281e0a49aa127c69d48005d07b6228bd0b1bf56d9')
    expect(migration).toContain('UUID and insertion time')
    expect(migration).not.toMatch(/'manifestId'.*v_manifest_basis/s)
    expect(migration).not.toMatch(/'createdAt'.*v_manifest_basis/s)
  })

  it('makes table, codec, seal and verifier owner-only despite hostile defaults', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE arena\.leaderboard_score_input_manifests\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toContain('privilege_row.grantee <> relation_row.relowner')
    expect(migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(migration).toContain(
      'ALTER TABLE arena.leaderboard_score_input_manifests ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).not.toContain('SECURITY DEFINER')
    expect(pg17).toContain('leaked_default_role')
    expect(pg17).toContain('private manifest object leaked a non-owner privilege')
  })

  it('is content addressed, idempotent, resource bounded and tamper evident', () => {
    expect(migration).toContain('ON CONFLICT (manifest_digest) DO UPDATE')
    expect(migration).toContain('manifest digest collision or stored content drift')
    expect(migration).toContain('16777216')
    expect(migration).toContain('33554432')
    expect(migration).toContain('67108864')
    expect(migration).toContain("interval '1 second'")
    expect(migration).toContain("interval '24 hours'")
    expect(migration).toContain('validity fell below 1 second while it was being sealed')
    expect(migration).toContain("p_valid_until AT TIME ZONE 'UTC'")
    expect(pg17).toContain("set_config('TimeZone', 'America/Los_Angeles', true)")
    expect(pg17).toContain("set_config('quote_all_identifiers', 'on', true)")
    expect(pg17).toContain('manifest migration accepted a PUBLIC scorer-helper grant')
    expect(migration).toContain('stored score-input manifest failed content verification')
    expect(migration).toContain("'contentValid', true")
    expect(migration).toContain("'valid', v_row.valid_until > pg_catalog.statement_timestamp()")
    expect(migration).toMatch(/manifest->>'contract'[\s\S]*\) IS TRUE/)
    expect(pg17).toContain('content-addressed seal was not canonical and idempotent')
    expect(pg17).toContain('tampered scorer output unexpectedly verified')
    expect(pg17).toContain('tampered eligibility evidence unexpectedly verified')
    expect(pg17).toContain('tampered scorer definition unexpectedly verified')
    expect(pg17).toContain('concurrent equivalent seals returned different manifest ids')
    expect(pg17).toContain('uncommitted barrier')
    expect(pg17).toContain("concurrent_row_count\" != '1:1'")
    expect(pg17).toContain('manifest crossed its deadline and still returned successfully')
    expect(pg17).toContain('manifest migration unexpectedly reapplied')
  })

  it('has realistic source, board, enrichment and eligibility evidence fixtures', () => {
    expect(fixture.period).toBe('90D')
    expect(fixture.sourceEvidence).toMatchObject({
      freshAliases: ['binance_futures', 'bybit'],
      retainedAliases: ['okx_futures'],
    })
    expect(fixture.enrichmentContract).toBe('leaderboard-enrichment-evidence@1')
    expect(fixture.eligibilityContract).toBe('leaderboard-eligibility-evidence@1')
    expect(fixture.inputs).toHaveLength(2)
    expect(JSON.stringify(fixture)).toContain('physicalBoards')
    expect(JSON.stringify(fixture)).toContain('profitFactorSource')
  })

  it('is wired after the private scorer in both selective and full predeploy paths', () => {
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(2)
    expect(runner.indexOf('20260722041000_pure_arena_score_v4_scorer.sql')).toBeLessThan(
      runner.indexOf(migrationName)
    )
  })
})
