import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const authority = readFileSync(
  resolve(root, 'supabase/migrations/20260729062000_atomic_trader_follow_limit.sql'),
  'utf8'
)
const cutover = readFileSync(
  resolve(root, 'supabase/migrations/20260729063000_close_trader_follow_direct_writes.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-trader-follow-limit.pg17.sh'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/follow/route.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const launchRunner = readFileSync(
  resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const end = source.indexOf(`ALTER FUNCTION public.${name}(`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('atomic trader follow limit authority', () => {
  it('keeps the additive RPC separate from the postdeploy direct-write closure', () => {
    expect(authority).toContain('CREATE OR REPLACE FUNCTION public.mutate_trader_follow_atomic')
    expect(authority).not.toContain('REVOKE INSERT, UPDATE, DELETE')
    expect(authority).not.toContain('DROP POLICY')

    expect(cutover).toContain('Postdeploy cutover')
    expect(cutover).toContain('DROP POLICY IF EXISTS "Service manage trader_follows"')
    expect(cutover).toContain('DROP POLICY IF EXISTS "Users can follow traders"')
    expect(cutover).toContain('DROP POLICY IF EXISTS "Users can unfollow traders"')
    expect(cutover).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE')

    const predeploy = launchRunner.slice(
      launchRunner.indexOf('PREDEPLOY_MIGRATIONS=('),
      launchRunner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const postdeploy = launchRunner.slice(
      launchRunner.indexOf('POSTDEPLOY_MIGRATIONS=('),
      launchRunner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=(')
    )
    expect(predeploy).toContain('20260729062000_atomic_trader_follow_limit.sql')
    expect(predeploy).not.toContain('20260729063000_close_trader_follow_direct_writes.sql')
    expect(postdeploy).toContain('20260729063000_close_trader_follow_direct_writes.sql')
    expect(postdeploy).not.toContain('20260729062000_atomic_trader_follow_limit.sql')
  })

  it('serializes the exact limit, identity and mutation in one service-only transaction', () => {
    const body = functionBody(authority, 'mutate_trader_follow_atomic')

    expect(body).toContain('SECURITY DEFINER')
    expect(body).toContain('SET search_path = pg_catalog, pg_temp')
    expect(body).toContain('SET row_security = off')
    expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(body).toContain("'atomic-trader-follow-user:' || p_actor_id::text")
    expect(body).toContain('FOR UPDATE')
    expect(body).toContain('public.has_current_global_pro_entitlement(p_actor_id)')
    expect(body).toContain('p_promo_unlocked')
    expect(body).toContain('SELECT pg_catalog.count(*)::integer')
    expect(body).toContain('INSERT INTO public.trader_follows')
    expect(body).toContain('ON CONFLICT (user_id, trader_id, source)')
    expect(body).toContain('DELETE FROM public.trader_follows')
    expect(body).toContain('GET DIAGNOSTICS v_mutated = ROW_COUNT')
  })

  it('pins the source-scoped uniqueness and exact EXECUTE/table ACL boundaries', () => {
    expect(authority).toContain('index_row.indnullsnotdistinct')
    expect(authority).toContain("= ARRAY['user_id', 'trader_id', 'source']::name[]")
    expect(authority).toMatch(
      /REVOKE ALL ON FUNCTION public\.mutate_trader_follow_atomic\([\s\S]+FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(authority).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.mutate_trader_follow_atomic\([\s\S]+TO service_role;/
    )
    expect(cutover).toContain("policy.polcmd IN ('*', 'a', 'w', 'd')")
    expect(cutover).toContain('pg_catalog.has_table_privilege(')
    expect(cutover).toContain('pg_catalog.has_function_privilege(')
  })

  it('cuts POST over without a count, subscription read or table mutation fallback', () => {
    const post = route.slice(route.indexOf('export const POST'))

    expect(post).toContain("'mutate_trader_follow_atomic'")
    expect(post).toContain('parseMutationAck(rawAck)')
    expect(post).toContain('ack.userId !== user.id')
    expect(post).toContain('ack.traderId !== traderId')
    expect(post).toContain('ack.source !== source')
    expect(post).not.toContain(".from('trader_follows')")
    expect(post).not.toContain(".from('subscriptions')")
    expect(post).not.toContain('.insert(')
    expect(post).not.toContain('.delete(')
    expect(post).not.toContain('.update(')
  })

  it('keeps the generated RPC contract aligned', () => {
    for (const marker of [
      'mutate_trader_follow_atomic:',
      'p_action: string',
      'p_actor_id: string',
      'p_free_limit: number',
      'p_pro_limit: number',
      'p_promo_unlocked: boolean',
      'p_source: string | null',
      'p_trader_id: string',
    ]) {
      expect(databaseTypes).toContain(marker)
    }
  })

  it('proves count failure, concurrency, replay, ACLs and old-client closure on PG17', () => {
    for (const marker of [
      'authenticated atomic follow execution is closed',
      'free follow replay',
      'concurrent follow did not serialize',
      'count error was treated as zero',
      'count error inserts no edge',
      'old authenticated insert is rejected',
      'old authenticated delete is rejected',
      'old authenticated update is rejected',
      'direct service insert is rejected',
      'service authority survives direct-write closure',
      'legacy null-source unfollow',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
