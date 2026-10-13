import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migrationName = '20260817040000_notification_ranking_change_reader_fence.sql'
const migration = read(`supabase/migrations/${migrationName}`)
const proof = read('supabase/migrations/__tests__/notification-ranking-change-reader-fence.pg17.sh')
const notificationData = read('lib/data/notifications.ts')
const notificationRoute = read('app/api/notifications/route.ts')
const accountExportRoute = read('app/api/settings/export/route.ts')
const notificationHook = read('lib/hooks/useSWR.ts')
const notificationList = read('app/components/inbox/NotificationsList.tsx')
const readerPolicy = read('lib/notifications/ranking-change-fence.ts')
const broadcastEventsRoute = read('app/api/cron/broadcast-trader-events/route.ts')
const rankingChangesRoute = read('app/api/notifications/ranking-changes/route.ts')
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('notification ranking-change reader fence migration', () => {
  it('is a forward-only transactional reader cutover that retains legacy rows', () => {
    expect(migrationName).toMatch(/^\d{14}_notification_ranking_change_reader_fence\.sql$/)
    expect(migrationName > '20260817030000_trader_activities_publication_fence.sql').toBe(true)
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain("'notification-ranking-change-reader-fence'")
    expect(migration).toContain('LOCK TABLE ONLY public.notifications IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('ALTER TABLE ONLY public.notifications ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('notification reader RLS did not enable before policy cutover')
    expect(migration).toContain('notification reader RLS did not remain enabled')
    expect(migration).toContain('notification reader fence requires the postgres-owned table')
    expect(migration).toContain('notification reader fence no longer has the postgres-owned table')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")

    const sql = withoutComments(migration)
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+public\.notifications|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i
    )
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i)
  })

  it('filters the unsafe type before pagination and before the unread count while preserving safe rows', () => {
    expect(migration).toMatch(
      /FROM public\.notifications AS notification[\s\S]*?WHERE notification\.user_id = p_user_id[\s\S]*?AND notification\.type IS DISTINCT FROM 'ranking_change'[\s\S]*?ORDER BY notification\.created_at DESC[\s\S]*?LIMIT p_limit[\s\S]*?OFFSET p_offset/
    )
    expect(migration).toMatch(
      /FROM public\.notifications AS unread_notification[\s\S]*?WHERE unread_notification\.user_id = p_user_id[\s\S]*?AND unread_notification\.type IS DISTINCT FROM 'ranking_change'[\s\S]*?AND NOT unread_notification\.read/
    )
    expect(migration).toContain('LEFT JOIN public.user_profiles AS actor')
    expect(migration).toContain('Legacy ranking_change rows are suppressed')
    expect(migration).not.toContain('rank_history')
    expect(migration).not.toContain('leaderboard_ranks')
  })

  it('also denies the legacy row to the authenticated direct-table reader used by the inbox badge', () => {
    expect(migration).toContain('auth.uid() is required by the direct notification reader fence')
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can read own notifications"')
    expect(migration).toMatch(
      /CREATE POLICY "Users can read own notifications"[\s\S]*?FOR SELECT[\s\S]*?TO public[\s\S]*?\(\(SELECT auth\.uid\(\)\) = user_id\)[\s\S]*?type IS DISTINCT FROM 'ranking_change'/
    )
    expect(migration).toContain(
      'unreviewed browser notification SELECT policy blocks ranking-change fence'
    )
    expect(migration).toContain('authenticated notification RLS reader fence did not converge')
    expect(migration).toContain('unsafe browser notification SELECT policy survived reader fence')
  })

  it('attests the exact service gateway, owner, and browser role graph before and after cutover', () => {
    expect(migration).toContain("v_authenticator oid := pg_catalog.to_regrole('authenticator')")
    expect(migration).toContain("v_authenticator oid := 'authenticator'::pg_catalog.regrole")
    expect(migration).toContain('membership.member = v_authenticator')
    expect(migration).toContain('AND NOT membership.admin_option')
    expect(migration).toContain('AND NOT membership.inherit_option')
    expect(migration).toContain('AND membership.set_option')
    expect(migration).toContain('role_row.rolsuper OR role_row.rolbypassrls')
    expect(migration).toContain('notification reader browser role posture is unsafe')
    expect(migration).toContain('notification reader browser role posture drifted after cutover')
    expect(migration).toContain('notification reader internal role authority graph is unsafe')
    expect(migration).toContain(
      'notification reader internal role authority graph drifted after cutover'
    )

    for (const graph of [
      'service_authority',
      'postgres_authority',
      'service_upstream',
      'browser_authority',
    ]) {
      expect(migration.match(new RegExp(`WITH RECURSIVE ${graph}`, 'g'))).toHaveLength(2)
    }

    for (const membershipCapability of [
      'membership.admin_option',
      'membership.inherit_option',
      'membership.set_option',
    ]) {
      expect(migration.match(new RegExp(membershipCapability, 'g')).length).toBeGreaterThanOrEqual(
        8
      )
    }

    for (const browserRole of ['anon', 'authenticated']) {
      expect(migration).toContain(
        `pg_catalog.pg_has_role('${browserRole}', 'service_role', 'MEMBER')`
      )
      expect(migration).toContain(`pg_catalog.pg_has_role('${browserRole}', 'postgres', 'MEMBER')`)
    }
  })

  it('keeps the RPC service-only and converges unsafe historical overload grants', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_user_notifications[\s\S]*?LANGUAGE plpgsql[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role() IS DISTINCT FROM 'service_role'")
    expect(migration).toContain("USING ERRCODE = '42501'")
    expect(migration).toContain('DO $converge_overload_authority$')
    expect(migration).toContain("function_row.proname = 'get_user_notifications'")
    expect(migration).toContain("'ALTER FUNCTION %s OWNER TO postgres'")
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE'")
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*?ON FUNCTION public\.get_user_notifications\(uuid, integer, integer, boolean\)[\s\S]*?TO service_role/
    )
    expect(migration).not.toMatch(/GRANT EXECUTE[\s\S]{0,120}TO\s+(?:PUBLIC|anon|authenticated)/i)
    expect(migration).toContain('notification reader overload authority did not converge')
  })

  it('defense-in-depth fences the data helper, server cache, and client query caches', () => {
    expect(readerPolicy).toContain("SUPPRESSED_NOTIFICATION_TYPE = 'ranking_change'")
    expect(readerPolicy).toContain("NOTIFICATION_READER_CACHE_EPOCH = 'ranking-change-fence-v1'")
    expect(notificationData).toContain('isVisibleNotificationType(notification.type)')
    expect(notificationData).toContain(".neq('type', SUPPRESSED_NOTIFICATION_TYPE)")
    expect(notificationRoute).toContain('NOTIFICATION_READER_CACHE_EPOCH')
    expect(notificationRoute).toContain(
      'notifications:${user.id}:${NOTIFICATION_READER_CACHE_EPOCH}'
    )
    expect(accountExportRoute).toContain('isVisibleNotificationType(row.type)')
    expect(accountExportRoute).toContain(
      "completedDataset('notifications', normalizedNotifications.length)"
    )
    expect(notificationHook).toContain("['notifications', NOTIFICATION_READER_CACHE_EPOCH, userId]")
    expect(notificationList).toContain('NOTIFICATION_READER_CACHE_EPOCH')
    expect(notificationList).toContain('isVisibleNotificationType(notification.type)')
    expect(read('app/components/layout/useTopNavState.ts')).toContain(
      ".neq('type', SUPPRESSED_NOTIFICATION_TYPE)"
    )
  })

  it('keeps both ranking notification writers fail-closed with no raw ranking source reads', () => {
    for (const route of [broadcastEventsRoute, rankingChangesRoute]) {
      expect(route).not.toContain(".from('rank_history')")
      expect(route).not.toContain(".from('leaderboard_ranks')")
      expect(route).not.toContain(".from('trader_daily_snapshots')")
      expect(route).not.toContain(".from('notifications')")
      expect(route).not.toContain('getSupabaseAdmin()')
      expect(route).toContain("status: 'skipped'")
      expect(route).toContain("ranking_visibility: 'unknown'")
    }
  })

  it('ships a PostgreSQL 17 proof for page, unread, ACL, and replay behavior', () => {
    for (const marker of [
      'notification-ranking-change-reader-fence',
      'legacy ranking_change is present before the reader fence',
      'safe page skips the ranking_change row before LIMIT/OFFSET',
      'unread count excludes the suppressed ranking_change row',
      'anonymous direct notification RPC is denied',
      'authenticated direct notification RPC is denied',
      'authenticated table RLS reader excludes ranking_change',
      'reader migration enables RLS from disabled baseline',
      'anonymous table RLS reader remains denied',
      'hostile-notification-owner',
      'browser-inherited-service-role-before-cutover',
      'inherited browser service role bypasses the RLS type predicate before replay rejection',
      'replay restores browser RLS type fence after inherited-role removal',
      'multi-hop SET ROLE path reaches the service notification reader before rejection',
      'ADMIN-option bridge can delegate a service reader before rejection',
      'browser BYPASSRLS role can replay ranking_change before rejection',
      'canonical authenticator SET ROLE service reader remains available',
      'service reader keeps non-ranking notifications',
      'phantom overload is quarantined on replay',
      'PostgreSQL 17 notification ranking-change reader fence proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
    expect(proof).toContain('ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY')
    expect(proof).toContain('CREATE ROLE authenticator LOGIN NOINHERIT')
    expect(proof).toContain('GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE')
    expect(proof).toContain('ALTER TABLE public.notifications OWNER TO hostile_owner')
    expect(proof).toContain('GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE')
    expect(proof).toContain('ALTER ROLE authenticated BYPASSRLS')
  })

  it('runs the RLS/ACL replay proof in the repository PG17 CI lane', () => {
    expect(packageJson).toContain(
      '"qa:notification-ranking-change-reader-fence-pg17": "bash supabase/migrations/__tests__/notification-ranking-change-reader-fence.pg17.sh"'
    )
    expect(ciWorkflow).toContain('name: Prove notification ranking-change reader fence')
    expect(ciWorkflow).toContain('run: npm run qa:notification-ranking-change-reader-fence-pg17')
  })
})
