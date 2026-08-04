import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260804051000_harden_serving_source_capabilities.sql'),
  'utf8'
)

const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.arena_source_capabilities'),
  migration.indexOf('ALTER FUNCTION public.arena_source_capabilities')
)

describe('active-serving source capability boundary', () => {
  it('joins materialized capabilities to the live source authority', () => {
    expect(functionBody).toContain('FROM arena.mv_source_capabilities AS capability')
    expect(functionBody).toContain('JOIN arena.sources AS source_row')
    expect(functionBody).toContain('ON source_row.slug = capability.slug')
    expect(functionBody).toMatch(
      /WHERE source_row\.status = 'active'\s+AND source_row\.serving_mode = 'serving'/
    )
  })

  it('overwrites the cached lifecycle value with the live serving state', () => {
    expect(functionBody).toContain(
      "capability.cap || pg_catalog.jsonb_build_object(\n        'servingMode', source_row.serving_mode"
    )
    expect(functionBody).toContain("'{}'::pg_catalog.jsonb")
  })

  it('fails closed on schema drift and hardens the definer ACL', () => {
    expect(migration).toContain("to_regclass('arena.sources')")
    expect(migration).toContain("to_regclass('arena.mv_source_capabilities')")
    expect(migration).toContain("attribute.attname = 'status'")
    expect(migration).toContain("attribute.attname = 'serving_mode'")
    expect(functionBody).toContain('SECURITY DEFINER')
    expect(functionBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.arena_source_capabilities()\n  FROM PUBLIC, anon, authenticated, service_role'
    )
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
