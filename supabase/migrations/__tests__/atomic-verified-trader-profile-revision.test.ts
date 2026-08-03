import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260803170000_atomic_verified_trader_profile_revision.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/atomic-verified-trader-profile-revision.pg17.sh'
  ),
  'utf8'
)

const revisionTrigger = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.own_verified_trader_profile_version'),
  migration.indexOf('ALTER FUNCTION public.own_verified_trader_profile_version')
)
const updateFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.update_verified_trader_profile_cas'),
  migration.indexOf('ALTER FUNCTION public.update_verified_trader_profile_cas')
)

describe('atomic verified-trader profile revision migration', () => {
  it('makes the database own a nonnegative profile revision', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS profile_version integer')
    expect(migration).toMatch(
      /ALTER COLUMN profile_version SET DEFAULT 0,[\s\S]*ALTER COLUMN profile_version SET NOT NULL/
    )
    expect(migration).toContain('verified_traders_profile_version_nonnegative_check')
    expect(revisionTrigger).toContain('NEW.profile_version := OLD.profile_version + 1')
    expect(revisionTrigger).toContain('NEW.profile_version := OLD.profile_version')
    expect(migration).toContain('BEFORE INSERT OR UPDATE')
  })

  it('invalidates stale forms for every editable field', () => {
    for (const field of [
      'display_name',
      'bio',
      'avatar_url',
      'twitter_url',
      'telegram_url',
      'discord_url',
      'website_url',
      'can_receive_messages',
    ]) {
      expect(revisionTrigger).toContain(`OLD.${field} IS DISTINCT FROM NEW.${field}`)
      expect(updateFunction).toContain(`p_updates ? '${field}'`)
    }
  })

  it('compares version with the exact user, trader, and source in one update', () => {
    expect(updateFunction).toContain('verified.user_id = p_user_id')
    expect(updateFunction).toContain('verified.trader_id = p_trader_id')
    expect(updateFunction).toContain('verified.source = p_source')
    expect(updateFunction).toContain('verified.profile_version = p_expected_version')
    expect(updateFunction).toContain("ERRCODE = '40001'")
    expect(updateFunction).toContain("ERRCODE = 'P0002'")
    expect(updateFunction).toContain('RETURNING verified.* INTO v_verified')
  })

  it('allows only service_role to execute the CAS authority', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.update_verified_trader_profile_cas[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.update_verified_trader_profile_cas[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.own_verified_trader_profile_version\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('ships an isolated PostgreSQL 17 overwrite and privilege proof', () => {
    expect(pg17Proof).toContain('PostgreSQL 17 is required')
    expect(pg17Proof).toContain('concurrent stale profile update unexpectedly succeeded')
    expect(pg17Proof).toContain('verified-trader profile changed since it was loaded')
    expect(pg17Proof).toContain('direct profile revision forgery succeeded')
    expect(pg17Proof).toContain('cross-owner profile update unexpectedly succeeded')
    expect(pg17Proof).toContain('anonymous profile CAS unexpectedly succeeded')
  })
})
