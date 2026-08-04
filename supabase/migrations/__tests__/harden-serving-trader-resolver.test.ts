import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260804050500_harden_serving_trader_resolver.sql'),
  'utf8'
)

const resolverBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.arena_resolve_trader'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.arena_resolve_trader')
)

describe('active-serving trader resolver boundary', () => {
  it('fails closed when the lifecycle schema or execution roles drift', () => {
    expect(migration).toContain("to_regclass('arena.sources')")
    expect(migration).toContain("to_regclass('arena.traders')")
    expect(migration).toContain("attribute.attname = 'status'")
    expect(migration).toContain("attribute.attname = 'serving_mode'")

    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`to_regrole('${role}')`)
    }
  })

  it('requires active and serving before either identity match can resolve', () => {
    expect(resolverBody).toMatch(
      /WHERE source_row\.status = 'active'\s+AND source_row\.serving_mode = 'serving'\s+AND \(/
    )
    expect(resolverBody.match(/source_row\.status = 'active'/g)).toHaveLength(1)
    expect(resolverBody.match(/source_row\.serving_mode = 'serving'/g)).toHaveLength(1)
    expect(resolverBody).not.toMatch(
      /source_row\.(?:status|serving_mode)[^\n]*\bOR\b[^\n]*source_row\.(?:status|serving_mode)/
    )
    expect(resolverBody).toContain('trader_row.exchange_trader_id = p_handle')
    expect(resolverBody).toContain(
      'pg_catalog.lower(trader_row.nickname) = pg_catalog.lower(p_handle)'
    )
  })

  it('preserves source aliasing, region binding, and exact-id precedence', () => {
    expect(resolverBody).toContain("'fetchRegion', source_row.fetch_region")
    expect(resolverBody).toContain("'source', source_row.slug")
    expect(resolverBody).toContain("source_row.meta ->> 'legacy_platform' = p_source")
    expect(resolverBody).toContain('(trader_row.exchange_trader_id = p_handle) DESC')
    expect(resolverBody).toContain('trader_row.last_seen_at DESC NULLS LAST')
    expect(resolverBody).toContain('LIMIT 1')
  })

  it('retains the hardened SECURITY DEFINER and least-privilege ACL contract', () => {
    expect(resolverBody).toContain('STABLE')
    expect(resolverBody).toContain('SECURITY DEFINER')
    expect(resolverBody).toContain('SET search_path = public, arena, pg_temp')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.arena_resolve_trader(text, text)\n  FROM PUBLIC'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text)\n  TO anon, authenticated, service_role'
    )
    expect(migration).toContain('pg_catalog.pg_get_functiondef')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
