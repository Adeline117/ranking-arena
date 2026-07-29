import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260722051000_leaderboard_score_input_manifest_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pnlMigrationName = '20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql'
const pnlMigration = readFileSync(resolve(root, 'supabase/migrations', pnlMigrationName), 'utf8')
const v2MigrationName = '20260729070500_leaderboard_score_input_manifest_v2.sql'
const v2Migration = readFileSync(resolve(root, 'supabase/migrations', v2MigrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
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
  it('keeps the production-applied 51000 body immutable and forward-migrates PnL', () => {
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
    )
    expect(migration).not.toContain('leaderboard_score_input_manifest_rank_eligible_pnl')
    expect(migration).not.toContain('leaderboard score-input PnL must be a finite JSON number')
    expect(pnlMigration).toContain(
      '20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl'
    )
    expect(pnlMigration).toContain(
      'codex:20260722051000:fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
    )
    expect(pnlMigration).toContain('FOR SHARE')
    expect(pnlMigration).toContain('immutable 51000 encoder was rewritten')
    expect(runner).toContain(pnlMigrationName)
  })

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

  it('narrows leaderboard inputs to observed finite PnL without excluding zero or losses', () => {
    expect(pnlMigration).toContain('CREATE OR REPLACE FUNCTION arena.encode_')
    expect(pnlMigration).toContain('leaderboard_score_input_manifest_rank_eligible_pnl')
    expect(pnlMigration).toContain("input_row.value->'pnl'")
    expect(pnlMigration).toContain("IS DISTINCT FROM 'number'")
    expect(pnlMigration).toContain('leaderboard score-input PnL must be a finite JSON number')
    expect(pnlMigration).toContain('pg_catalog.jsonb_path_query_array')
    expect(pnlMigration).toContain('@.pnl.type() == "number"')
    expect(pnlMigration).toMatch(/jsonb_path_query_array\([\s\S]*?\)\s*\)\s*IS TRUE/)
    expect(pnlMigration).toContain('NOT VALID')
    expect(pnlMigration).toContain('VALIDATE CONSTRAINT')
    expect(pnlMigration).toContain('score-input manifest PnL table constraint drifted')
    expect(pnlMigration).toContain('rank-eligible score-input encoder leaked EXECUTE')
    for (const kind of ['missing', 'null', 'string', 'object', 'array', 'boolean']) {
      expect(pg17).toContain(`'${kind}'`)
    }
    expect(pg17).toContain("RAISE EXCEPTION '% PnL unexpectedly sealed'")
    expect(pg17).toContain('zero/loss PnL manifest failed verification')
    expect(pg17).toContain('table CHECK accepted a non-numeric PnL')
    expect(pg17).toContain('table CHECK accepted missing inputs')
    expect(pg17).toContain('failed 52000 migration left partial state')
    expect(pg17).toContain('failed post-DDL 52000 migration left partial state')
    expect(pg17).toContain('rank-eligible PnL migration accepted a drifted 51000 ledger')
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

  it('is wired after the private scorer in the ordered predeploy path', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('TIP_CHECKOUT_CUTOVER_VERSIONS=(')
    )
    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf('20260722041000_pure_arena_score_v4_scorer.sql')).toBeLessThan(
      predeploy.indexOf(migrationName)
    )
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(runner).toContain('prepare_ordered_predeploy_target')
  })
})

describe('versioned Arena Score v5 input manifest contract', () => {
  it('adds an inert v2 codec without changing v1 or a ranking writer', () => {
    expect(v2Migration).toContain('leaderboard-score-input-manifest@2')
    expect(v2Migration).toContain('arena.compute_arena_scores_v5_json(text,jsonb)')
    expect(v2Migration).toContain('pg_catalog.pg_get_functiondef')
    expect(v2Migration).toContain('Historical v1 rows and functions remain byte-for-byte')
    expect(v2Migration).toContain('It does not change public rankings')
    expect(v2Migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION\s+arena\.(?:encode|seal|verify)_leaderboard_score_input_manifest_v1/i
    )
    expect(v2Migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION\s+public\./i)
    expect(v2Migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*public\.leaderboard_ranks/i
    )
  })

  it('hash-fences v1, the frozen rounder and the v5 scorer definition', () => {
    for (const digest of [
      '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb',
      '50f06dfb9f552ac48e244270fc52568f21f9f144f9e5c6b7b1e6a4967fb44218',
      '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc',
      '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3',
      '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42',
      '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e',
      '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae',
      '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3',
      'a77fc9863c8e349aaea062c69ed5057167c5800383c6d9830d8214251cea6b18',
    ]) {
      expect(v2Migration).toContain(digest)
    }
    expect(v2Migration).toContain("pg_catalog.replace(v_definition, 'v4', 'v5')")
    expect(v2Migration).toContain("'arena.arena_score_v5_round2'")
    expect(v2Migration).toContain("'arena.arena_score_v4_round2'")
    expect(v2Migration).toContain('arena-score-v5-pg17-definition@1')
  })

  it('accepts concrete zeros but rejects unknown risk, unknown PnL and the MDD cap', () => {
    expect(v2Migration).toContain('leaderboard_score_input_manifest_v2_required_metrics')
    expect(v2Migration).toContain('@.win_rate.type() == "number"')
    expect(v2Migration).toContain('@.max_drawdown.type() == "number"')
    expect(v2Migration).toContain('@.win_rate >= 0')
    expect(v2Migration).toContain('@.win_rate <= 100')
    expect(v2Migration).toContain('@.max_drawdown >= 0')
    expect(v2Migration).toContain('@.max_drawdown < 100')
    expect(v2Migration).toContain("manifest->>'contract' <> 'leaderboard-score-input-manifest@2'")
    expect(v2Migration).toContain('trusted zero is valid')
    expect(v2Migration).toContain(
      'f6c94c39b1b299130644e7d8cb349bc72a8b98907a744f476aa94caf46930caf'
    )
    expect(pg17).toContain('v2 unknown PnL unexpectedly sealed')
    expect(pg17).toContain('v2 table CHECK accepted a null win rate')
    expect(pg17).toContain('v2 table CHECK accepted a 100 percent drawdown')
    expect(pg17).toContain('manifest table accepted an unknown outer contract')
  })

  it('keeps version verification isolated and replay-safe', () => {
    expect(v2Migration).toContain('v2 verifier requires a v2 score-input manifest')
    expect(v2Migration).toContain('leaderboard-score-input-manifest-verification@2')
    expect(v2Migration).toContain('IN ACCESS EXCLUSIVE MODE')
    expect(v2Migration).toContain('existing manifest v2 function contract drifted')
    expect(v2Migration).toContain('noncanonical manifest v2 function overload detected')
    expect(pg17).toContain('v1 verifier accepted a v2 manifest')
    expect(pg17).toContain('v2 verifier accepted a v1 manifest')
    expect(pg17).toContain('historical v1 manifest stopped verifying after v2')
    expect(pg17).toContain('manifest v2 replay changed function or CHECK identity')
    expect(pg17).toContain('manifest v2 migration accepted catalog drift')
  })

  it('fails closed on authority drift and repairs hostile v2 default grants', () => {
    expect(v2Migration).toContain('manifest v2 prerequisite authority boundary drifted')
    expect(v2Migration).toContain('v_table_row.relowner <> v_v1_encoder_row.proowner')
    expect(v2Migration).toContain('OR NOT v_table_row.relrowsecurity')
    expect(v2Migration).toContain('pg_catalog.has_function_privilege')
    expect(v2Migration).toContain('pg_catalog.has_table_privilege')
    expect(v2Migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(pg17).toContain('a leaked v5 scorer grant')
    expect(pg17).toContain('a leaked manifest-table grant')
    expect(pg17).toContain('a noncanonical same-name overload')
    expect(pg17).toContain('TO leaked_default_role')
    expect(pg17).toContain('failed manifest v2 preflight left partial state')
  })

  it('is ordered after v5, CI-proven and excluded from frozen recovery', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const recovery = runner.slice(
      runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=('),
      runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(v2MigrationName)
    expect(
      predeploy.indexOf('20260729070000_pure_arena_score_v5_zero_metric_scorer.sql')
    ).toBeLessThan(predeploy.indexOf(v2MigrationName))
    expect(runner.match(new RegExp(v2MigrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(v2MigrationName)
    expect(packageJson).toContain('"qa:score-manifest-v2-pg17"')
    expect(ci).toContain('name: Prove Arena Score v5 manifest isolation')
    expect(ci).toContain('run: npm run qa:score-manifest-v2-pg17')
  })
})
