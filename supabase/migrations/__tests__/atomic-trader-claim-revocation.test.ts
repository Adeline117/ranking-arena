import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729067000_atomic_trader_claim_revocation.sql'),
  'utf8'
)

const unlinkFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.unlink_linked_trader'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.unlink_linked_trader')
)

describe('atomic trader claim revocation migration', () => {
  it('adds an auditable terminal status without deleting claim history', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT trader_claims_status_check[\s\S]*'expired',[\s\S]*'revoked'/
    )
    expect(unlinkFunction).toMatch(/UPDATE public\.trader_claims[\s\S]*SET status = 'revoked'/)
    expect(unlinkFunction).not.toMatch(/DELETE FROM public\.trader_claims/)
    expect(migration).toMatch(/OLD\.status IN \('rejected', 'expired', 'revoked'\)/)
  })

  it('locks in activation order and verifies exact composite ownership', () => {
    const claimLock = unlinkFunction.indexOf('FROM public.trader_claims AS claim')
    const userLock = unlinkFunction.indexOf("'linked-trader:' || p_user_id::text")
    const identityLock = unlinkFunction.indexOf(
      "'trader-claim:' || v_snapshot.source || ':' || v_snapshot.trader_id"
    )
    const linkLock = unlinkFunction.indexOf('INTO v_existing')

    expect(claimLock).toBeGreaterThan(-1)
    expect(claimLock).toBeLessThan(userLock)
    expect(userLock).toBeLessThan(identityLock)
    expect(identityLock).toBeLessThan(linkLock)
    expect(unlinkFunction).toMatch(
      /verified\.trader_id = v_existing\.trader_id[\s\S]*verified\.source = v_existing\.source/
    )
    expect(unlinkFunction).toMatch(/claim\.user_id = p_user_id[\s\S]*claim\.status = 'verified'/)
  })

  it('revokes every activation projection in the same database function', () => {
    expect(unlinkFunction).toMatch(/DELETE FROM public\.user_linked_traders/)
    expect(unlinkFunction).toMatch(/DELETE FROM public\.verified_traders/)
    expect(unlinkFunction).toMatch(
      /UPDATE public\.trader_authorizations[\s\S]*SET status = 'revoked'/
    )
    expect(unlinkFunction).toMatch(
      /UPDATE public\.user_exchange_connections[\s\S]*SET is_active = false/
    )
    expect(unlinkFunction).toContain('public.arena_set_trader_claimed(')
    expect(unlinkFunction).toMatch(/linked_trader_count = v_remaining_count/)
  })

  it('removes stale Arena ownership metadata when the claimed flag is cleared', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_set_trader_claimed[\s\S]*WHEN p_claimed THEN[\s\S]*- 'claimed_by_user_id'[\s\S]*- 'claimed_at'[\s\S]*jsonb_build_object\('claimed', false\)/
    )
  })

  it('fails before commit when an ownership projection disappears', () => {
    expect(unlinkFunction).toContain('verified trader claim projection not found')
    expect(unlinkFunction).toContain('verified trader ownership projection not found')
    expect(unlinkFunction).toContain('Arena trader claim projection was not revoked')
    expect(unlinkFunction).toContain('user profile not found')
  })

  it('keeps the revocation RPC service-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.unlink_linked_trader\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.unlink_linked_trader\(uuid, uuid\)[\s\S]*TO service_role/
    )
  })
})
