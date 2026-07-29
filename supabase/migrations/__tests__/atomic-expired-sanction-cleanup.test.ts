import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729157000_atomic_expired_sanction_cleanup.sql'),
  'utf8'
)
const route = readFileSync(join(process.cwd(), 'app/api/cron/expire-mutes/route.ts'), 'utf8')

describe('atomic expired-sanction cleanup authority', () => {
  it('is service-only and uses the shared account lifecycle lock before profile rows', () => {
    expect(migration).toContain(
      "COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'"
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('TO service_role')
    expect(migration.indexOf("'account-recovery-admission:' || v_user_id::text")).toBeLessThan(
      migration.indexOf('FROM public.user_profiles AS profile\n    WHERE profile.id = v_user_id')
    )
  })

  it('rechecks sanction provenance and active permanent or temporary bans while locked', () => {
    expect(migration).toContain('strike_row.reason IS NOT DISTINCT FROM v_banned_reason')
    expect(migration).toContain('strike_row.issued_by IS NOT DISTINCT FROM v_banned_by')
    expect(migration).toContain("active_strike.strike_type = 'perm_ban'")
    expect(migration).toContain("active_strike.strike_type = 'temp_ban'")
    expect(migration).toContain('profile.deleted_at IS NULL')
    expect(migration).toContain('is_banned = false')
  })

  it('routes the cron through one validated RPC acknowledgement', () => {
    expect(route).toContain("'expire_mutes_and_temporary_bans_atomic'")
    expect(route).toContain('parseCleanupResult(data)')
    expect(route).not.toContain(".from('user_strikes')")
    expect(route).not.toContain(".from('user_profiles')")
    expect(route).toContain('{ safetyTimeoutMs: 25_000 }')
  })
})
