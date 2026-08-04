import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const boundaryMigrationPath =
  'supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql'
const reactionMigrationPath =
  'supabase/migrations/20260803102000_set_post_reaction_desired_state.sql'
const migrationPath = 'supabase/migrations/20260803103000_set_post_vote_desired_state.sql'
const migration = readFileSync(resolve(root, migrationPath), 'utf8')
const boundaryMigration = readFileSync(resolve(root, boundaryMigrationPath), 'utf8')
const reactionMigration = readFileSync(resolve(root, reactionMigrationPath), 'utf8')
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/set-post-vote-desired-state.pg17.sh'),
  'utf8'
)
const productionAttestation = readFileSync(
  resolve(root, 'docs/sql/post-vote-desired-state-attestation.sql'),
  'utf8'
)
const runbook = readFileSync(resolve(root, 'docs/POST_VOTE_DESIRED_STATE_2026-08-03.md'), 'utf8')

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = migration.indexOf('AS $function$', start)
  const end = migration.indexOf('$function$;', bodyStart)
  expect(bodyStart).toBeGreaterThan(start)
  expect(end).toBeGreaterThan(bodyStart)
  return migration.slice(start, end)
}

describe('built-in post vote desired-state migration', () => {
  it('is a transactional 1010 -> 1020 -> 1030 predeploy', () => {
    expect(boundaryMigration).toContain('post interaction child boundary migration lock is busy')
    expect(reactionMigration).toContain('post-reaction-desired-state:v1:')
    expect(boundaryMigrationPath).toMatch(/20260803101000/)
    expect(reactionMigrationPath).toMatch(/20260803102000/)
    expect(migrationPath).toMatch(/20260803103000/)
    expect(migration).toContain('20260803101000')
    expect(migration).toContain('20260803102000')
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("'public.post_votes:desired-state:migration'")
    const locks = [
      'LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE public.post_votes IN SHARE ROW EXCLUSIVE MODE',
    ]
    let cursor = -1
    for (const marker of locks) {
      const next = migration.indexOf(marker)
      expect(next).toBeGreaterThan(cursor)
      cursor = next
    }
    expect(cursor).toBeLessThan(migration.indexOf('DO $preflight$'))
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes exact bull/bear/wait/SQL-NULL desired state and nested poll ACK', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.set_post_vote_desired_state_atomic('
    )
    expect(migration).toContain('p_actor_id uuid,\n  p_post_id uuid,\n  p_desired_choice text')
    expect(migration).toContain("ARRAY['p_actor_id', 'p_post_id', 'p_desired_choice']::text[]")

    const desired = functionBody('set_post_vote_desired_state_atomic')
    expect(desired).toContain("p_desired_choice NOT IN ('bull', 'bear', 'wait')")
    expect(desired).toContain("jsonb_build_object('status', 'invalid')")
    expect(desired).toContain("jsonb_build_object('status', 'not_found')")
    for (const action of ['added', 'removed', 'changed', 'unchanged']) {
      expect(desired).toContain(`v_action := '${action}'`)
    }
    for (const choice of ['bull', 'bear', 'wait']) {
      expect(desired).toContain(`vote.choice = '${choice}'`)
      expect(desired).toContain(`'${choice}', v_returned_${choice}`)
    }
    for (const key of ['status', 'action', 'vote', 'poll']) {
      expect(desired).toContain(`'${key}'`)
    }
  })

  it('keeps retries idempotent and repairs all absolute caches on unchanged', () => {
    const desired = functionBody('set_post_vote_desired_state_atomic')
    const absentNoop = desired.indexOf('IF p_desired_choice IS NULL THEN')
    const sameState = desired.indexOf('ELSIF v_existing_choice = p_desired_choice THEN')
    const recount = desired.indexOf('count(*) FILTER')
    const counterWrite = desired.indexOf('UPDATE public.posts AS target')

    expect(absentNoop).toBeGreaterThan(0)
    expect(sameState).toBeGreaterThan(absentNoop)
    expect(recount).toBeGreaterThan(sameState)
    expect(counterWrite).toBeGreaterThan(recount)
    expect(desired).toContain('Recount even for unchanged/no-row requests')
    expect(desired).toContain('poll_bull = v_bull::integer')
    expect(desired).toContain('poll_bear = v_bear::integer')
    expect(desired).toContain('poll_wait = v_wait::integer')
  })

  it('enforces poll eligibility while preserving disabled-post cleanup', () => {
    const desired = functionBody('set_post_vote_desired_state_atomic')
    const legacy = functionBody('toggle_post_vote_atomic')

    for (const source of [desired, legacy]) {
      expect(source).toContain('SELECT target.poll_enabled')
      expect(source).toContain('v_poll_enabled IS DISTINCT FROM true')
    }
    expect(desired).toMatch(
      /IF p_desired_choice IS NOT NULL\s+AND v_poll_enabled IS DISTINCT FROM true/
    )
    expect(legacy).not.toContain('p_desired_choice')
    expect(runbook).toContain('desired SQL `NULL` remains allowed on a disabled post')
  })

  it('bridges legacy vote and both reaction authorities through one post-wide domain', () => {
    const desired = functionBody('set_post_vote_desired_state_atomic')
    const legacy = functionBody('toggle_post_vote_atomic')

    for (const source of [desired, legacy]) {
      const order = [
        "'post-reaction-counts:'",
        "'post-vote:'",
        'FROM auth.users AS actor_account',
        'public.lock_actor_can_interact_with_post',
        'SELECT target.poll_enabled',
        'FROM public.post_votes AS vote',
        'count(*) FILTER',
        'UPDATE public.posts AS target',
      ]
      let cursor = -1
      for (const marker of order) {
        const next = source.indexOf(marker)
        expect(next).toBeGreaterThan(cursor)
        cursor = next
      }
    }

    for (const source of [migration, productionAttestation]) {
      expect(source).toContain('public.toggle_post_reaction(uuid,uuid,text)')
      expect(source).toContain('public.set_post_reaction_desired_state_atomic(uuid,uuid,text)')
      expect(source).toContain('post-reaction-desired-state:legacy-v2:')
      expect(source).toContain('post-reaction-desired-state:v1:')
      expect(source).toContain("'''post-reaction-counts:'''")
      expect(source).toContain('shared reaction/vote post counter')
    }
  })

  it('retains the exact no-default legacy signature and three-way ACK', () => {
    const legacy = functionBody('toggle_post_vote_atomic')
    expect(legacy).toContain('p_actor_id uuid,\n  p_post_id uuid,\n  p_choice text')
    expect(legacy).not.toContain('DEFAULT')
    expect(legacy).toContain("p_choice NOT IN ('bull', 'bear', 'wait')")
    expect(legacy).toContain("v_action := 'removed'")
    expect(legacy).toContain("v_action := 'added'")
    expect(legacy).toContain("v_action := 'changed'")
    expect(legacy).toContain("'poll', pg_catalog.jsonb_build_object")
    expect(migration).not.toContain('DROP FUNCTION public.toggle_post_vote_atomic')
  })

  it('fails closed on schema, RLS, ACL, trigger, audience, and source drift', () => {
    const markers = [
      'index_row.indisunique',
      'index_row.indisvalid',
      'index_row.indisready',
      'index_row.indpred IS NULL',
      'index_row.indexprs IS NULL',
      'index_row.indnatts = 2',
      "ARRAY['post_id', 'user_id']::text[]",
      "constraint_row.contype = 'p'",
      "constraint_row.confdeltype = 'c'",
      "constraint_row.confrelid = 'public.posts'::pg_catalog.regclass",
      "constraint_row.confrelid = 'auth.users'::pg_catalog.regclass",
      'post_votes_choice_desired_state_check',
      'choice = ANY',
      'post_votes_select_own_canonical',
      "'(( SELECT auth.uid() AS uid)) = user_id'",
      'trg_post_votes_15_current_interaction',
      'public.enforce_current_post_child_interaction()',
      "v_id_default IS DISTINCT FROM 'gen_random_uuid()'",
      'pg_catalog.aclexplode',
      'acl_entry.is_grantable',
    ]
    for (const marker of markers) {
      expect(migration).toContain(marker)
      expect(productionAttestation).toContain(marker)
    }
    expect(migration).toContain('contains % invalid vote rows')
  })

  it('pins both RPCs to postgres-owned service-only source-attested definitions', () => {
    for (const source of [migration, productionAttestation]) {
      expect(source).toContain('function_row.proowner = v_postgres_oid')
      expect(source).toContain('function_row.prosecdef')
      expect(source).toContain('function_row.prolang = v_plpgsql_oid')
      expect(source).toContain("function_row.proparallel = 'u'")
      expect(source).toContain('NOT function_row.proleakproof')
      expect(source).toContain("'search_path=pg_catalog, pg_temp'")
      expect(source).toContain("'row_security=off'")
      expect(source).toContain("'lock_timeout=5s'")
      expect(source).toContain("'statement_timeout=15s'")
      expect(source).toContain("'service_role', v_function, 'EXECUTE'")
      expect(source).toContain('post-vote-desired-state:legacy-v2:')
      expect(source).toContain('post-vote-desired-state:v1:')
    }
  })

  it('ships executable PG17 coverage and an honest read-only runbook/attestation', () => {
    for (const marker of [
      '20260803101000',
      '20260803102000',
      '20260803103000',
      'set_post_vote_desired_state_atomic',
      'toggle_post_vote_atomic',
      'post-reaction-counts:',
      'wait_event_type',
      'deadlock detected',
      'account',
      'invalid historical',
      'vote table and column ACL drift fail closed',
      'psql_cmd -f "$ATTESTATION"',
    ]) {
      expect(pg17Proof).toContain(marker)
    }

    expect(productionAttestation).toContain('BEGIN;\nSET TRANSACTION READ ONLY;')
    expect(productionAttestation).toContain('post vote desired-state production attestation passed')
    expect(productionAttestation).toContain('P1 RELEASE GATE')
    expect(productionAttestation.trimEnd()).toMatch(/ROLLBACK;$/)

    for (const marker of [
      '20260803101000_close_post_interaction_child_direct_writes.sql',
      '20260803102000_set_post_reaction_desired_state.sql',
      'set_post_vote_desired_state_atomic',
      'SQL `NULL`',
      'poll_enabled',
      'post-reaction-counts:',
      'post-vote:',
      'service_role',
      'unchanged',
      'legacy',
      'PG17',
      'post-vote-desired-state-attestation.sql',
      'app/lib',
      'hard-delete',
      'direct service-role',
      'bookmark',
    ]) {
      expect(runbook).toContain(marker)
    }
  })
})
