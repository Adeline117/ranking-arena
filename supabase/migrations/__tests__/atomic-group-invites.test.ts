import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114800_atomic_group_invites.sql'),
  'utf8'
)

describe('atomic group invitation migration contract', () => {
  it('requires the 113900 redemption and token uniqueness authority', () => {
    expect(migration).toContain('atomic membership migration 20260716113900 must be applied first')
    expect(migration).toContain('public.redeem_group_invite_atomic(uuid,uuid,text,boolean)')
    expect(migration).toContain('public.serialize_group_membership_edge()')
    expect(migration).toContain('group_invites_token_hash_unique')
  })

  it('makes verification read-only and user-specific', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.inspect_group_invite_atomic(')
    expect(migration).toContain('FOR SHARE')
    expect(migration).toContain('public.group_invite_redemptions AS redemption')
    expect(migration).toContain("'status', 'invite_already_used'")
    expect(migration).toContain("'status', 'valid'")

    const inspectBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.inspect_group_invite_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(inspectBody).toBeDefined()
    expect(inspectBody).not.toContain('INSERT INTO')
    expect(inspectBody).not.toMatch(/\n\s*UPDATE public\./)
    expect(inspectBody).not.toContain('DELETE FROM')
  })

  it('creates invites under role and exact hourly rate locks', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.create_group_invite_atomic(')
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain("'group-invite-create:' || p_actor_id::text")
    expect(migration).toContain(
      "invite.created_at >= pg_catalog.clock_timestamp() - interval '1 hour'"
    )
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'rate_limited')")
    expect(migration).toContain('WHEN unique_violation THEN')
    expect(migration).toContain("'invite_created'")
  })

  it('soft-revokes without deleting redemption evidence', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS revoked_at timestamptz')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS revoked_by uuid')
    expect(migration).toContain('ADD CONSTRAINT group_invites_revocation_valid')
    expect(migration).toContain('SET revoked_at = v_revoked_at')
    expect(migration).toContain('expires_at = LEAST(invite.expires_at, v_revoked_at)')
    expect(migration).toContain("'invite_revoked'")
    expect(migration).not.toMatch(/DELETE FROM public\.group_invite_redemptions/)
    expect(migration).not.toMatch(/DELETE FROM public\.group_invites/)
  })

  it('removes direct invitation writes while preserving bounded reads', () => {
    expect(migration).toContain('ALTER TABLE public.group_invites FORCE ROW LEVEL SECURITY')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.group_invites TO authenticated, service_role'
    )
    expect(migration).toContain('CREATE POLICY browser_creator_or_admin_read')
    expect(migration).toContain('CREATE POLICY internal_owner_mutation')
    expect(migration).toContain('CREATE POLICY server_read')
    expect(migration).toContain('group_invites effective ACL drifted')
  })

  it('converges create, inspect, revoke and redeem to service-only execution', () => {
    expect(migration).toContain('public.inspect_group_invite_atomic(uuid,uuid,text,boolean)')
    expect(migration).toContain(
      'public.create_group_invite_atomic(uuid,uuid,text,timestamp with time zone,integer)'
    )
    expect(migration).toContain('public.revoke_group_invite_atomic(uuid,uuid,uuid)')
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('unexpected atomic group invitation overload remains')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
