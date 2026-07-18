import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718184000_arena_score_inputs_board_as_of.sql'),
  'utf8'
)

const latestPassed = migration.slice(
  migration.indexOf('WITH latest_passed AS MATERIALIZED'),
  migration.indexOf('alias_board_watermarks AS MATERIALIZED')
)
const boardWatermarks = migration.slice(
  migration.indexOf('alias_board_watermarks AS MATERIALIZED'),
  migration.indexOf('SELECT COALESCE(')
)
const payload = migration.slice(
  migration.indexOf('SELECT COALESCE('),
  migration.indexOf('$function$;', migration.indexOf('SELECT COALESCE('))
)

describe('arena score-input board watermark migration', () => {
  it('atomically replaces only the existing JSON RPC with the same signature', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain(
      "to_regprocedure(\n    'public.arena_score_inputs_json(text,integer,integer)'\n  )"
    )
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json\(\s*p_window text,\s*p_per_platform_limit int DEFAULT 1000,\s*p_max_age_hours int DEFAULT 48\s*\)\s*RETURNS jsonb/
    )
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|VIEW|TABLE)/i)
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW/i)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs\s*\(/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('uses one hardened SQL statement and fully qualified data relations', () => {
    expect(migration).toMatch(
      /LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain('FROM arena.leaderboard_snapshots AS snapshot')
    expect(migration).toContain('JOIN arena.sources AS source')
    expect(payload).toContain('FROM arena.score_inputs AS score_input')
    expect(migration).toContain('pg_catalog.jsonb_agg(payload_row)')
    expect(migration).toContain('pg_catalog.make_interval(hours => p_max_age_hours)')
    expect(migration).not.toContain('SET search_path = arena, public')
  })

  it('takes the latest passed board for only the requested window', () => {
    expect(latestPassed).toContain('SELECT DISTINCT ON (snapshot.source_id)')
    expect(latestPassed).toContain('WHERE snapshot.count_check_passed')
    expect(latestPassed).toContain("(snapshot.timeframe::pg_catalog.text || 'D') = p_window")
    expect(latestPassed).toMatch(
      /ORDER BY\s+snapshot\.source_id,\s+snapshot\.scraped_at DESC,\s+snapshot\.id DESC/
    )
  })

  it('publishes the oldest physical board per active supported serving alias', () => {
    const aliasExpression =
      "COALESCE(\n        NULLIF(source.meta->>'legacy_platform', ''),\n        source.slug\n      )"
    expect(
      boardWatermarks.match(new RegExp(aliasExpression.replace(/[()[\]']/g, '\\$&'), 'g'))
    ).toHaveLength(2)
    expect(boardWatermarks).toContain('pg_catalog.min(latest.scraped_at) AS board_as_of')
    expect(boardWatermarks).toMatch(
      /WHERE source\.status = 'active'\s+AND source\.serving_mode = 'serving'/
    )
    expect(boardWatermarks).toContain("ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]")
    expect(boardWatermarks).toContain("(source.meta->>'legacy_platform') IS DISTINCT FROM 'null'")
  })

  it('keeps score membership and as_of while left-joining the new watermark', () => {
    for (const field of [
      'platform',
      'market_type',
      'trader_key',
      'board_rank',
      'roi_pct',
      'pnl_usd',
      'win_rate',
      'max_drawdown',
      'copiers',
      'trades_count',
      'sharpe_ratio',
      'sortino_ratio',
      'calmar_ratio',
      'volatility_pct',
      'trader_kind',
      'handle',
      'avatar_url',
      'currency',
      'as_of',
    ]) {
      expect(payload).toContain(`score_input.${field}`)
    }
    expect(payload).toContain('board_watermark.board_as_of')
    expect(payload).toMatch(
      /FROM arena\.score_inputs AS score_input\s+LEFT JOIN alias_board_watermarks AS board_watermark\s+ON board_watermark\.platform = score_input\.platform/
    )
    expect(payload).toContain('score_input."window" = p_window')
    expect(payload).toContain('score_input.board_rank <= p_per_platform_limit')
    expect(payload).toMatch(
      /score_input\.as_of > pg_catalog\.now\(\)\s+- pg_catalog\.make_interval\(hours => p_max_age_hours\)/
    )
  })

  it('normalizes execution ACLs and reloads PostgREST', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+TO service_role;/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
