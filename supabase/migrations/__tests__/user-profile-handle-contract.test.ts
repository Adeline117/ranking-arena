import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716179000_user_profile_handle_contract.sql'),
  'utf8'
)

describe('user profile handle contract migration', () => {
  it('installs atomically under the shared profile-authority lock', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'user-profile-authority-migrations'")
    expect(migration).toContain(
      'LOCK TABLE auth.users, public.user_profiles IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('fails closed on ownership, schema, function overload and index-name drift', () => {
    expect(migration).toContain('public.user_profiles must be an ordinary postgres-owned table')
    expect(migration).toContain('auth.users authority is incompatible')
    expect(migration).toContain('profile handle-contract columns are incompatible')
    expect(migration).toContain('canonical auth profile provisioner is missing or incompatible')
    expect(migration).toContain('unexpected profile handle function overload exists')
    expect(migration).toContain('profile handle index name belongs to another relation')
  })

  it('supports exact owner and hosted managed-auth authority modes', () => {
    expect(migration).toContain(
      'v_owner_auth_mode := v_current_super OR v_auth_owner = CURRENT_USER'
    )
    expect(migration).toContain("CURRENT_USER = 'postgres'")
    expect(migration).toContain("v_auth_owner = 'supabase_auth_admin'")
    expect(migration).toContain('AND NOT v_current_super')
    expect(migration).toContain('AND v_current_bypassrls')
    expect(migration).toContain('managed auth.users privileges are insufficient')
    expect(migration).toContain("'auth.users',\n      'SELECT'")
    expect(migration).toContain("'auth.users',\n        'UPDATE'")
    expect(migration).toContain('managed auth profile provisioning trigger is incompatible')

    const triggerConvergence = migration.match(
      /DO \$replace_auth_profile_triggers\$[\s\S]*?\$replace_auth_profile_triggers\$;/
    )?.[0]
    expect(triggerConvergence).toBeDefined()
    expect(triggerConvergence).toMatch(
      /IF v_managed_auth_mode THEN\s+RETURN;\s+END IF;[\s\S]*?DROP TRIGGER/
    )
    expect(triggerConvergence).toContain('CREATE TRIGGER on_auth_user_created')
    expect(migration).not.toMatch(/\nCREATE TRIGGER on_auth_user_created/)
  })

  it('backfills identities and repairs legacy collisions deterministically', () => {
    expect(migration).toContain('DO $backfill_missing_profiles$')
    expect(migration).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*?LEFT JOIN public\.user_profiles AS profile[\s\S]*?WHERE profile\.id IS NULL/
    )
    expect(migration).toContain('CREATE TEMPORARY TABLE pg_temp.user_profile_handle_plan')
    expect(migration).toContain('normalize(')
    expect(migration).toContain('preserve_legacy')
    expect(migration).toContain('pg_catalog.row_number() OVER')
    expect(migration).toContain('DO $allocate_collision_handles$')
    expect(migration).toContain('pg_catalog.pg_current_xact_id()::text')
    expect(migration).toContain('profile handle repair placeholder collision')
  })

  it('enforces normalized shape, strict rename rules and case-insensitive uniqueness', () => {
    expect(migration).toMatch(/ALTER COLUMN handle SET NOT NULL/)
    expect(migration).toContain('ADD CONSTRAINT user_profiles_handle_shape_check')
    expect(migration).toContain('handle IS NFC NORMALIZED')
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX user_profiles_handle_lower_unique[\s\S]*?pg_catalog\.lower\(handle\)/
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_user_profile_handle_contract()'
    )
    expect(migration).toContain("ERRCODE = '23514'")
    expect(migration).toContain("MESSAGE = 'reserved profile handle'")
    expect(migration).toMatch(
      /v_handle_changed[\s\S]*?NEW\.handle !~ '\^\[A-Za-z0-9_一-龯ぁ-ゟ゠-ヿ가-힣\]\+\$'/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_user_profiles_05_handle_contract[\s\S]*?BEFORE INSERT OR UPDATE OF handle/
    )
  })

  it('replaces historical signup triggers with a collision-safe private provisioner', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.handle_new_user()')
    expect(migration).toContain("NEW.raw_user_meta_data ->> 'handle'")
    expect(migration).toContain('WHEN unique_violation THEN')
    expect(migration).toContain("MESSAGE = 'unable to allocate unique profile handle'")
    expect(migration).toContain('DO $replace_auth_profile_triggers$')
    expect(migration).toMatch(
      /CREATE TRIGGER on_auth_user_created[\s\S]*?AFTER INSERT[\s\S]*?ON auth\.users/
    )

    for (const signature of [
      'public.enforce_user_profile_handle_contract()',
      'public.handle_new_user()',
    ]) {
      expect(migration).toMatch(
        new RegExp(`ALTER FUNCTION ${signature.replace(/[()]/g, '\\$&')}\\s+OWNER TO postgres`)
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION ${signature.replace(/[()]/g, '\\$&')}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
        )
      )
    }
  })

  it('postflight attests rows, objects, ACLs, sources and exact trigger shapes', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('auth identity is missing its canonical profile')
    expect(migration).toContain('persisted profile handles violate the canonical contract')
    expect(migration).toContain('case-insensitive profile handle index is incompatible')
    expect(migration).toContain('profile handle shape constraint is incompatible')
    expect(migration).toContain('profile handle function remains executable')
    expect(migration).toContain('profile handle validator source drifted')
    expect(migration).toContain('auth profile provisioner source drifted')
    expect(migration).toContain('profile handle trigger is incompatible')
    expect(migration).toContain('auth profile provisioning trigger is incompatible')
    expect(migration).toContain('trigger_row.tgconstraint = 0')
    expect(migration).toContain('NOT trigger_row.tgdeferrable')
    expect(migration).toContain('NOT trigger_row.tginitdeferred')
    expect(migration).toContain('trigger_row.tgnargs = 0')
    expect(migration).toContain('pg_catalog.octet_length(trigger_row.tgargs) = 0')
  })
})
