import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729164000_exchange_oauth_account_lifecycle.sql'),
  'utf8'
)

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = migration.indexOf(nextMarker, start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('exchange OAuth account lifecycle authority', () => {
  const callback = functionBody(
    'complete_exchange_oauth_callback_atomic',
    'CREATE OR REPLACE FUNCTION public.claim_exchange_oauth_refresh_atomic'
  )
  const refresh = functionBody(
    'claim_exchange_oauth_refresh_atomic',
    'ALTER FUNCTION public.complete_exchange_oauth_callback_atomic'
  )

  it('makes the historically drifted OAuth credential columns replayable', () => {
    for (const column of [
      'exchange_user_id',
      'access_token_encrypted',
      'refresh_token_encrypted',
      'expires_at',
      'last_sync_at',
      'last_sync_status',
      'last_sync_error',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`)
    }
    expect(migration).toContain('exchange OAuth credential column contract drifted')
  })

  it('publishes credentials and consumes the exact state in one transaction', () => {
    expect(callback).toContain('lock_trader_claim_principals_internal')
    expect(callback.indexOf('lock_trader_claim_principals_internal')).toBeLessThan(
      callback.indexOf('FROM public.oauth_states AS oauth_state')
    )
    expect(callback.indexOf('FOR UPDATE')).toBeLessThan(
      callback.indexOf('INSERT INTO public.user_exchange_connections')
    )
    expect(callback.indexOf('INSERT INTO public.user_exchange_connections')).toBeLessThan(
      callback.indexOf('DELETE FROM public.oauth_states')
    )
    expect(callback).toContain("MESSAGE = 'OAuth state consumption lost its locked claim'")
  })

  it('rechecks time after lifecycle admission and clears API-key proof state', () => {
    const admission = callback.indexOf('lock_trader_claim_principals_internal')
    const refreshedClock = callback.indexOf('v_now := pg_catalog.clock_timestamp()', admission)
    const stateLock = callback.indexOf('FROM public.oauth_states AS oauth_state')

    expect(refreshedClock).toBeGreaterThan(admission)
    expect(refreshedClock).toBeLessThan(stateLock)
    for (const cleared of [
      'passphrase_encrypted = NULL',
      'verified_uid = NULL',
      'last_verified_at = NULL',
      'scope_permissions = NULL',
    ]) {
      expect(callback).toContain(cleared)
    }
  })

  it('claims refresh generations only after active lifecycle admission', () => {
    expect(refresh.indexOf('lock_trader_claim_principals_internal')).toBeLessThan(
      refresh.indexOf('FROM public.user_exchange_connections AS connection')
    )
    expect(refresh).toContain('FOR UPDATE')
    expect(refresh).toContain(
      'v_connection.refresh_token_encrypted IS DISTINCT FROM\n       p_expected_refresh_token_encrypted'
    )
    expect(refresh).toContain('SET refresh_token_encrypted = p_lease_refresh_token_encrypted')
  })

  it('quiesces update, profile deletion, and missing-profile drift without forging freshness', () => {
    expect(migration).toContain('AFTER DELETE ON public.user_profiles')
    expect(migration).toContain("v_user_id uuid := CASE WHEN TG_OP = 'DELETE'")
    expect(migration).toContain('AND NOT EXISTS (\n    SELECT 1\n    FROM public.user_profiles')

    const quiesceStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.quiesce_inactive_exchange_connections'
    )
    const callbackStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.complete_exchange_oauth_callback_atomic'
    )
    const quiesce = migration.slice(quiesceStart, callbackStart)
    expect(quiesce).not.toContain('last_sync_at = pg_catalog.clock_timestamp()')
  })

  it('keeps both mutation authorities service-only and bounded', () => {
    for (const body of [callback, refresh]) {
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
      expect(body).toContain("SET lock_timeout = '5s'")
      expect(body).toContain("SET statement_timeout = '20s'")
      expect(body).toContain('SET row_security = off')
    }
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role, authenticator')
    expect(migration).toContain('TO service_role')
  })
})
