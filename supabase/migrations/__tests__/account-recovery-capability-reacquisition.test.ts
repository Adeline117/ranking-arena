import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729075000_account_recovery_capability_reacquisition.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/account-recovery-capability-reacquisition.pg17.sh'),
  'utf8'
)

describe('account recovery capability reacquisition', () => {
  it('installs after the B2C authority with a collision-free transaction', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain(
      "pg_catalog.to_regclass('public.account_recovery_one_unfinished_finalization_v2')"
    )
    expect(migration).toContain(
      "RAISE EXCEPTION 'account recovery capability reacquisition objects already exist'"
    )
  })

  it('stores only a bounded one-time proof hash and credential authority snapshot', () => {
    expect(migration).toContain(
      'CREATE TABLE public.account_recovery_capability_reacquisition_tickets'
    )
    expect(migration).toContain("locator_kind IN ('token', 'password')")
    expect(migration).toContain("proof_hash ~ '^[0-9a-f]{64}$'")
    expect(migration).toContain("credential_snapshot_hash ~ '^[0-9a-f]{64}$'")
    expect(migration).toContain("expires_at <= issued_at + interval '15 minutes'")
    expect(migration).toContain('account_recovery_reacquisition_ticket_user_fk')
    expect(migration).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(migration).toContain('account_recovery_reacquisition_ticket_admission_fk')
    expect(migration).toContain(
      'REFERENCES public.account_recovery_admissions(operation_id) ON DELETE CASCADE'
    )
    expect(migration).toContain(
      'CREATE UNIQUE INDEX account_recovery_reacquisition_one_active_proof'
    )
    expect(migration).toContain('WHERE consumed_at IS NULL AND revoked_at IS NULL')
    expect(migration).toContain('consumed_at IS NULL')
    expect(migration).toContain('selected_candidate_index IN (0, 1)')
    expect(migration).toContain('extensions.gen_random_bytes(32)')
    expect(migration).toContain("pg_catalog.sha256(pg_catalog.convert_to(v_proof, 'UTF8'))")
    expect(migration).not.toMatch(/\bpassword\s+text[,\n]/)
    expect(migration).not.toMatch(/\bcapability\s+text[,\n]/)
    expect(migration).not.toMatch(/\breacquisition_proof\s+text[,\n]/)
  })

  it('uses a shared locked matcher for status, ticket location, and final attestation', () => {
    for (const signature of [
      'resolve_account_recovery_capability_reacquisition_candidate_v1',
      'status_account_recovery_capability_reacquisition_atomic',
      'locate_account_recovery_capability_reacquisition_atomic',
      'attest_account_recovery_capability_reacquisition_atomic',
    ]) {
      expect(migration).toContain(`CREATE FUNCTION public.${signature}`)
    }
    expect(
      migration.match(/resolve_account_recovery_capability_reacquisition_candidate_v1\(/g)
    ).toHaveLength(9)
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toContain("hashtextextended('pro-official-group-assignment', 0)")
    expect(migration).toContain("'pro-official-group-user:' || p_user_id::text")
    expect(migration).toContain('ORDER BY admission.operation_id')
    expect(migration).toContain('FOR UPDATE;')
    expect(migration).toContain("auth_finalization_state NOT IN ('completed', 'superseded')")
    expect(migration).toContain("'auth_compensation_required'")
    expect(migration).toContain("settlement.settlement_status = 'pending_fulfillment'")
  })

  it('keeps fallback discovery write-free and binds the deletion fence operation', () => {
    const statusBody = migration.match(
      /CREATE FUNCTION public\.status_account_recovery_capability_reacquisition_atomic[\s\S]*?\n\$function\$;/
    )?.[0]
    expect(statusBody).toBeDefined()
    expect(statusBody).toContain('fence.operation_id = p_operation_id')
    expect(statusBody).toContain('fence.recovery_token_hash = p_recovery_token_hash')
    expect(statusBody).toContain("fence.state = 'completed'")
    expect(statusBody).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/)
    expect(statusBody).not.toContain('account_recovery_capability_reacquisition_tickets')
    expect(statusBody).not.toContain("'user_id',")
    expect(statusBody).not.toContain("'operation_id',")
  })

  it('verifies normalized email and PG17 $2a$ bcrypt behind the durable 15m guard', () => {
    expect(migration).toContain('p_email = pg_catalog.lower(pg_catalog.btrim(p_email))')
    expect(migration).toContain("v_encrypted_password !~ '^\\$2a\\$[0-9]{2}")
    expect(migration).toContain('extensions.crypt(p_password, v_encrypted_password)')
    expect(migration).toContain('account_recovery_password_guards.window_started_at')
    expect(migration).toContain("v_now - interval '15 minutes'")
    expect(migration).toContain("v_now + interval '15 minutes'")
    expect(migration).toContain('failure_count = CASE')
    expect(migration).toContain('locked_until = CASE')
    expect(migration).toContain('v_profile_email IS DISTINCT FROM p_email')
    expect(migration).toContain('v_auth_email IS DISTINCT FROM p_email')
    expect(migration).toContain('v_auth_email IS DISTINCT FROM v_profile_email')
  })

  it('makes attestation the sole current/previous selector and atomically consumes once', () => {
    expect(migration).toContain(
      'v_admission.auth_finalization_capability_hash\n      = p_current_capability_hash'
    )
    expect(migration).toContain(
      'v_admission.auth_finalization_capability_hash\n        = p_previous_capability_hash'
    )
    expect(migration).toContain('SET consumed_at = v_now,')
    expect(migration).toContain('AND consumed_at IS NULL')
    expect(migration).toContain("'candidate_index', v_candidate_index")
    expect(migration).toContain("'auth_finalization_state', v_match ->> 'auth_finalization_state'")
    expect(migration).toContain(
      'account recovery capability reacquisition function body hash drifted'
    )
  })

  it('scrubs hostile default grants and exposes only the three runtime RPCs', () => {
    expect(migration).toContain('DO $close_acl$')
    expect(migration).toContain('CROSS JOIN LATERAL pg_catalog.aclexplode(')
    expect(migration).toContain('permission.grantee <> v_owner')
    expect(migration).toContain('FROM %I')
    expect(migration).toContain('relation.relforcerowsecurity')
    expect(migration).toContain('v_external pg_catalog.regprocedure[]')
    expect(migration).toContain('v_internal pg_catalog.regprocedure[]')
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.resolve_account_recovery_capability_reacquisition_candidate_v1/
    )
  })

  it('proves new, used-token, rotation, password, replay, race, and duplicate paths on PG17', () => {
    for (const marker of [
      '$initial_absent_and_status$',
      '$prepared_current_and_replay$',
      '$used_token_previous_rotation$',
      '$password_bcrypt_ticket$',
      '$password_can_reacquire_token_origin$',
      '$strict_email_identity$',
      '$single_active_proof$',
      '$ticket_foreign_keys_cascade$',
      '$unsafe_states_fail_closed$',
      '$password_guard_is_durable$',
      'fallback status created a durable ticket',
      'One ticket has exactly one concurrent winner',
      'password rotation between locator and',
      '$ticket_storage_is_hash_only$',
      '$duplicate_unfinished_is_invalid$',
      'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
