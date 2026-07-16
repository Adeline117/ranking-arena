import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716170000_group_edit_application_operation_replay.sql'
  ),
  'utf8'
)

describe('group edit application operation replay boundary', () => {
  it('uses guarded fresh creates followed by one complete bounded lock set', () => {
    const applicationCreate = migration.match(
      /DO \$create_application_only_when_absent\$[\s\S]*?\$create_application_only_when_absent\$;/
    )?.[0]
    const ledgerCreate = migration.match(
      /DO \$create_ledger_only_when_absent\$[\s\S]*?\$create_ledger_only_when_absent\$;/
    )?.[0]
    const lockSet = migration.match(
      /DO \$acquire_complete_ddl_lock_set\$[\s\S]*?\$acquire_complete_ddl_lock_set\$;/
    )?.[0]

    expect(applicationCreate).toContain(
      "pg_catalog.to_regclass('public.group_edit_applications') IS NULL"
    )
    expect(applicationCreate).toContain('CREATE TABLE public.group_edit_applications')
    expect(applicationCreate).not.toContain('CREATE TABLE IF NOT EXISTS')
    expect(applicationCreate).not.toContain('REFERENCES')
    expect(ledgerCreate).toContain('CREATE TABLE public.group_edit_application_operation_results')
    expect(ledgerCreate).not.toContain('REFERENCES')
    expect(lockSet).toContain(
      'public.group_edit_application_operation_results\n        IN ACCESS EXCLUSIVE MODE NOWAIT'
    )
    for (const relation of [
      'auth.users',
      'public.user_profiles',
      'public.groups',
      'public.group_members',
      'public.group_edit_applications',
      'public.group_audit_log',
      'public.notifications',
    ]) {
      expect(lockSet).toContain(relation)
    }
    expect(lockSet).toContain('WHEN lock_not_available')
    expect(lockSet).toContain("interval '30 seconds'")
    expect(lockSet).toContain("ERRCODE = '55P03'")
  })

  it('publishes only the two exact service-only postgres-owned RPCs', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.submit_group_edit_application_atomic\([\s\S]*?p_actor_id uuid,[\s\S]*?p_group_id uuid,[\s\S]*?p_name text,[\s\S]*?p_name_en text,[\s\S]*?p_description text,[\s\S]*?p_description_en text,[\s\S]*?p_avatar_url text,[\s\S]*?p_role_names jsonb,[\s\S]*?p_rules_json jsonb,[\s\S]*?p_rules text,[\s\S]*?p_is_premium_only boolean,[\s\S]*?p_operation_id uuid[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.review_group_edit_application_atomic\([\s\S]*?p_reviewer_id uuid,[\s\S]*?p_application_id uuid,[\s\S]*?p_decision text,[\s\S]*?p_reject_reason text,[\s\S]*?p_operation_id uuid[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('incompatible group-edit RPC overload exists')
  })

  it('makes both runtimes ledger-first and replays before mutable state', () => {
    const submit = migration.match(
      /CREATE OR REPLACE FUNCTION public\.submit_group_edit_application_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    const review = migration.match(
      /CREATE OR REPLACE FUNCTION public\.review_group_edit_application_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]

    for (const body of [submit, review]) {
      expect(body).toBeDefined()
      const barrier = body!.indexOf('LOCK TABLE public.group_edit_application_operation_results')
      const operationLock = body!.indexOf("'group-edit-operation:'")
      const ledgerRead = body!.indexOf(
        'FROM public.group_edit_application_operation_results AS ledger'
      )
      const mutableRead = Math.min(
        ...['FROM auth.users', 'FROM public.groups'].map((needle) => {
          const index = body!.indexOf(needle)
          return index < 0 ? Number.MAX_SAFE_INTEGER : index
        })
      )
      expect(barrier).toBeGreaterThan(0)
      expect(operationLock).toBeGreaterThan(barrier)
      expect(ledgerRead).toBeGreaterThan(operationLock)
      expect(ledgerRead).toBeLessThan(mutableRead)
      expect(body).toContain("'applied', false")
      expect(body).toContain("'status', 'operation_conflict'")
    }
    expect(migration.match(/pg_catalog\.sha256\(/g)).toHaveLength(2)
    expect(migration).toContain("'applied', true")
  })

  it('validates canonical user content inside the database', () => {
    expect(migration).toContain("normalize(pg_catalog.btrim(COALESCE(p_name, '')), NFC)")
    expect(migration).toContain("v_avatar_url !~* '^https?://[^[:space:]]+$'")
    expect(migration).toContain("ARRAY['admin', 'member']::text[]")
    expect(migration).toContain("ARRAY['en', 'zh']::text[]")
    expect(migration).toContain('pg_catalog.jsonb_array_length(p_rules_json) > 100')
    expect(migration).toContain("role_entry.labels ->> 'zh') > 50")
    expect(migration).toContain("rule_entry.rule_value ->> 'en') > 2000")
    expect(migration).toContain(
      "pg_catalog.octet_length(COALESCE(p_rules_json, '[]'::jsonb)::text) > 65536"
    )
    expect(migration).toContain("pg_catalog.btrim(role_entry.labels ->> 'zh') <>")
    expect(migration).toContain("pg_catalog.btrim(rule_entry.rule_value ->> 'en') <>")
  })

  it('rechecks owner, reviewer, dissolution, premium and name authority', () => {
    expect(migration).toContain("v_member_role = 'owner'::public.member_role")
    expect(migration).toContain("v_member_role = 'admin'::public.member_role")
    expect(migration).toContain('v_group.created_by = p_actor_id')
    expect(migration).toContain("reviewer.role = 'admin'")
    for (const status of [
      'account_inactive',
      'reviewer_inactive',
      'reviewer_unauthorized',
      'not_found',
      'dissolved',
      'forbidden',
      'owner_changed',
      'premium_change_unsupported',
      'name_taken',
      'pending_exists',
      'already_processed',
    ]) {
      expect(migration).toContain(`'status', '${status}'`)
    }
    expect(migration).toContain("COALESCE(v_application.name, v_group.name, '')")
    expect(migration).toContain("v_application.description, v_group.description, ''")
  })

  it('commits profile/application/audit/notification/ledger as one review transaction', () => {
    const review = migration.match(
      /CREATE OR REPLACE FUNCTION public\.review_group_edit_application_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    const groupUpdate = review!.indexOf('UPDATE public.groups AS target_group')
    const applicationUpdate = review!.indexOf(
      'UPDATE public.group_edit_applications AS application'
    )
    const audit = review!.indexOf('INSERT INTO public.group_audit_log')
    const notification = review!.indexOf('INSERT INTO public.notifications')
    const ledger = review!.indexOf('INSERT INTO public.group_edit_application_operation_results')

    expect(groupUpdate).toBeGreaterThan(0)
    expect(applicationUpdate).toBeGreaterThan(groupUpdate)
    expect(audit).toBeGreaterThan(applicationUpdate)
    expect(notification).toBeGreaterThan(audit)
    expect(ledger).toBeGreaterThan(notification)
    expect(review).toContain('actor_id, reference_id, read')
    expect(review).toContain('p_reviewer_id')
    expect(review).not.toContain('EXCEPTION WHEN')
  })

  it('removes only exact legacy triggers and blocks direct profile/application writes', () => {
    expect(migration).toContain('unknown group-edit application trigger detected')
    expect(migration).toMatch(
      /trigger_row\.tgname = 'on_group_edit_approved'[\s\S]*?handle_group_edit_approved\(\)/
    )
    expect(migration).toMatch(
      /trigger_row\.tgname = 'on_group_edit_rejected'[\s\S]*?handle_group_edit_rejected\(\)/
    )
    expect(migration).toContain('trigger_row.tgtype <> 17')
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.handle_group_edit_approved() RESTRICT'
    )
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.handle_group_edit_rejected() RESTRICT'
    )
    expect(migration).toContain("IF CURRENT_USER <> 'postgres'")
    expect(migration).not.toContain('app.group_edit_application_path')
    expect(migration).toContain(
      'ALTER TABLE public.group_edit_applications FORCE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('GRANT SELECT ON TABLE public.group_edit_applications')
  })

  it('seals exact catalog state and PostgreSQL 17 role inheritance edges', () => {
    expect(migration).toContain(
      'Permanent no-FK replay ledger for exact group-edit application operation results.'
    )
    expect(migration).toContain('group_edit_application_operation_result_check')
    expect(migration).toContain('WHERE trigger_row.tgrelid = v_ledger')
    expect(migration).toContain('group_edit_applications_one_pending_per_group')
    expect(migration).toContain("'b6fc362861e36b70fca613e8caf43568'")
    expect(migration).toContain("'82461112861cc083f2ac92a9d1a32925'")
    expect(migration).toContain("'group-edit-application-operation-replay:submit:v1:'")
    expect(migration).toContain("'group-edit-application-operation-replay:review:v1:'")
    expect(migration).toContain("'group-edit-application-operation-replay:profile-guard:v1:'")
    expect(migration.match(/membership\.inherit_option/g)).toHaveLength(8)
    expect(migration).not.toContain('.rolinherit')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
