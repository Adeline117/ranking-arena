import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718131000_source_scope_trader_follow_activity.sql'),
  'utf8'
)

describe('source-scoped trader follow activity trigger', () => {
  it('resolves handles only through the exact source account', () => {
    expect(migration).toContain('source_row.source = NEW.source')
    expect(migration).toContain('source_row.source_trader_id = NEW.trader_id')
    expect(migration).toContain('IF NEW.source IS NOT NULL')
    expect(migration).not.toMatch(/WHERE\s+source_trader_id\s*=\s*NEW\.trader_id\s+OR/)
  })

  it('preserves the old target id while publishing composite metadata', () => {
    expect(migration).toContain('NEW.trader_id::text')
    expect(migration).toContain("'source', NEW.source")
    expect(migration).toContain(
      "'identity_key', pg_catalog.jsonb_build_array(NEW.trader_id, NEW.source)"
    )
  })

  it('keeps follow writes fail-soft and locks function resolution', () => {
    expect(migration).toContain('EXCEPTION WHEN OTHERS')
    expect(migration).toContain('RETURN NEW')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
