import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260817020000_rank_history_service_only_acl.sql'
const migrationDir = join(process.cwd(), 'supabase/migrations')
const migration = readFileSync(join(migrationDir, migrationName), 'utf8')
const legacyV1Migration = readFileSync(join(migrationDir, '20260319d_rank_history.sql'), 'utf8')
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/rank-history-service-only-acl.pg17.sh'),
  'utf8'
)
const snapshotRanksRoute = readFileSync(
  join(process.cwd(), 'app/api/cron/snapshot-ranks/route.ts'),
  'utf8'
)
const broadcastEventsRoute = readFileSync(
  join(process.cwd(), 'app/api/cron/broadcast-trader-events/route.ts'),
  'utf8'
)
const rankingChangesRoute = readFileSync(
  join(process.cwd(), 'app/api/notifications/ranking-changes/route.ts'),
  'utf8'
)

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('rank_history service-only ACL migration', () => {
  it('is a new forward-only metadata cutover and leaves the v1 catalog migration immutable', () => {
    expect(migrationName).toMatch(/^\d{14}_rank_history_service_only_acl\.sql$/)
    expect(migrationName > '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql').toBe(
      true
    )
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain('LOCK TABLE ONLY public.rank_history IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")

    // This historical migration is protected by qa:migration-history-shape as
    // well; pin it here because the new ACL migration must not rewrite the
    // raw v1 relation to achieve its boundary.
    expect(sha256(legacyV1Migration)).toBe(
      '124230ff69de81763a0a08d34957edf8e7df08ab498cf4608ce4a6de7a61ddde'
    )
    expect(legacyV1Migration).toContain('CREATE TABLE IF NOT EXISTS rank_history')
    expect(legacyV1Migration).toContain('UNIQUE(platform, trader_key, period, snapshot_date)')

    const sql = withoutComments(migration)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+public\.rank_history\s+(?:ADD|DROP|ALTER)\b/i)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+INDEX\b/i)
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+public\.rank_history|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i
    )
    expect(sql).not.toContain('ALTER DEFAULT PRIVILEGES')
  })

  it('removes PUBLIC, delegated table, and delegated column access before restoring only service CRUD', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.rank_history FROM PUBLIC CASCADE;/
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.rank_history\s+FROM anon, authenticated, service_role CASCADE;/
    )
    expect(migration).toContain("pg_catalog.acldefault('r', relation.relowner)")
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('rank_history retains an unresolved table ACL grantee')
    expect(migration).toContain('rank_history retains an unresolved column ACL grantee')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.rank_history FROM %I CASCADE'
    )
    expect(migration).toContain('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), ')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.rank_history\s+TO service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT\s+[\s\S]{0,100}ON TABLE public\.rank_history[\s\S]{0,100}TO\s+(?:PUBLIC|anon|authenticated)/i
    )
  })

  it('converges all historical policies to one explicit service-only RLS contract', () => {
    expect(migration).toContain('ALTER TABLE public.rank_history ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('SELECT policy.polname')
    expect(migration).toContain('DROP POLICY %I ON public.rank_history')
    expect(migration).toMatch(
      /CREATE POLICY rank_history_service_only[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\);/
    )
    expect(migration).toContain("policy.polcmd = '*'")
    expect(migration).toContain("policy.polname = 'rank_history_service_only'")
    expect(migration).toContain('rank_history service-only RLS policy drifted')
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]{0,160}TO\s+(?:PUBLIC|anon|authenticated)/i)
  })

  it('fails closed for direct anon/authenticated paths, including inherited and column-level grants', () => {
    expect(migration).toContain('pg_catalog.has_table_privilege(v_role, v_relation, v_privilege)')
    expect(migration).toContain('pg_catalog.has_any_column_privilege(')
    expect(migration).toContain("'SELECT', 'INSERT', 'UPDATE', 'DELETE',")
    expect(migration).toContain("'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'")
    expect(migration).toContain("ARRAY['anon'::name, 'authenticated'::name]")
    expect(migration).toContain("pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')")
    expect(migration).toContain("pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')")
    expect(migration).toContain('rank_history remains directly reachable by % via %')
    expect(migration).toContain('rank_history remains column-reachable by % via %')
    expect(migration).toContain('rank_history retains an unsafe direct table ACL')
  })

  it('allows only the canonical PostgREST gateway edge and rejects every other ADMIN, inherited, or SET ROLE path to service_role/postgres', () => {
    // A verified service JWT reaches service_role by connecting as the managed
    // authenticator and SET ROLE. That one edge is necessary; every custom,
    // direct, recursive, ADMIN, INHERIT, and SET path must stop the migration
    // before it can claim the raw table is secured.
    expect(migration.match(/rank_history internal role authority graph is unsafe/g)).toHaveLength(2)
    expect(migration.match(/WITH RECURSIVE service_authority/g)).toHaveLength(2)
    expect(migration.match(/WITH RECURSIVE postgres_authority/g)).toHaveLength(2)
    expect(migration.match(/WITH RECURSIVE service_upstream/g)).toHaveLength(2)
    expect(
      migration.match(
        /membership\.admin_option\s+OR\s+membership\.inherit_option\s+OR\s+membership\.set_option/g
      )
    ).toHaveLength(12)
    expect(migration).not.toContain('(membership.inherit_option OR membership.set_option)')

    for (const marker of [
      "v_authenticator oid := pg_catalog.to_regrole('authenticator')",
      'membership.member = v_authenticator',
      'NOT membership.admin_option',
      'NOT membership.inherit_option',
      'membership.set_option',
      'role_row.rolcanlogin',
      'NOT role_row.rolinherit',
      'NOT role_row.rolsuper',
      'NOT role_row.rolbypassrls',
      'membership.member <> v_postgres',
      'WHERE membership.roleid = v_postgres',
      'ADMIN-only',
      'rank_history browser role topology drifted after ACL cutover',
    ]) {
      expect(migration).toContain(marker)
    }

    // No generic control-plane or custom-role escape is silently allowlisted
    // by this table-specific boundary.
    expect(migration).not.toContain('cli_login_postgres')
  })

  it('preserves snapshot-rank service CRUD while fencing unproven notification writers', () => {
    expect(snapshotRanksRoute).toContain(".from('rank_history')")
    expect(snapshotRanksRoute).toContain('getSupabaseAdmin()')
    expect(snapshotRanksRoute).toContain('.upsert(batch')
    expect(snapshotRanksRoute).toContain('.delete()')

    for (const route of [broadcastEventsRoute, rankingChangesRoute]) {
      expect(route).not.toContain(".from('rank_history')")
      expect(route).not.toContain(".from('leaderboard_ranks')")
      expect(route).not.toContain(".from('trader_daily_snapshots')")
      expect(route).not.toContain(".from('notifications')")
      expect(route).not.toContain('getSupabaseAdmin()')
      // V1 retired both writers: auth-first, then a fixed 410 with no work.
      expect(route).toContain('verifyCronSecret(request)')
      expect(route).toContain('{ status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }')
    }

    expect(migration).toContain('rank_history service role CRUD ACL is incomplete')
    expect(migration).toContain('rank_history service role retained unnecessary % capability')
  })

  it('ships a disposable PostgreSQL 17 proof for hostile historical ACLs, direct denial, CRUD, and v1 stability', () => {
    for (const marker of [
      'rank-history-service-only-acl',
      'historical browser-readable fixture',
      'delegated-table-reader',
      'delegated-column-reader',
      'anonymous direct SELECT is denied',
      'authenticated direct SELECT is denied',
      'canonical PostgREST gateway SET ROLE service path',
      'authenticator-direct-select',
      'inherited service-role reader reaches raw rank_history before rejection',
      'inherited-service-role-reader',
      'setter-reader-multihop-set-role',
      'multi-hop SET ROLE reader reaches raw rank_history before rejection',
      'GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE',
      'GRANT authenticator TO setter_bridge WITH INHERIT FALSE, SET TRUE',
      'GRANT setter_bridge TO setter_reader WITH INHERIT FALSE, SET TRUE',
      'admin-only-authenticator-delegator',
      'GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'ADMIN-only bridge can delegate a raw rank_history SET ROLE reader',
      'delegated-reader-through-admin-bridge',
      'GRANT authenticator TO delegated_reader WITH INHERIT FALSE, SET TRUE',
      'delegated-reader-direct-select-after-recovery',
      'rank_history internal role authority graph is unsafe',
      'inherited-reader-direct-select-after-recovery',
      'service-role snapshot upsert and cleanup CRUD',
      'v1 rank_history catalog changed outside ACL/RLS metadata',
      'v1 rank_history rows changed during ACL cutover',
      'prove replay stability',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
