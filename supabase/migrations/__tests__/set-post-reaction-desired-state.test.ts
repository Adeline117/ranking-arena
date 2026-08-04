import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const boundaryMigrationPath =
  'supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql'
const migrationPath = 'supabase/migrations/20260803102000_set_post_reaction_desired_state.sql'
const migration = readFileSync(resolve(root, migrationPath), 'utf8')
const boundaryMigration = readFileSync(resolve(root, boundaryMigrationPath), 'utf8')
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/set-post-reaction-desired-state.pg17.sh'),
  'utf8'
)
const productionAttestation = readFileSync(
  resolve(root, 'docs/sql/post-reaction-desired-state-attestation.sql'),
  'utf8'
)
const runbook = readFileSync(
  resolve(root, 'docs/POST_REACTION_DESIRED_STATE_2026-08-03.md'),
  'utf8'
)

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = migration.indexOf('AS $function$', start)
  const end = migration.indexOf('$function$;', bodyStart)
  expect(bodyStart).toBeGreaterThan(start)
  expect(end).toBeGreaterThan(bodyStart)
  return migration.slice(start, end)
}

describe('post reaction desired-state migration', () => {
  it('is an ordered transactional postdeploy after the child-write boundary', () => {
    expect(boundaryMigration).toContain('post interaction child boundary migration lock is busy')
    expect(boundaryMigrationPath).toMatch(/20260803101000/)
    expect(migrationPath).toMatch(/20260803102000/)
    expect(migration).toContain('20260803101000_close_post_interaction_child_direct_writes.sql')
    expect(migration).toContain(
      '20260803101000 and canonical post reaction authorities must deploy first'
    )
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("'public.post_likes:desired-state:migration'")
    expect(migration).toContain('LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE public.post_likes IN SHARE ROW EXCLUSIVE MODE')
    expect(migration.indexOf('LOCK TABLE auth.users')).toBeLessThan(
      migration.indexOf('DO $preflight$')
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('exposes an exact no-default up/down/SQL-NULL desired-state contract', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.set_post_reaction_desired_state_atomic('
    )
    expect(migration).toContain('p_actor_id uuid,\n  p_post_id uuid,\n  p_desired_reaction text')
    expect(migration).toContain("'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'")
    expect(migration).toContain("ARRAY['p_actor_id', 'p_post_id', 'p_desired_reaction']::text[]")
    expect(migration).toContain('function_row.pronargdefaults = v_expected.default_count')

    const desired = functionBody('set_post_reaction_desired_state_atomic')
    expect(desired).toContain('p_desired_reaction IS NOT NULL')
    expect(desired).toContain("p_desired_reaction NOT IN ('up', 'down')")
    expect(desired).toContain("jsonb_build_object('status', 'invalid')")
    expect(desired).toContain("jsonb_build_object('status', 'not_found')")
    for (const action of ['added', 'removed', 'changed', 'unchanged']) {
      expect(desired).toContain(`v_action := '${action}'`)
    }
    for (const key of ['status', 'action', 'reaction', 'like_count', 'dislike_count']) {
      expect(desired).toContain(`'${key}'`)
    }
  })

  it('never turns a repeated desired value back into a toggle edge', () => {
    const desired = functionBody('set_post_reaction_desired_state_atomic')
    const absentNoop = desired.indexOf('IF p_desired_reaction IS NULL THEN')
    const sameState = desired.indexOf('ELSIF v_existing_type = p_desired_reaction THEN')
    const unchanged = desired.lastIndexOf(
      "v_action := 'unchanged'",
      desired.indexOf('-- Recount even')
    )
    const recount = desired.indexOf('count(*) FILTER')
    const counterWrite = desired.indexOf('UPDATE public.posts AS target')

    expect(absentNoop).toBeGreaterThan(0)
    expect(sameState).toBeGreaterThan(absentNoop)
    expect(unchanged).toBeGreaterThan(sameState)
    expect(recount).toBeGreaterThan(unchanged)
    expect(counterWrite).toBeGreaterThan(recount)
    expect(desired).toContain('Recount even for unchanged/no-row requests')
  })

  it('serializes both desired and legacy writers in one post-wide counter domain', () => {
    const desired = functionBody('set_post_reaction_desired_state_atomic')
    const legacy = functionBody('toggle_post_reaction')

    for (const source of [desired, legacy]) {
      const lockOrder = [
        "'post-reaction-counts:'",
        "'post-reaction:'",
        'FROM auth.users AS actor_account',
        'public.lock_actor_can_interact_with_post',
        'FROM public.post_likes AS reaction',
        'count(*) FILTER',
        'UPDATE public.posts AS target',
      ]
      let cursor = -1
      for (const marker of lockOrder) {
        const next = source.indexOf(marker)
        expect(next).toBeGreaterThan(cursor)
        cursor = next
      }
    }

    expect(migration).not.toContain('DROP FUNCTION public.toggle_post_reaction')
    expect(legacy).toContain("p_reaction_type text DEFAULT 'up'")
    expect(legacy).toContain("v_action := 'removed'")
    expect(legacy).toContain("v_action := 'added'")
    expect(legacy).toContain("v_action := 'changed'")
  })

  it('fails closed on the child identity, cascade, reaction-domain, and RLS shape', () => {
    for (const marker of [
      'index_row.indisunique',
      'index_row.indisvalid',
      'index_row.indisready',
      'index_row.indpred IS NULL',
      'index_row.indexprs IS NULL',
      "ARRAY['post_id', 'user_id']::text[]",
      'constraint_row.convalidated',
      "constraint_row.contype = 'p'",
      "constraint_row.confdeltype = 'c'",
      "constraint_row.confrelid = 'public.posts'::pg_catalog.regclass",
      "constraint_row.confrelid = 'auth.users'::pg_catalog.regclass",
      'post_likes_reaction_type_desired_state_check',
      'reaction_type = ANY',
      'post_likes_select_own_canonical',
      "'(( SELECT auth.uid() AS uid)) = user_id'",
      'pg_catalog.pg_attrdef',
      "v_id_default IS DISTINCT FROM 'gen_random_uuid()'",
    ]) {
      expect(migration).toContain(marker)
      expect(productionAttestation).toContain(marker)
    }
    expect(migration).toContain('contains % invalid reaction rows')
  })

  it('pins postgres ownership, SECURITY DEFINER config, service ACL, and source digests', () => {
    for (const source of [migration, productionAttestation]) {
      expect(source).toContain('function_row.proowner = v_postgres_oid')
      expect(source).toContain('function_row.prosecdef')
      expect(source).toContain('function_row.prolang = v_plpgsql_oid')
      expect(source).toContain('NOT function_row.proisstrict')
      expect(source).toContain("function_row.proparallel = 'u'")
      expect(source).toContain('NOT function_row.proleakproof')
      expect(source).toContain("'search_path=pg_catalog, pg_temp'")
      expect(source).toContain("'row_security=off'")
      expect(source).toContain("'lock_timeout=5s'")
      expect(source).toContain("'statement_timeout=15s'")
      expect(source).toContain("'service_role', v_function, 'EXECUTE'")
      expect(source).toContain("'authenticated', v_function, 'EXECUTE'")
      expect(source).toContain('pg_catalog.aclexplode')
      expect(source).toContain('acl_entry.is_grantable')
      expect(source).toContain('pg_catalog.md5(v_source)')
      expect(source).toContain('post-reaction-desired-state:legacy-v2:')
      expect(source).toContain('post-reaction-desired-state:v1:')
    }
  })

  it('has PostgreSQL 17 proof for replay, concurrency, lifecycle locking, and drift', () => {
    for (const marker of [
      'desired-state migration fails closed until the child-boundary dependency exists',
      'invalid plus missing account/post and audience-denial ACKs are exact and side-effect free',
      'desired-state authority is service-role only',
      'canonical audience helper remains internal-only behind owner-executed RPCs',
      'missing historical post_likes id default converges before explicit-UUID writers publish',
      'absent/add/replay/change/remove/null replay are idempotent and repair absolute counters',
      'legacy valid up/down toggle semantics remain callable while explicit NULL now fails cleanly',
      'different actors on one post serialize and leave child truth equal to cached counters',
      'concurrent duplicate desired intent applies one edge and one unchanged replay',
      'legacy and desired-state writers share the post-wide rolling-deploy bridge',
      'account hard delete waits without deadlock; a no-op desired call repairs cascade counter drift',
      'clean migration replay succeeds',
      'replay converges RPC ACL/grant-option/config, id default, constraint, and source attestations',
      'invalid historical reaction rows fail closed before constraint convergence',
      'primary/composite identity, cascade FK, and internal audience ACL drift fail closed',
      'post reaction desired-state PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
    expect(pg17Proof).toContain("wait_event_type = 'Lock'")
    expect(pg17Proof).toContain('deadlock detected')
    expect(pg17Proof).toContain('psql_cmd -f "$ATTESTATION"')
  })

  it('ships a read-only production attestation and an honest rollout runbook', () => {
    expect(productionAttestation).toContain('BEGIN;\nSET TRANSACTION READ ONLY;')
    expect(productionAttestation).toContain(
      'post reaction desired-state production attestation passed'
    )
    expect(productionAttestation).toContain('P1 RELEASE GATE')
    expect(productionAttestation.trimEnd()).toMatch(/ROLLBACK;$/)

    for (const marker of [
      '20260803101000_close_post_interaction_child_direct_writes.sql',
      'set_post_reaction_desired_state_atomic',
      'SQL `NULL`',
      'post-reaction-counts:',
      'post-reaction:',
      'service_role',
      'unchanged',
      'legacy',
      'PG17',
      'post-reaction-desired-state-attestation.sql',
      'app/lib',
      'hard delete',
    ]) {
      expect(runbook).toContain(marker)
    }
  })
})
