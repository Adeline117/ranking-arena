import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716104500_collection_read_write_boundaries.sql'),
  'utf8'
)

describe('collection read/write boundaries migration', () => {
  it('is replayable and owns both collection tables explicitly', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("pg_catalog.to_regclass('public.user_collections')")
    expect(migration).toContain("pg_catalog.to_regclass('public.collection_items')")
    expect(migration).toContain('ALTER TABLE public.user_collections ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('DROP POLICY %I ON public.%I')
  })

  it('keeps only public or owner reads for collections and their items', () => {
    expect(migration).toContain('CREATE POLICY user_collections_public_or_owner_read')
    expect(migration).toContain('CREATE POLICY collection_items_public_or_owner_read')
    expect(migration).toContain('COALESCE(is_public, false)')
    expect(migration).toContain('user_id = (SELECT auth.uid())')
    expect(migration).toMatch(
      /FROM public\.user_collections AS collection[\s\S]*?collection\.id = collection_items\.collection_id/
    )
    expect(migration).toContain('GRANT SELECT ON public.user_collections TO anon, authenticated')
    expect(migration).toContain('GRANT SELECT ON public.collection_items TO anon, authenticated')
  })

  it('revokes table and column writes from browser roles', () => {
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON public.%I FROM PUBLIC, anon, authenticated'
    )
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain('INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    expect(migration).toContain('INSERT,UPDATE,REFERENCES')
    expect(migration).toContain('collection JWT write privilege remains on public.%')
    expect(migration).toContain('collection JWT mutation policy remains on public.%')
  })

  it('retains a service-only mutation path and installation assertions', () => {
    expect(migration.match(/CREATE POLICY server_role_mutation/g)).toHaveLength(2)
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_collections TO service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_items TO service_role'
    )
    expect(migration).toContain('collection table ACL is incomplete on public.%')
    expect(migration).toContain('collection read boundary is incomplete')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })
})
