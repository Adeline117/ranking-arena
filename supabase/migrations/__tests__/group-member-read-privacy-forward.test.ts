import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationPath = 'supabase/migrations/20260716171000_group_member_read_privacy.sql'
const migration = readFileSync(join(root, migrationPath), 'utf8')
const atomicMute = readFileSync(
  join(root, 'supabase/migrations/20260716165000_atomic_group_mute.sql'),
  'utf8'
)

const browserMembershipSources = [
  'app/components/groups/GroupsFeedPage.tsx',
  'app/(app)/groups/[id]/page.tsx',
  'app/(app)/groups/[id]/manage/page.tsx',
  'app/(app)/groups/[id]/new/page.tsx',
  'app/(app)/groups/[id]/hooks/useGroupData.ts',
].map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }))

function viewDefinition(name: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE VIEW public.${name}`)
  const end = migration.indexOf(nextMarker, start)
  if (start < 0 || end < 0) throw new Error(`missing view boundary for ${name}`)
  return migration.slice(start, end)
}

const directory = viewDefinition(
  'group_member_directory',
  'CREATE VIEW public.own_group_memberships'
)
const ownMemberships = viewDefinition(
  'own_group_memberships',
  'CREATE VIEW public.group_member_moderation_directory'
)
const moderationDirectory = viewDefinition(
  'group_member_moderation_directory',
  'ALTER VIEW public.group_member_directory'
)

describe('post-atomic-mute group-member read privacy', () => {
  it('ships as a forward convergence after the migration that reopened reads', () => {
    expect(20260716171000).toBeGreaterThan(20260716165000)
    expect(atomicMute).toContain(
      'GRANT SELECT ON TABLE public.group_members TO anon, authenticated'
    )
    expect(atomicMute).toContain('CREATE POLICY browser_read ON public.group_members')
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("hashtextextended('group-application-authority-migrations', 0)")
  })

  it('acquires the replay lock set in view-to-base runtime order with bounded NOWAIT retries', () => {
    const lockBlock = migration.slice(
      migration.indexOf('DO $acquire_complete_ddl_lock_set$'),
      migration.indexOf('$acquire_complete_ddl_lock_set$;', migration.indexOf('BEGIN'))
    )
    expect(lockBlock).toContain('EXCEPTION')
    expect(lockBlock).toContain('WHEN lock_not_available')
    expect(lockBlock).toContain('ACCESS EXCLUSIVE MODE NOWAIT')
    expect(lockBlock).toContain("interval '30 seconds'")
    expect(lockBlock.indexOf("'group_member_directory'")).toBeLessThan(
      lockBlock.indexOf('LOCK TABLE public.group_members')
    )
    expect(migration.indexOf('$acquire_complete_ddl_lock_set$;')).toBeLessThan(
      migration.indexOf('DROP VIEW IF EXISTS public.group_member_moderation_directory')
    )
  })

  it('dynamically removes drifted table, column and policy authority before exact grants', () => {
    expect(migration).toContain('aclexplode')
    expect(migration).toContain('acl_entry.grantee <> v_relation_owner')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.group_members')
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain('DROP POLICY %I ON public.group_members')
    expect(migration).toContain('GRANT SELECT (group_id, user_id, role, joined_at)')
    expect(migration).toContain('CREATE POLICY jwt_safe_directory_read')
    expect(migration).toContain('CREATE POLICY server_role_mutation')
    expect(migration).toContain('group-member table ACL did not converge exactly')
    expect(migration).toContain('group-member column ACL did not converge exactly')
    expect(migration).toContain('restricted group-member column remains JWT-readable')
  })

  it('exposes only the intended columns and explicit JWT authority predicates', () => {
    for (const field of ['group_id', 'user_id', 'role', 'joined_at']) {
      expect(directory).toContain(`member.${field}`)
    }
    for (const restricted of [
      'muted_until',
      'mute_reason',
      'muted_by',
      'notifications_muted',
      'self_notify_muted',
      'pinned',
    ]) {
      expect(directory).not.toContain(restricted)
    }

    expect(ownMemberships).toContain('member.muted_until')
    expect(ownMemberships).toContain('member.pinned')
    expect(ownMemberships).toContain('member.user_id = (SELECT auth.uid())')
    expect(ownMemberships).not.toContain('mute_reason')
    expect(ownMemberships).not.toContain('muted_by')

    expect(moderationDirectory).toContain('member.muted_until')
    expect(moderationDirectory).toContain('member.mute_reason')
    expect(moderationDirectory).not.toContain('member.muted_by')
    expect(moderationDirectory).toContain('actor_member.user_id = (SELECT auth.uid())')
    expect(moderationDirectory).toContain("actor_member.role::text IN ('owner', 'admin')")
    expect(migration.match(/security_barrier = true/g)).toHaveLength(3)
    expect(migration.match(/security_invoker = false/g)).toHaveLength(3)
  })

  it('keeps every browser membership access on a projection or the atomic membership API', () => {
    for (const { file, source } of browserMembershipSources) {
      expect({ file, source }).not.toEqual(
        expect.objectContaining({ source: expect.stringContaining(".from('group_members')") })
      )
    }
    expect(
      browserMembershipSources.some(({ source }) => source.includes('own_group_memberships'))
    ).toBe(true)
    expect(
      browserMembershipSources.some(({ source }) => source.includes('group_member_directory'))
    ).toBe(true)
    expect(
      browserMembershipSources.some(({ source }) =>
        source.includes('group_member_moderation_directory')
      )
    ).toBe(true)

    const hook = browserMembershipSources.find(({ file }) =>
      file.endsWith('useGroupData.ts')
    )?.source
    expect(hook).toContain('`/api/groups/${groupId}/membership`')
    expect(hook).not.toMatch(/\.from\([^)]*\)\s*\.(?:insert|update|delete|upsert)\(/)

    // This injectable server helper intentionally preserves arbitrary-user
    // semantics and uses only the four safe base columns.
    const serviceHelper = readFileSync(join(root, 'lib/services/group-permissions.ts'), 'utf8')
    expect(serviceHelper).toContain(".from('group_members')")
    expect(serviceHelper).toContain(".select('role')")
  })

  it('keeps the atomic mute RPC and generated projection types available', () => {
    expect(migration).toContain(
      'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'
    )
    expect(migration).toContain('atomic group-mute RPC lost its service boundary')

    const databaseTypes = readFileSync(join(root, 'lib/supabase/database.types.ts'), 'utf8')
    expect(databaseTypes).toContain('group_member_directory: {')
    expect(databaseTypes).toContain('group_member_moderation_directory: {')
    expect(databaseTypes).toContain('own_group_memberships: {')
  })
})
