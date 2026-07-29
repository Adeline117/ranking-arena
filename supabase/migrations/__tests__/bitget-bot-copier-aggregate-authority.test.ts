import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729014000_bitget_bot_copier_aggregate_authority.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/bitget-bot-copier-aggregate-authority.pg17.sh'
  ),
  'utf8'
)
const recordsReader = readFileSync(resolve(process.cwd(), 'lib/data/serving/records.ts'), 'utf8')
const recordsRoute = readFileSync(
  resolve(process.cwd(), 'app/api/traders/[handle]/records/route.ts'),
  'utf8'
)

describe('Bitget bot copier aggregate authority', () => {
  it('is one bounded, serialized, replayable migration', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('20260729_bitget_bot_copier_aggregate_authority')
    expect(migration).toContain(
      'LOCK TABLE arena.traders, arena.trader_stats, arena.copier_records IN SHARE MODE'
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('pins both canonical sources and fails closed on adapter expansion', () => {
    for (const value of [
      "'bitget_bots_futures'::text",
      "'bitget_bots_spot'::text",
      "exchange.slug = 'bitget'",
      "source.adapter_slug = 'bitget_bots'",
      "source.trader_kind_scope = 'bot'",
      "source.status = 'active'",
      "source.serving_mode = 'serving'",
      'source.timeframes_native = ARRAY[30]::integer[]',
      'source.timeframes_derived = ARRAY[]::integer[]',
      'source.page_size = 20',
      "source.pagination_kind = 'numeric'",
      '["futures_grid", "futures_martingale"]',
      '["spot_grid", "spot_martingale"]',
    ]) {
      expect(migration).toContain(value)
    }
    expect(migration).toContain(
      'unexpected active Bitget bot source requires explicit copier-authority review'
    )
    expect(migration).toContain("OR source_row.adapter_slug = 'bitget_bots'")
    expect(migration).toMatch(
      /exchange_row\.slug = 'bitget'[\s\S]*trader\.trader_kind = 'bot'[\s\S]*source_row\.trader_kind_scope = 'bot'/
    )
    expect(migration).toContain('AND resolved.canonical_bitget_bot')
    expect(migration).toContain("AND source_row.status = 'active'")
    expect(migration).toContain("AND source_row.serving_mode = 'serving'")
  })

  it('converges and locks the reviewed followRank depth to Top-10', () => {
    const constraint = 'sources_bitget_bot_copier_depth_top10'
    expect(migration).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`)
    expect(migration).toContain(`ADD CONSTRAINT ${constraint}`)
    expect(migration).toContain(`VALIDATE CONSTRAINT ${constraint}`)
    expect(migration).toMatch(
      /UPDATE arena\.sources\s+SET copier_table_depth = 'top10'[\s\S]*'bitget_bots_futures'[\s\S]*'bitget_bots_spot'/
    )
    expect(migration).toContain("OR copier_table_depth = 'top10'")
    expect(migration).toContain('non-paginated, page-disclosed Top-10 surface')
    expect(migration).toContain("source.copier_table_depth IN ('full', 'top10')")
    const sourceUpdates = migration.match(/UPDATE arena\.sources[\s\S]*?;/g) ?? []
    expect(sourceUpdates).toHaveLength(1)
    expect(sourceUpdates[0]).not.toMatch(/serving_mode\s*=/i)
  })

  it('uses only exact profile-published inception totals for Bitget bots', () => {
    expect(migration).toContain('trusted_bot_stats AS (')
    expect(migration).toContain('AND stats.timeframe = 0')
    expect(migration).toContain("stats.extras -> '_arena_profile_publication_epoch_ms'")
    expect(migration).toMatch(
      /_arena_profile_publication_epoch_ms'[\s\S]*::pg_catalog\.numeric\s*=\s*EXTRACT\(EPOCH FROM stats\.as_of\) \* 1000/
    )
    expect(migration).toMatch(
      /WHEN resolved\.is_bitget_bot\s+THEN \(SELECT stats\.copier_count FROM trusted_bot_stats/
    )
    expect(migration).toMatch(
      /WHEN resolved\.is_bitget_bot\s+THEN \(SELECT stats\.copier_pnl FROM trusted_bot_stats/
    )
    const countBotBranch = migration.match(/'copierCount', CASE([\s\S]*?)\n\s*ELSE COALESCE/)?.[1]
    const pnlBotBranch = migration.match(/'totalCopierPnl', CASE([\s\S]*?)\n\s*ELSE COALESCE/)?.[1]
    expect(countBotBranch).toBeDefined()
    expect(pnlBotBranch).toBeDefined()
    expect(countBotBranch).not.toContain('FROM batch')
    expect(pnlBotBranch).not.toContain('FROM batch')
  })

  it('keeps Top-10 evidence bounded and never fabricates Bot freshness', () => {
    expect(migration).toContain('FROM batch')
    expect(migration).toContain('batch_contract.row_count BETWEEN 1 AND 10')
    expect(migration).toMatch(
      /WHEN resolved\.is_bitget_bot THEN GREATEST\([\s\S]*SELECT latest\.ts FROM latest[\s\S]*trusted_bot_stats/
    )
    const botAsOf = migration.match(
      /WHEN resolved\.is_bitget_bot THEN GREATEST\([\s\S]*?\n\s*\)\n\s*ELSE COALESCE/
    )?.[0]
    expect(botAsOf).toBeDefined()
    expect(botAsOf).not.toContain('now()')
    expect(migration).toContain("'copierCountMax', NULL")
    expect(migration).toMatch(
      /WHERE NOT resolved\.is_bitget_bot[\s\S]*resolved\.canonical_bitget_bot[\s\S]*latest\.ts[\s\S]*trusted_bot_stats/
    )
  })

  it('maps SQL NULL to the existing pending/no-store API contract', () => {
    expect(recordsReader).toContain('if (error || !data) return null')
    expect(recordsRoute).toMatch(
      /if \(aggregate\)[\s\S]*withCache\([\s\S]*return apiSuccess\(\{ cacheState: 'pending' as const \}, 200, \{ 'Cache-Control': 'no-store' \}\)/
    )
  })

  it('hardens the definer and leaves an exact public reader ACL', () => {
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain(
      'ALTER FUNCTION public.arena_copier_aggregate(text, text)\n  OWNER TO postgres'
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_copier_aggregate\(text, text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_copier_aggregate\(text, text\)[\s\S]*TO anon, authenticated, service_role/
    )
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('privilege.grantee = 0::oid')
    expect(migration).toContain('copier metric substrate read authority drifted')
    expect(migration).toContain('267bac4cf6a3c9f51e2a2b3f61aa29f22549bc39f69c20c59f438a3663ab68de')
  })

  it('has a durable PG17 proof for the exploit, compatibility, bypasses, and replay', () => {
    for (const marker of [
      'pre-migration multi-timeframe aggregate was unexpectedly deterministic',
      'trusted inception totals were not authoritative',
      'newer trusted profile timestamp lost to an older Top-10 batch',
      'untrusted profile totals leaked',
      'Top-10 batch was promoted to a total',
      'oversized Top-10 batch did not fail closed',
      'inactive source remained publicly readable',
      'rogue Bitget bot adapter source leaked',
      'unknown Bitget bot adapter generation leaked',
      'canonical Bot without evidence did not return SQL NULL',
      'canonical source-contract drift did not return SQL NULL',
      'non-Bot aggregate behavior regressed',
      'browser direct stats read bypass remained',
      'hostile PUBLIC execute bypass remained',
      'Bitget bot copier depth constraint was bypassed',
      'Bitget bot copier aggregate authority PG17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
