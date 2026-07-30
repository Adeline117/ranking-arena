import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729171500_atomic_trader_watchlist_mutation.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

const authority = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.mutate_trader_watchlist_atomic'),
  migration.indexOf('ALTER FUNCTION public.mutate_trader_watchlist_atomic')
)

describe('atomic trader watchlist mutation migration', () => {
  it('restores the missing private foundation without weakening private reads', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.trader_watchlist')
    expect(migration).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(migration).toContain('ALTER TABLE public.trader_watchlist ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('USING (user_id = (SELECT auth.uid()))')
    expect(migration).toContain('GRANT SELECT ON TABLE public.trader_watchlist TO authenticated')
  })

  it('closes every direct write path that could race the capacity authority', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can insert own watchlist"')
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can delete own watchlist"')
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*FROM authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.mutate_trader_watchlist_atomic[\s\S]*TO authenticated/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.mutate_trader_watchlist_atomic[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
  })

  it('serializes count and insert per user and keeps the limit server-owned', () => {
    expect(authority).toContain("'atomic-trader-watchlist-user:' || v_actor_id::text")
    expect(authority).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(authority).toMatch(
      /SELECT pg_catalog\.count\(\*\)::integer[\s\S]*WHERE watch_row\.user_id = v_actor_id;[\s\S]*IF v_count >= 200 THEN[\s\S]*'limit', 200/
    )
    expect(authority).toContain('ON CONFLICT (user_id, source, source_trader_id) DO NOTHING')
  })

  it('accepts only an exact current source and trader composite on add', () => {
    expect(authority).toContain('p_source IS DISTINCT FROM pg_catalog.lower(p_source)')
    expect(authority).toContain("p_source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(authority).toContain(
      'p_source_trader_id IS DISTINCT FROM pg_catalog.btrim(p_source_trader_id)'
    )
    expect(authority).toContain("source_row.status = 'active'")
    expect(authority).toContain("source_row.serving_mode = 'serving'")
    expect(authority).toContain('trader_row.source_id = source_row.id')
    expect(authority).toContain('trader_row.exchange_trader_id = p_source_trader_id')
    expect(authority).toContain('IF v_identity_count IS DISTINCT FROM 1 THEN')
  })

  it('returns the ordered private list from the mutation transaction', () => {
    expect(authority).toContain("'watchlist', v_watchlist")
    expect(authority).toContain('ORDER BY ordered_watch.created_at DESC, ordered_watch.id DESC')
    expect(authority).toContain(
      'pg_catalog.jsonb_array_length(v_watchlist) IS DISTINCT FROM v_count'
    )
  })
})
