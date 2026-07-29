import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729056000_atomic_two_factor_credentials.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-two-factor-credentials.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
  const end = next >= 0 ? next : migration.indexOf('ALTER FUNCTION public.', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('atomic 2FA credential authority migration', () => {
  it('ships the ordered expand migration after every existing July 29 dependency', () => {
    expect(runner).toContain('20260729056000_atomic_two_factor_credentials.sql')
    expect(runner.indexOf('20260729056000_atomic_two_factor_credentials.sql')).toBeGreaterThan(
      runner.indexOf('20260729055000_account_recovery_auth_manual_review.sql')
    )
  })

  it('exposes only service-role SECURITY DEFINER credential RPCs', () => {
    for (const name of [
      'read_two_factor_enrollment_secret',
      'stage_two_factor_enrollment_secret_atomic',
      'enable_two_factor_credentials_atomic',
      'rotate_two_factor_backup_codes_atomic',
      'disable_two_factor_credentials_atomic',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('SECURITY DEFINER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
      expect(body).toContain('SET row_security = off')
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${name}(`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(`)
    }
  })

  it('binds enablement to the exact verified secret and exactly eight unique hashes', () => {
    const enable = functionBody('enable_two_factor_credentials_atomic')
    expect(enable).toContain('v_secret IS DISTINCT FROM p_expected_totp_secret')
    expect(enable).toContain("'status', 'secret_changed'")
    expect(enable).toContain('pg_catalog.cardinality(p_code_hashes) <> 8')
    expect(enable).toContain("'^[0-9a-f]{64}$'")
    expect(enable).toContain('count(DISTINCT supplied_hash.code_hash)')
    expect(enable).toContain('FOR UPDATE')
    expect(enable.indexOf('DELETE FROM public.backup_codes')).toBeLessThan(
      enable.indexOf('UPDATE public.user_profiles')
    )
    expect(enable).not.toContain('EXCEPTION WHEN')
  })

  it('keeps rotations and disablement inside one rollback-capable transaction', () => {
    const rotate = functionBody('rotate_two_factor_backup_codes_atomic')
    const disable = functionBody('disable_two_factor_credentials_atomic')

    expect(rotate).toContain("'status', 'credential_inconsistent'")
    expect(rotate).toContain('DELETE FROM public.backup_codes')
    expect(rotate).toContain('INSERT INTO public.backup_codes')
    expect(rotate).toContain('v_code_count <> 8')
    expect(disable).toContain('DELETE FROM public.backup_codes')
    expect(disable).toContain('DELETE FROM public.user_2fa_secrets')
    expect(disable).toContain('SET totp_enabled = false')
    expect(disable).not.toContain('EXCEPTION WHEN')
  })

  it('closes browser credential writes while preserving an expand-compatible server cutover', () => {
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.backup_codes'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).not.toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.backup_codes[\s\S]{0,100}service_role/
    )
  })

  it('proves rollback, exact secret binding, state guards, and ACLs on PostgreSQL 17', () => {
    for (const marker of [
      'wrong verified secret preserves disabled credentials',
      'failed rotation restores old backup codes',
      'failed disable restores enabled credentials',
      'successful disable removes every credential',
      'authenticated direct backup mutation is closed',
      'authenticated RPC execution is closed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
