import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260817030000_trader_activities_publication_fence.sql'
const migrationDir = join(process.cwd(), 'supabase/migrations')
const migration = readFileSync(join(migrationDir, migrationName), 'utf8')
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/trader-activities-publication-fence.pg17.sh'),
  'utf8'
)
const legacyV1Migration = readFileSync(
  join(migrationDir, '20260223050000_trader_activities.sql'),
  'utf8'
)
const feedRoute = readFileSync(join(process.cwd(), 'app/api/feed/route.ts'), 'utf8')
const activitiesRoute = readFileSync(
  join(process.cwd(), 'app/api/feed/activities/route.ts'),
  'utf8'
)
const cronRoute = readFileSync(
  join(process.cwd(), 'app/api/cron/generate-activities/route.ts'),
  'utf8'
)

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('trader_activities publication fence migration', () => {
  it('is a forward-only transactional ACL/RLS cutover that leaves the v1 table migration immutable', () => {
    expect(migrationName).toMatch(/^\d{14}_trader_activities_publication_fence\.sql$/)
    expect(migrationName > '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql').toBe(
      true
    )
    expect(migrationName > '20260817020000_rank_history_service_only_acl.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain('LOCK TABLE ONLY public.trader_activities IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")

    expect(sha256(legacyV1Migration)).toBe(
      'd519ccc3ce8d71b356e88fb3dd8bd326cab1c1936ff2cd6bb4a01059f26974dd'
    )
    expect(legacyV1Migration).toContain('CREATE TABLE IF NOT EXISTS public.trader_activities')

    const sql = withoutComments(migration)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+public\.trader_activities\s+(?:ADD|DROP|ALTER)\b/i)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+INDEX\b/i)
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+public\.trader_activities|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i
    )
    expect(sql).not.toContain('ALTER DEFAULT PRIVILEGES')
  })

  it('collapses PUBLIC, delegated table grants, and delegated column grants before restoring exact service CRUD', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.trader_activities FROM PUBLIC CASCADE;/
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.trader_activities\s+FROM anon, authenticated, service_role CASCADE;/
    )
    expect(migration).toContain("pg_catalog.acldefault('r', relation.relowner)")
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('trader_activities retains an unresolved table ACL grantee')
    expect(migration).toContain('trader_activities retains an unresolved column ACL grantee')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.trader_activities FROM %I CASCADE'
    )
    expect(migration).toContain('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), ')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.trader_activities\s+TO service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT\s+[\s\S]{0,100}ON TABLE public\.trader_activities[\s\S]{0,100}TO\s+(?:PUBLIC|anon|authenticated)/i
    )
  })

  it('converges every policy to one explicit service-only RLS contract', () => {
    expect(migration).toContain('ALTER TABLE public.trader_activities ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('SELECT policy.polname')
    expect(migration).toContain('DROP POLICY %I ON public.trader_activities')
    expect(migration).toMatch(
      /CREATE POLICY trader_activities_service_role_only[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\);/
    )
    expect(migration).toContain("policy.polcmd = '*'")
    expect(migration).toContain("policy.polname = 'trader_activities_service_role_only'")
    expect(migration).toContain('trader_activities service-only RLS policy drifted')
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]{0,160}TO\s+(?:PUBLIC|anon|authenticated)/i)
  })

  it('fails closed for direct, inherited, column-level, and recursive service-role authority paths', () => {
    expect(migration).toContain("pg_catalog.to_regrole('authenticator')")
    expect(migration).toContain('membership.member = v_authenticator')
    expect(migration).toContain('NOT membership.admin_option')
    expect(migration).toContain('NOT membership.inherit_option')
    expect(migration).toContain('membership.set_option')
    expect(
      migration.match(
        /membership\.inherit_option OR membership\.set_option OR membership\.admin_option/g
      )
    ).toHaveLength(12)
    expect(migration).toContain('WITH RECURSIVE service_reachers(role_oid)')
    expect(migration).toContain('WITH RECURSIVE service_outbound(role_oid)')
    expect(migration).toContain('WITH RECURSIVE browser_authority(root_oid, role_oid)')
    expect(migration).toContain('trader_activities service_role membership or SET graph is unsafe')
    expect(migration).toContain('trader_activities service_role membership or SET graph drifted')
    expect(migration).toContain('pg_catalog.has_table_privilege(v_role, v_relation, v_privilege)')
    expect(migration).toContain('pg_catalog.has_any_column_privilege(')
    expect(migration).toContain("ARRAY['anon'::name, 'authenticated'::name]")
    expect(migration).toContain("'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'")
    expect(migration).toContain('trader_activities remains directly reachable by % via %')
    expect(migration).toContain('trader_activities remains column-reachable by % via %')
    expect(migration).toContain('trader_activities retains an unsafe direct table ACL')
  })

  it('keeps only the maintenance surface required by server readers and cron retention', () => {
    for (const route of [feedRoute, activitiesRoute, cronRoute]) {
      expect(route).toContain(".from('trader_activities')")
      expect(route).toContain('getSupabaseAdmin()')
    }

    expect(cronRoute).toContain('.delete()')
    expect(cronRoute).toContain(".lt('occurred_at'")
    expect(migration).toContain('trader_activities service role CRUD ACL is incomplete')
    expect(migration).toContain('trader_activities service role retained unnecessary % capability')
  })

  it('ships a disposable PostgreSQL 17 proof for hostile ACLs, recursive role paths, SET-only auth, and replay stability', () => {
    for (const marker of [
      'trader-activities-publication-fence',
      'build hostile legacy fixture',
      'delegated_table_reader',
      'delegated_column_reader',
      'rogue_member -> authenticator -> service_role',
      'recursive-set-path',
      'nonnecessary-direct-service-member',
      'service-outbound-set-path',
      'admin_bridge can regrant authenticator to setter',
      'admin-option-delegation-path',
      'authenticator SET-only bridge reaches service_role',
      'authenticator-does-not-inherit-service',
      'anon-cannot-set-service-role',
      'v1 trader_activities catalog changed outside ACL/RLS metadata',
      'v1 trader_activities rows changed during ACL cutover',
      'prove replay stability',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
