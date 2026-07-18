import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260717120000_trader_follows_composite_identity.sql'),
  'utf8'
)

describe('trader follows composite identity migration', () => {
  it('backfills only a uniquely resolved current account', () => {
    expect(migration).toContain("leaderboard.season_id = '90D'")
    expect(migration).toContain("leaderboard.computed_at >= pg_catalog.now() - interval '5 days'")
    expect(migration).toContain("source_row.status = 'active'")
    expect(migration).toContain("source_row.serving_mode = 'serving'")
    expect(migration).toContain("(source_row.meta ->> 'legacy_platform') IS DISTINCT FROM 'null'")
    expect(migration).toContain('HAVING pg_catalog.count(DISTINCT source) = 1')
  })

  it('preserves and reports ambiguous or unresolved legacy null edges', () => {
    expect(migration).toContain('HAVING pg_catalog.count(DISTINCT source) > 1')
    expect(migration).toContain('v_unresolved')
    expect(migration).toContain('rows remain source=NULL')
    expect(migration).not.toMatch(/ALTER COLUMN source SET NOT NULL/)
  })

  it('replaces raw-id uniqueness with null-safe composite uniqueness', () => {
    expect(migration).toContain('DROP CONSTRAINT trader_follows_user_id_trader_id_key')
    expect(migration).toMatch(
      /ADD CONSTRAINT trader_follows_user_id_trader_id_source_key\s+UNIQUE NULLS NOT DISTINCT \(user_id, trader_id, source\)/
    )
    expect(migration).toContain('index_row.indnullsnotdistinct')
  })
})
