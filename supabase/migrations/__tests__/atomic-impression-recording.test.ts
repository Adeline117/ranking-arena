import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716112200_atomic_impression_recording.sql'),
  'utf8'
)

describe('atomic impression recording migration', () => {
  it('is bounded, transactional, and documents the staged route cutover', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('must not be deployed before this migration')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires the exact valid partial unique impression key', () => {
    for (const fragment of [
      'index_metadata.indisunique',
      'index_metadata.indisvalid',
      'index_metadata.indisready',
      "ARRAY['user_id', 'target_type', 'target_id']::name[]",
      "= '(action = ''impression''::text)'",
    ]) {
      expect(migration).toContain(fragment)
    }
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('LOCK TABLE public.user_interactions')
    )
  })

  it('closes direct browser storage access without breaking service CRUD', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.user_interactions\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('DO $revoke_column_privileges$')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.user_interactions\s+TO service_role/
    )
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages user interactions"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
  })

  it('publishes one service-only function with bounded object metadata', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION public\.record_post_impression\([\s\S]*p_user_id uuid,[\s\S]*p_post_id uuid,[\s\S]*p_metadata jsonb DEFAULT NULL[\s\S]*RETURNS boolean[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain("jsonb_typeof(p_metadata) <> 'object'")
    expect(migration).toContain('pg_column_size(p_metadata) > 8192')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_post_impression\(uuid, uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_post_impression\(uuid, uuid, jsonb\)\s+TO service_role/
    )
  })

  it('makes every service insert authorize and increment through one trigger', () => {
    expect(migration).toContain('public.lock_actor_can_interact_with_post(v_post_id, NEW.user_id)')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_record_post_impression_counter[\s\S]*AFTER INSERT ON public\.user_interactions[\s\S]*WHEN \(NEW\.action = 'impression' AND NEW\.target_type = 'post'\)[\s\S]*EXECUTE FUNCTION public\.apply_post_impression_insert\(\)/
    )
    expect(migration).toMatch(
      /UPDATE public\.posts[\s\S]*impression_count = COALESCE\(impression_count, 0\) \+ 1/
    )
    expect(migration).toContain('IF NOT FOUND THEN')
    expect(migration).toContain('The unique dedup fact can never')
  })

  it('deduplicates in the service RPC and lets the trigger own its increment', () => {
    expect(migration).toMatch(
      /INSERT INTO public\.user_interactions[\s\S]*ON CONFLICT \(user_id, target_type, target_id\)[\s\S]*WHERE action = 'impression'[\s\S]*DO NOTHING[\s\S]*RETURNING true INTO v_inserted/
    )
    expect(migration).toMatch(
      /IF NOT COALESCE\(v_inserted, false\) THEN[\s\S]*RETURN false;[\s\S]*RETURN true;/
    )
    expect(migration).toContain('canonical AFTER INSERT trigger')
  })

  it('turns the legacy follow-up increment into a guarded compatibility no-op', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION public\.increment_impression_count\(post_id uuid\)[\s\S]*RETURNS void[\s\S]*SECURITY DEFINER[\s\S]*service role required[\s\S]*Intentionally empty/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.increment_impression_count\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.increment_impression_count\(uuid\)\s+TO service_role/
    )
  })

  it('strictly verifies storage, policy, function, and execute contracts', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('policy.polroles = ARRAY[v_service_role_oid]::oid[]')
    expect(migration).toContain("function_row.prorettype = 'boolean'::regtype")
    expect(migration).toContain('trg_record_post_impression_counter')
    expect(migration).toContain("function_row.prorettype = 'void'::regtype")
    expect(migration).toContain('pg_catalog.has_function_privilege')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
