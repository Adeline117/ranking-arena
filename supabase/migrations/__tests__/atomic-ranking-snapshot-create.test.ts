import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260803100500_atomic_ranking_snapshot_create.sql'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/ranking-snapshot/route.ts'), 'utf8')
const contract = readFileSync(resolve(root, 'lib/ranking-snapshots/create-contract.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const launchRunner = readFileSync(
  resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const launchRunnerTest = readFileSync(
  resolve(root, 'scripts/maintenance/apply-launch-migrations.test.mjs'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-ranking-snapshot-create.pg17.sh'),
  'utf8'
)

function functionBody(): string {
  const match = migration.match(
    /CREATE OR REPLACE FUNCTION public\.create_ranking_snapshot_atomic\([\s\S]*?\n\$function\$;/
  )
  expect(match).not.toBeNull()
  return match![0]
}

describe('atomic ranking snapshot create migration contract', () => {
  it('is one replayable bounded forward migration in the predeploy manifest', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.ranking_snapshots:atomic-create:migration'")
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.ranking_snapshot_create_operation_results'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(launchRunner).toContain('20260803100500_atomic_ranking_snapshot_create.sql')
    expect(launchRunnerTest).toContain('assert.equal(predeploy.length, 189)')
    expect(launchRunnerTest).toContain('assert.equal(new Set(all).size, 215)')
  })

  it('keeps the parent private until every child and authoritative row aggregate agree', () => {
    const body = functionBody()
    const parentInsert = body.indexOf('INSERT INTO public.ranking_snapshots')
    const privateValue = body.indexOf('false,', parentInsert)
    const childInsert = body.indexOf('INSERT INTO public.snapshot_traders')
    const authoritativeRead = body.indexOf('INTO v_persisted_traders')
    const exactRows = body.indexOf('v_persisted_traders IS DISTINCT FROM p_traders')
    const publish = body.indexOf('UPDATE public.ranking_snapshots AS target')
    const publicValue = body.indexOf('is_public = true', publish)
    const receiptInsert = body.indexOf(
      'INSERT INTO public.ranking_snapshot_create_operation_results'
    )

    expect(parentInsert).toBeGreaterThan(0)
    expect(privateValue).toBeGreaterThan(parentInsert)
    expect(childInsert).toBeGreaterThan(privateValue)
    expect(authoritativeRead).toBeGreaterThan(childInsert)
    expect(exactRows).toBeGreaterThan(authoritativeRead)
    expect(publish).toBeGreaterThan(exactRows)
    expect(publicValue).toBeGreaterThan(publish)
    expect(receiptInsert).toBeGreaterThan(publicValue)
  })

  it('uses actor plus canonical request ID for durable replay and excludes generated fields from intent', () => {
    const body = functionBody()
    const digestMatch = body.match(
      /v_intent_digest :=[\s\S]*?PERFORM pg_catalog\.pg_advisory_xact_lock/
    )
    expect(digestMatch).not.toBeNull()
    expect(digestMatch![0]).toContain("'ranking-snapshot-create:v1'")
    expect(digestMatch![0]).toContain('p_exchange')
    expect(digestMatch![0]).toContain('p_time_range')
    expect(digestMatch![0]).toContain('p_traders')
    expect(digestMatch![0]).not.toContain('v_snapshot_id')
    expect(digestMatch![0]).not.toContain('v_share_token')
    expect(digestMatch![0]).not.toContain('v_now')
    expect(body).toContain("'ranking-snapshot-create:' || p_actor_id::text || ':' || p_request_id")
    expect(body).toContain("RETURN pg_catalog.jsonb_build_object('status', 'request_conflict')")
    expect(body).toContain("pg_catalog.to_jsonb('replayed'::text)")
  })

  it('enforces complete 1..100 trader rows independently in PostgreSQL', () => {
    const body = functionBody()
    for (const field of [
      'rank',
      'trader_id',
      'handle',
      'source',
      'avatar_url',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'trades_count',
      'followers',
      'arena_score',
      'return_score',
      'drawdown_score',
      'stability_score',
      'data_availability',
    ]) {
      expect(body).toContain(`'${field}'`)
    }
    expect(body).toContain('pg_catalog.jsonb_array_length(p_traders) NOT BETWEEN 1 AND 100')
    expect(body).toContain('v_rank_numeric IS DISTINCT FROM v_ordinality::numeric')
    expect(body).toContain('v_identity = ANY(v_identities)')
  })

  it('is service-only with a physical 15 second database deadline and private replay state', () => {
    expect(migration).toContain("SET statement_timeout = '15s'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*create_ranking_snapshot_atomic[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*create_ranking_snapshot_atomic[\s\S]*TO service_role;/
    )
    expect(migration).toContain(
      'ALTER TABLE public.ranking_snapshot_create_operation_results\n  FORCE ROW LEVEL SECURITY'
    )
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE\n  ON TABLE public.ranking_snapshots, public.snapshot_traders'
    )
    expect(migration).toContain('atomic-ranking-snapshot-create:v1:')
  })

  it('cuts the route to the one authority with exact bounded input and no partial fallback', () => {
    expect(route).toContain(".rpc('create_ranking_snapshot_atomic'")
    expect(route).toContain('p_actor_id: actorId')
    expect(route).toContain('p_request_id: input.request_id')
    expect(route).toContain('.abortSignal(AbortSignal.timeout(15_000))')
    expect(route).not.toContain(".from('ranking_snapshots')")
    expect(route).not.toContain(".from('snapshot_traders')")
    expect(route).not.toContain('.slice(0, 50)')
    expect(contract).toContain('z.literal(RANKING_SNAPSHOT_CREATE_OPERATION)')
    expect(contract).toContain('.min(1)')
    expect(contract).toContain('.max(RANKING_SNAPSHOT_CREATE_MAX_TRADERS)')
    expect(contract).toContain('.strict()')
    expect(contract).toContain('RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES')
    expect(route).toContain("response.headers.set('Cache-Control', 'private, no-store')")
  })

  it('keeps generated Supabase types aligned with the ledger and RPC', () => {
    expect(databaseTypes).toContain('ranking_snapshot_create_operation_results: {')
    expect(databaseTypes).toMatch(
      /create_ranking_snapshot_atomic: \{[\s\S]*p_actor_id: string[\s\S]*p_exchange: string[\s\S]*p_request_id: string[\s\S]*p_time_range: string[\s\S]*p_traders: Json[\s\S]*Returns: Json/
    )
  })

  it('has PostgreSQL 17 atomic failure, replay, concurrency and ACL proofs', () => {
    for (const marker of [
      'exact complete snapshot publication',
      'same actor/request with another logical payload conflicts without publication',
      'any child failure rolls back the private parent and replay receipt',
      'concurrent identical retries serialize to one resource and one replay',
      'service-only RPC, private ledger and browser write closure',
      'atomic ranking snapshot PostgreSQL 17 atomic/replay/ACL proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
