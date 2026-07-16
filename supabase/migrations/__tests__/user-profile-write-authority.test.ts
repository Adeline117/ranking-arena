import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716178000_user_profile_write_authority.sql'),
  'utf8'
)

describe('user profile write authority migration', () => {
  it('installs atomically under the canonical profile migration and table locks', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'user-profile-authority-migrations'")
    expect(migration).toContain('LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('fails closed on role, ownership, schema and side-effect function drift', () => {
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`'${role}'`)
    }
    expect(migration).toContain('public.user_profiles must be an ordinary postgres-owned table')
    expect(migration).toContain('public.user_profiles write-authority columns are incompatible')
    expect(migration).toContain('auth.uid() must exist and return uuid')
    for (const signature of [
      'public.calculate_user_weight(uuid)',
      'public.trigger_update_user_weight()',
      'public.trigger_update_weight_on_activity()',
      'public.sync_author_handle()',
    ]) {
      expect(migration).toContain(`'${signature}'::pg_catalog.regprocedure`)
    }
  })

  it('removes every historical mutation policy and installs only the two canonical policies', () => {
    expect(migration).toContain('DO $replace_profile_mutation_policies$')
    expect(migration).toContain("policy.polcmd IN ('*', 'a', 'w', 'd')")
    expect(migration).toContain('CREATE POLICY user_profiles_authenticated_safe_update')
    expect(migration).toMatch(
      /CREATE POLICY user_profiles_authenticated_safe_update[\s\S]*?FOR UPDATE[\s\S]*?TO authenticated[\s\S]*?id = \(SELECT auth\.uid\(\)\)[\s\S]*?deleted_at IS NULL[\s\S]*?banned_at IS NULL/
    )
    expect(migration).toContain('CREATE POLICY user_profiles_service_mutation')
    expect(migration).toMatch(
      /CREATE POLICY user_profiles_service_mutation[\s\S]*?FOR ALL[\s\S]*?TO service_role[\s\S]*?USING \(true\)[\s\S]*?WITH CHECK \(true\)/
    )
    expect(migration).toContain('profile mutation policy set did not converge')
  })

  it('makes provisioning and deletion server-owned and grants only safe self-update columns', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*?ON TABLE public\.user_profiles[\s\S]*?FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toContain('DO $revoke_profile_column_mutations$')
    expect(migration).toContain("'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '")

    const safeGrant = migration.slice(
      migration.indexOf('GRANT UPDATE ('),
      migration.indexOf(') ON TABLE public.user_profiles TO authenticated')
    )
    for (const column of [
      'handle',
      'bio',
      'avatar_url',
      'cover_url',
      'market_pairs',
      'notify_follow',
      'notify_like',
      'notify_comment',
      'notify_mention',
      'notify_message',
      'notify_trader_events',
      'show_followers',
      'show_following',
      'dm_permission',
      'email_digest',
      'settings_version',
      'show_pro_badge',
      'last_seen_at',
      'is_online',
      'interests',
      'onboarding_completed',
      'search_history',
    ]) {
      expect(safeGrant).toMatch(new RegExp(`\\b${column}\\b`))
    }
    for (const protectedColumn of [
      'id',
      'role',
      'subscription_tier',
      'is_pro',
      'is_verified',
      'is_verified_trader',
      'follower_count',
      'following_count',
      'reputation_score',
      'stripe_customer_id',
      'wallet_address',
      'weight',
    ]) {
      expect(safeGrant).not.toMatch(new RegExp(`\\b${protectedColumn}\\b`))
    }
    expect(migration).toContain('protected profile update column remains writable')
    expect(migration).toContain('safe profile update column is unavailable')
  })

  it('keeps trusted weight and author side effects working behind private definers', () => {
    for (const signature of [
      'public.calculate_user_weight(uuid)',
      'public.trigger_update_user_weight()',
      'public.trigger_update_user_weight_after()',
      'public.trigger_update_weight_on_activity()',
      'public.sync_author_handle()',
    ]) {
      expect(migration).toContain(`ALTER FUNCTION ${signature} OWNER TO postgres`)
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION ${signature.replace(/[()]/g, '\\$&')}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
        )
      )
    }
    expect(migration).toMatch(
      /CREATE TRIGGER trigger_auto_update_user_weight[\s\S]*?AFTER UPDATE[\s\S]*?EXECUTE FUNCTION public\.trigger_update_user_weight_after\(\)/
    )
    expect(migration).toContain('canonical profile weight trigger did not converge')
    expect(migration).toMatch(
      /REVOKE CREATE ON SCHEMA public[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
    )
  })
})
