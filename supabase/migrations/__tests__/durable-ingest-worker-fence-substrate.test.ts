import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationName = '20260725011000_durable_ingest_worker_fence_substrate.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/durable-ingest-worker-fence-substrate.pg17.sh'),
  'utf8'
)

function functionBody(signature: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE FUNCTION ${signature}`)
  const end = migration.indexOf(nextMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('durable ingest-worker fence substrate migration', () => {
  it('is one atomic, additive and deliberately inert substrate migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    expect(migration).toContain('Migration A')
    expect(migration).toContain('does not enforce')
    expect(migration).not.toMatch(
      /CREATE TRIGGER\s+require_ingest_worker_fence[\s\S]*ON\s+(?:arena|public)\.(?:leaderboard|raw_|trader|position|notification)/i
    )
    expect((migration.match(/CREATE CONSTRAINT TRIGGER/g) ?? []).length).toBe(1)
  })

  it('uses PostgreSQL-owned, non-reusable epochs and strict authority records', () => {
    expect(migration).toMatch(
      /CREATE SEQUENCE arena\.ingest_worker_fence_epoch_seq[\s\S]*AS bigint[\s\S]*MINVALUE 1[\s\S]*MAXVALUE 9007199254740000[\s\S]*NO CYCLE/
    )
    for (const table of [
      'ingest_worker_instances',
      'ingest_worker_authorities',
      'ingest_worker_activations',
      'ingest_worker_write_guards',
    ]) {
      expect(migration).toContain(`CREATE TABLE arena.${table}`)
    }
    expect(migration).toContain("('region:local')")
    expect(migration).toContain("('region:vps_sg')")
    expect(migration).toContain('epoch_high_water')
    expect(migration).toContain('owner_token_digest')
    expect(migration).toContain('lease_expires_at')
    expect(migration).toContain('top_xid8_text')
    expect(migration).toContain('pg_catalog.pg_current_xact_id()::text')
  })

  it('serializes activation and release against shared write transactions on one scope key', () => {
    const activate = functionBody(
      'arena.activate_ingest_worker_authority',
      'CREATE FUNCTION arena.renew_ingest_worker_authority'
    )
    const renew = functionBody(
      'arena.renew_ingest_worker_authority',
      'CREATE FUNCTION arena.release_ingest_worker_authority'
    )
    const release = functionBody(
      'arena.release_ingest_worker_authority',
      'CREATE FUNCTION arena.begin_ingest_worker_fenced_write'
    )
    const beginWrite = functionBody(
      'arena.begin_ingest_worker_fenced_write',
      'CREATE FUNCTION arena.assert_ingest_worker_fence_at_commit'
    )

    for (const body of [activate, renew, release, beginWrite]) {
      expect(body).toContain("'arena.ingest-worker-authority:' || p_scope")
      expect(body).toContain('pg_catalog.hashtextextended')
      expect(body).toMatch(
        /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
      )
    }
    expect(activate).toContain('pg_catalog.pg_advisory_xact_lock(')
    expect(activate).not.toContain('pg_catalog.pg_advisory_xact_lock_shared(')
    expect(activate).toMatch(
      /pg_catalog\.nextval\(\s*'arena\.ingest_worker_fence_epoch_seq'::pg_catalog\.regclass\s*\)/
    )
    expect(activate).toMatch(/interval '180 seconds'/i)
    expect(activate).toContain("ERRCODE = '55P03'")
    expect(activate).toContain('FOR UPDATE')

    expect(renew).toContain('pg_catalog.pg_advisory_xact_lock_shared(')
    expect(renew).toMatch(/interval '180 seconds'/i)
    expect(release).toContain('pg_catalog.pg_advisory_xact_lock(')
    expect(release).not.toContain('pg_catalog.pg_advisory_xact_lock_shared(')
    expect(beginWrite).toContain('pg_catalog.pg_advisory_xact_lock_shared(')
    expect(beginWrite).toContain('pg_catalog.pg_current_xact_id()::text')
    expect(beginWrite).not.toMatch(/lease_expires_at\s*=/)
    expect(beginWrite).toContain('SELECT\n    authority.authority_scope AS a_scope')
    expect(beginWrite).toContain('LEFT JOIN arena.ingest_worker_instances AS instance')
    expect(beginWrite).toContain('LEFT JOIN arena.ingest_worker_activations AS activation')
    expect(beginWrite).not.toContain('INTO v_authority')
  })

  it('rechecks the lease at commit while the shared transaction lock remains authoritative', () => {
    const commitAssertion = functionBody(
      'arena.assert_ingest_worker_fence_at_commit',
      'CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion'
    )
    expect(commitAssertion).toContain('RETURNS trigger')
    expect(commitAssertion).toContain('lease_expires_at')
    expect(commitAssertion).toContain('pg_catalog.clock_timestamp()')
    expect(commitAssertion).toContain("ERRCODE = '55000'")
    expect(commitAssertion).toContain('DELETE FROM arena.ingest_worker_write_guards')
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion[\s\S]*AFTER INSERT ON arena\.ingest_worker_write_guards[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*FOR EACH ROW[\s\S]*EXECUTE FUNCTION arena\.assert_ingest_worker_fence_at_commit\(\)/
    )
  })

  it('keeps secrets private and fails closed through exact function ACLs', () => {
    expect(migration).toMatch(
      /extensions\.digest\(\s*pg_catalog\.convert_to\(p_owner_token, 'UTF8'\),\s*'sha256'\s*\)/
    )
    expect(migration).not.toMatch(/^\s*owner_token\s+text/m)
    expect(migration).not.toMatch(/jsonb_build_object\([\s\S]{0,300}'owner_token'/)

    const compactMigration = migration
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')

    for (const name of [
      'activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)',
      'renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)',
      'release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)',
      'begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)',
    ]) {
      const formattedName = name.replaceAll(',', ', ')
      expect(compactMigration).toContain(`ALTER FUNCTION arena.${formattedName} OWNER TO postgres`)
      expect(compactMigration).toContain(
        `REVOKE ALL ON FUNCTION arena.${formattedName} FROM PUBLIC, anon, authenticated, service_role`
      )
    }
    expect(compactMigration).toContain(
      'ALTER FUNCTION public.arena_ingest_worker_fence_release_readiness() OWNER TO postgres'
    )
    expect(migration).toContain('DO $owner_only_acl$')
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain(
      "CASE WHEN v_relation.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END"
    )
    expect(migration).toContain("sequence_relation.relpersistence = 'p'")
    expect(migration).toContain('function_row.proargmodes IS NULL')
    expect(migration).toContain('privilege_row.is_grantable')
    expect(migration).toContain("'functions:body-sha256'")
    expect(migration).toContain("ledger.version = '20260725011000'")
    expect(migration).toContain("'epoch', v_epoch::text")
    expect(migration).toContain("'contract', 'arena.worker-db-fence@1'")
  })

  it('is ordered as a predeploy-only candidate and keeps a real PG17 proof', () => {
    expect((runner.match(new RegExp(migrationName, 'g')) ?? []).length).toBe(1)
    expect(runner.indexOf(migrationName)).toBeGreaterThan(
      runner.indexOf('20260724234000_optimize_arena_score_inputs_json_hot_path.sql')
    )
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock_shared')
    expect(pg17).toContain("wait_event = 'advisory'")
    expect(pg17).toContain('fence-proof-snapshot-writer')
    expect(pg17).toContain('unlogged epoch allocator fails readiness')
    expect(pg17).toContain('commit-assertion body drift fails readiness')
    expect(pg17).toContain('durable ingest-worker fence PG17 proof passed')
  })
})
