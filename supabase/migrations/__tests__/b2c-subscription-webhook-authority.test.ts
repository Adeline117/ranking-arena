/** @jest-environment node */

import fs from 'node:fs'
import path from 'node:path'

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260729074000_b2c_subscription_webhook_authority.sql'
)
const sql = fs.readFileSync(migrationPath, 'utf8')

function body(name: string, occurrence = -1): string {
  const expression = new RegExp(
    `CREATE OR REPLACE FUNCTION\\s+(?:\\n\\s*)?public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`,
    'g'
  )
  const matches = [...sql.matchAll(expression)]
  const selected = occurrence < 0 ? matches.at(occurrence) : matches[occurrence]
  if (!selected?.[1]) throw new Error(`missing function ${name}`)
  return selected[1]
}

describe('B2C subscription webhook authority migration', () => {
  it('keeps every dollar body and transaction boundary balanced', () => {
    expect(sql.match(/\$function\$/g)?.length).toBeGreaterThan(40)
    expect(sql.match(/\$function\$/g)?.length % 2).toBe(0)
    expect(sql.trim().startsWith('-- Exact signed-event authority')).toBe(true)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
  })

  it('takes the recovery lock before every final B2C product writer', () => {
    for (const name of [
      'activate_lifetime_membership_with_identity_atomic',
      'activate_group_subscription_with_stripe_ownership_atomic',
      'complete_tip_with_stripe_ownership_atomic',
    ]) {
      const writer = body(name)
      expect(writer.indexOf("'account-recovery-admission:'")).toBeGreaterThan(0)
      expect(writer.indexOf("'account-recovery-admission:'")).toBeLessThan(
        writer.indexOf("'stripe-charge-refund:'")
      )
      expect(writer).toContain('account_recovery_payment_lifecycle_is_blocked_v2')
    }
  })

  it('persists exact mode and terminal recovery refund effects for lifetime, group and Tip', () => {
    const lifetime = body('activate_lifetime_membership_with_identity_atomic')
    const group = body('activate_group_subscription_with_stripe_ownership_atomic')
    const tip = body('complete_tip_with_stripe_ownership_atomic')
    expect(lifetime).toContain("'recovery_payment_auto_refund'")
    expect(lifetime).toContain("'account_recovery_billing_blocked'")
    expect(lifetime).not.toContain("'payment_auto_refund'")
    expect(group).toContain("'billing_blocked_refund_pending'")
    expect(group).toContain('livemode = p_livemode')
    expect(tip).toContain("status = 'refund_pending'")
    expect(tip).toContain('livemode = p_livemode')
    expect(tip).toContain("'notification_suppressed'")
  })

  it('claims every recovery refund in the database before Stripe can be called', () => {
    const genericClaim = body('claim_recovery_payment_refund_dispatch_atomic')
    const lifetimeClaim = body('claim_lifetime_recovery_refund_dispatch_atomic')
    expect(genericClaim).toContain('claim_lifetime_recovery_refund_dispatch_atomic')
    expect(lifetimeClaim).toContain('v_reservation.livemode IS DISTINCT FROM p_livemode')
    expect(lifetimeClaim).toContain('dispatch_committed_at = pg_catalog.clock_timestamp()')
    expect(lifetimeClaim).toContain("'product_kind', 'lifetime'")
  })

  it('restores a lifetime-superseded recurring row only from fresh exact observation', () => {
    const restore = body('restore_lifetime_superseded_authority_atomic')
    expect(restore).toContain('p_period_start IS DISTINCT FROM v_authority.period_start')
    expect(restore).toContain('p_period_end IS DISTINCT FROM v_authority.period_end')
    expect(restore).toContain('newer.created_at >= COALESCE')
    expect(restore).toContain('newer.id IS DISTINCT FROM v_authority.recurring_payment_id')
    expect(restore).not.toMatch(/api_calls_today\s*=/)
    expect(restore).not.toMatch(/exports_this_month\s*=/)
    expect(restore).not.toMatch(/comparison_reports_this_month\s*=/)
  })

  it('classifies historical lifetime cancellations without an exact snapshot', () => {
    expect(sql).toContain('legacy_lifetime_cancel_completed_without_restore_snapshot')
    expect(sql).toContain('legacy_lifetime_cancel_superseded_without_restore_snapshot')
    expect(sql).toContain("last_error = 'legacy_lifetime_cancel_missing_restore_snapshot'")
    expect(sql).toContain("effect.status <> 'completed'")
  })

  it('uses an immutable recovery completion boundary and one exact lifecycle locator', () => {
    const locator = body('locate_account_recovery_payment_lifecycle_v2')
    const predicate = body('account_recovery_payment_lifecycle_is_blocked_v2')
    const guard = body('prevent_account_recovery_billing_v2_mutation')
    expect(sql).toContain('ADD COLUMN recovery_billing_completed_at timestamptz')
    expect(locator).toContain('admission.recovery_billing_completed_at')
    expect(locator).toContain("'completed_window'")
    expect(locator).toContain("'legacy_manual'")
    expect(locator).not.toContain('admission.updated_at')
    expect(predicate).toContain('locate_account_recovery_payment_lifecycle_v2')
    expect(predicate).not.toContain('admission.updated_at')
    expect(guard).toContain('billing completion boundary is immutable')
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.locate_account_recovery_payment_lifecycle_v2\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
  })

  it('never calls the nonexistent PostgreSQL jsonb_object_length function', () => {
    expect(sql).not.toContain('pg_catalog.jsonb_object_length')
    expect(body('jsonb_object_key_count_v2')).toContain('pg_catalog.jsonb_object_keys')
  })

  it('keeps final RPCs service-only and legacy writers owner-only', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.complete_tip_with_stripe_ownership_atomic\(\s*uuid, text, text, text, text, bigint, text, timestamptz\s*\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.activate_lifetime_membership_with_identity_atomic\([\s\S]*?\) TO service_role/
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.activate_group_subscription_with_stripe_ownership_atomic\([\s\S]*?\) TO service_role/
    )
  })
})
