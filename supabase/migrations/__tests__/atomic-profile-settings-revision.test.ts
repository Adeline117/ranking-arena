import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729068000_atomic_profile_settings_revision.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

const revisionTrigger = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.bump_user_profile_settings_version'),
  migration.indexOf('ALTER FUNCTION public.bump_user_profile_settings_version')
)
const updateFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.update_own_profile_settings'),
  migration.indexOf('ALTER FUNCTION public.update_own_profile_settings')
)

describe('atomic profile settings revision migration', () => {
  it('makes the historical revision non-null, nonnegative, and trigger-owned', () => {
    expect(migration).toMatch(
      /ALTER COLUMN settings_version SET DEFAULT 0,[\s\S]*ALTER COLUMN settings_version SET NOT NULL/
    )
    expect(migration).toContain('user_profiles_settings_version_nonnegative_check')
    expect(migration).toMatch(
      /REVOKE UPDATE \(settings_version\)[\s\S]*FROM PUBLIC, anon, authenticated/
    )
  })

  it('bumps the revision for every field saved by the profile form', () => {
    for (const field of [
      'handle',
      'bio',
      'avatar_url',
      'cover_url',
      'show_followers',
      'show_following',
      'dm_permission',
      'show_pro_badge',
    ]) {
      expect(revisionTrigger).toContain(`OLD.${field} IS DISTINCT FROM NEW.${field}`)
    }
    expect(revisionTrigger).toContain('NEW.settings_version := OLD.settings_version + 1')
    expect(migration).toContain('CREATE TRIGGER trg_user_profiles_04_settings_version')
  })

  it('compares the caller revision inside the same profile update', () => {
    expect(updateFunction.match(/profile\.settings_version = p_expected_version/g)).toHaveLength(2)
    expect(updateFunction).toContain("ERRCODE = '40001'")
    expect(updateFunction).toContain('profile settings changed since they were loaded')
    expect(updateFunction).toMatch(
      /RETURNING profile\.id, profile\.settings_version[\s\S]*INTO v_profile_id, v_settings_version/
    )
  })

  it('does not put an unchanged handle in the update column list', () => {
    const preserveBranch = updateFunction.slice(
      updateFunction.indexOf('IF p_handle IS NULL THEN'),
      updateFunction.indexOf('ELSE')
    )

    expect(preserveBranch).not.toMatch(/\bSET handle =/)
    expect(preserveBranch).toContain('SET bio = p_bio')
    expect(updateFunction).toContain('SET handle = p_handle')
  })

  it('exposes only the authenticated CAS and keeps its implementation private', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.update_own_profile_settings[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.update_own_profile_settings[\s\S]*TO authenticated/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.bump_user_profile_settings_version\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })
})
