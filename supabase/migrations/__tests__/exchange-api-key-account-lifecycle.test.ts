import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729165500_exchange_api_key_account_lifecycle.sql'),
  'utf8'
)

function functionBody(functionName: string): string {
  const match = new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${functionName}\\(`).exec(
    migration
  )
  if (!match) return ''
  return migration.slice(match.index, migration.indexOf('$function$;', match.index) + 11)
}

describe('exchange API-key account lifecycle migration', () => {
  it('bumps a monotonic fence for every credential authority mutation', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS connection_generation bigint')
    expect(migration).toContain('aaa_bump_exchange_connection_generation')
    for (const column of [
      'api_key_encrypted',
      'api_secret_encrypted',
      'passphrase_encrypted',
      'exchange_user_id',
      'access_token_encrypted',
      'refresh_token_encrypted',
      'expires_at',
      'is_active',
      'verified_uid',
      'last_verified_at',
      'scope_permissions',
    ]) {
      expect(migration).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`)
    }
  })

  it('serializes every API-key writer with the canonical account lifecycle', () => {
    for (const functionName of [
      'upsert_exchange_api_connection_for_active_profile_atomic',
      'bind_trader_authorization_for_active_profile_atomic',
      'claim_exchange_api_sync_atomic',
      'finish_exchange_api_sync_atomic',
    ]) {
      const body = functionBody(functionName)
      expect(body).not.toBe('')
      expect(body).toContain('lock_trader_claim_principals_internal')
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    }
  })

  it('preserves exchange-proven read-only scope even when no account UID is available', () => {
    const helper = functionBody('upsert_exchange_api_connection_without_lifecycle_internal')
    const admission = functionBody('upsert_exchange_api_connection_for_active_profile_atomic')

    expect(helper).toContain(
      '(p_scope_permissions IS NULL) IS DISTINCT FROM (p_verified_at IS NULL)'
    )
    expect(helper).toContain('p_verified_uid IS NOT NULL\n       AND p_scope_permissions IS NULL')
    expect(admission).toContain('CASE WHEN p_scope_permissions IS NULL THEN NULL ELSE v_now END')
  })

  it('stores verified connection proof and authorization in one transaction', () => {
    const body = functionBody('bind_trader_authorization_for_active_profile_atomic')

    expect(body).toContain('upsert_exchange_api_connection_without_lifecycle_internal')
    expect(body).toContain('INSERT INTO public.trader_authorizations')
    expect(body).toContain("'connection_generation', v_connection.connection_generation")
    expect(body).toContain("'authorization_generation', v_authorization.authorization_generation")
  })

  it('fences sync results by owner, connection, generation, and active status', () => {
    const body = functionBody('finish_exchange_api_sync_atomic')

    expect(body).toContain('connection.user_id = p_user_id')
    expect(body).toContain('connection.connection_generation = p_generation')
    expect(body).toContain('connection.is_active = true')
    expect(body).toContain("'status', 'superseded'")
  })

  it('keeps every public authority service-only and the internal helper private', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  public.upsert_exchange_api_connection_without_lifecycle_internal'
    )
    for (const functionName of [
      'upsert_exchange_api_connection_for_active_profile_atomic',
      'bind_trader_authorization_for_active_profile_atomic',
      'claim_exchange_api_sync_atomic',
      'finish_exchange_api_sync_atomic',
    ]) {
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION[\\s\\S]{0,200}public\\.${functionName}`)
      )
    }
  })
})
