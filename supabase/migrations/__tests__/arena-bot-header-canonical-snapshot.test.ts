import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const canonicalMigrationName = '20260728122000_bitget_bots_canonical_timeframe.sql'
const migrationName = '20260728123000_arena_bot_header_canonical_snapshot.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const canonicalMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations', canonicalMigrationName),
  'utf8'
)

describe('canonical current Bitget bot-header reader', () => {
  it('is ordered after canonical-timeframe convergence and is one bounded read-only migration', () => {
    expect(Number(migrationName.slice(0, 14))).toBeGreaterThan(
      Number(canonicalMigrationName.slice(0, 14))
    )
    expect(canonicalMigration).toContain('timeframes_native = ARRAY[30]::integer[]')
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    for (const relation of [
      'arena.exchanges',
      'arena.sources',
      'arena.leaderboard_snapshots',
      'arena.leaderboard_entries',
      'arena.traders',
    ]) {
      expect(migration).toContain(`'${relation}'`)
    }
    expect(migration).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\b/i)
  })

  it('fails closed unless both reviewed active serving source identities are exact 30D', () => {
    expect(migration).toContain("('bitget_bots_futures'::text, 'futures'::text)")
    expect(migration).toContain("('bitget_bots_spot'::text, 'spot'::text)")
    expect(migration).toContain("exchange.slug = 'bitget'")
    expect(migration).toContain("source.adapter_slug = 'bitget_bots'")
    expect(migration).toContain("source.trader_kind_scope = 'bot'")
    expect(migration).toContain("source.status = 'active'")
    expect(migration).toContain("source.serving_mode = 'serving'")
    expect(migration).toContain("source.currency = 'USDT'")
    expect(migration).toContain('source.timeframes_native = ARRAY[30]::integer[]')
    expect(migration).toContain('source.timeframes_derived = ARRAY[]::integer[]')
    expect(migration).toContain('source.page_size = 20')
    expect(migration).toContain("source.pagination_kind = 'numeric'")
    expect(migration).toContain('["futures_grid", "futures_martingale"]')
    expect(migration).toContain('["spot_grid", "spot_martingale"]')
    expect(migration).toContain('v_exact_sources <> 2')
    expect(migration).toContain(
      'arena_bot_header requires two exact active serving Bitget bot 30D sources'
    )
  })

  it('uses only latest passed non-derived canonical snapshot membership', () => {
    const latest = migration.slice(
      migration.indexOf('latest_passed_canonical_snapshot AS MATERIALIZED'),
      migration.indexOf('current_bot_membership AS MATERIALIZED')
    )
    const membership = migration.slice(
      migration.indexOf('current_bot_membership AS MATERIALIZED'),
      migration.indexOf('validated_bot_identity AS MATERIALIZED')
    )

    expect(latest).toContain('candidate.source_id = source.source_id')
    expect(latest).toContain('candidate.timeframe = 30')
    expect(latest).toContain('candidate.count_check_passed')
    expect(latest).toContain('NOT candidate.is_derived')
    expect(latest).toContain('ORDER BY candidate.scraped_at DESC, candidate.id DESC')
    expect(latest).toContain('LIMIT 1')
    expect(latest).toContain('snapshot.actual_count = (')
    expect(latest).toContain('population.snapshot_id = snapshot.id')
    expect(latest).toContain('population.scraped_at = snapshot.scraped_at')
    expect(latest).toContain('population.timeframe = 30')
    expect(membership).toContain('entry.snapshot_id = latest.snapshot_id')
    expect(membership).toContain('entry.scraped_at = latest.snapshot_as_of')
    expect(membership).toContain('entry.timeframe = 30')
    expect(membership).toContain('trader.source_id = latest.source_id')
    expect(membership).toContain("trader.trader_kind = 'bot'")
    expect(membership).toContain('requested.trader_key = trader.exchange_trader_id')

    expect(migration).not.toMatch(/\b(?:FROM|JOIN)\s+arena\.bots\b/i)
    expect(migration).not.toMatch(/\b(?:FROM|JOIN)\s+public\.leaderboard_ranks\b/i)
    expect(migration).not.toContain('owner_trader_id')
  })

  it('strictly validates identity and parses every optional meta.bot field without coercion', () => {
    expect(migration).toContain("jsonb_typeof(trader.meta->'bot') = 'object'")
    for (const field of [
      'exchange_bot_id',
      'product_type',
      'strategy',
      'pair',
      'direction',
      'runtime_days',
      'profit_share_rate',
      'created_at_origin',
      'status',
      'owner_account_id',
      'owner_name',
    ]) {
      expect(migration).toContain(`bot_document->'${field}'`)
    }
    expect(migration).toContain(
      "membership.bot_document->>'exchange_bot_id' = membership.exchange_trader_id"
    )
    expect(migration).toContain(
      "membership.bot_document->>'product_type' = membership.product_type"
    )
    expect(migration).toContain(
      "membership.bot_document->>'strategy' = membership.trader_bot_strategy"
    )
    expect(migration).toContain("membership.bot_document->>'strategy' IN ('grid', 'martingale')")
    expect(migration).toContain('membership.bot_document ?& ARRAY[')
    expect(migration).toContain('jsonb_object_keys(membership.bot_document)')
    expect(migration).toContain("membership.bot_document->>'direction' IN ('long', 'short')")
    expect(migration).toContain("jsonb_typeof(membership.bot_document->'product_id') = 'null'")
    expect(migration).not.toContain(
      "membership.bot_document->>'strategy' IN ('grid', 'martingale', 'ai')"
    )
    expect(migration).toContain("jsonb_typeof(identity.bot_document->'runtime_days') = 'number'")
    expect(migration).toContain('::numeric <= 365000')
    expect(migration).toContain(
      "jsonb_typeof(identity.bot_document->'profit_share_rate') = 'number'"
    )
    expect(migration).toContain('::numeric BETWEEN 0 AND 100')
    expect(migration).toContain("'[[:cntrl:]]'")
  })

  it('resolves owner_account_id only to a live human Bitget trader and falls back to owner_name', () => {
    const owner = migration.slice(
      migration.indexOf('LEFT JOIN LATERAL ('),
      migration.indexOf(') AS owner ON true')
    )
    expect(owner).toContain('owner_trader.exchange_trader_id = bot.owner_account_id')
    expect(owner).toContain("owner_trader.trader_kind = 'human'")
    expect(owner).toContain('owner_source.exchange_id = bot.exchange_id')
    expect(owner).toContain("owner_exchange.slug = 'bitget'")
    expect(owner).toContain("owner_source.adapter_slug = 'bitget'")
    expect(owner).toContain("owner_source.trader_kind_scope = 'human'")
    expect(owner).toContain("owner_source.status = 'active'")
    expect(owner).toContain("owner_source.serving_mode = 'serving'")
    expect(owner).toContain('(owner_source.product_type = bot.product_type) DESC')
    expect(migration).toMatch(
      /'owner_nickname', COALESCE\([\s\S]*owner\.nickname[\s\S]*bot\.owner_name/
    )
    expect(migration).toContain("'owner_trader_key', owner.exchange_trader_id")
  })

  it('distinguishes current membership from cadence-based freshness explicitly', () => {
    expect(migration).toContain("'canonical_timeframe', 30")
    expect(migration).toContain("'snapshot_as_of'")
    expect(migration).toContain("'fresh_until'")
    expect(migration).toContain("'is_current', true")
    expect(migration).toContain("'is_fresh'")
    expect(migration).toContain("'freshness'")
    expect(migration).toContain('bot.snapshot_as_of + bot.cadence_tier_a')
    expect(migration).toContain('stale current membership remains visible')
  })

  it('keeps the public reader definer contract hardened and explicitly granted', () => {
    expect(migration).toContain('LANGUAGE sql')
    expect(migration).toContain('STABLE')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain(
      'ALTER FUNCTION public.arena_bot_header(text, text) OWNER TO postgres'
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_bot_header\(text, text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_bot_header\(text, text\)[\s\S]*TO anon, authenticated, service_role;/
    )
    expect(migration).toContain("position('arena.bots' IN pg_catalog.lower(v_definition))")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
