import { getSupabaseAdmin } from '@/lib/supabase/server'

export const BILLING_SURFACE_UNAVAILABLE_MESSAGE =
  'Billing is temporarily unavailable. Please retry.'

type BillingSurfaceAccessStatus = 'allowed' | 'blocked' | 'invalid'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseBillingSurfaceAccessStatus(value: unknown): BillingSurfaceAccessStatus | null {
  const acknowledgement = record(value)
  if (!acknowledgement) return null

  const keys = Object.keys(acknowledgement)
  if (keys.length !== 1 || keys[0] !== 'status') return null

  const status = acknowledgement.status
  return status === 'allowed' || status === 'blocked' || status === 'invalid' ? status : null
}

/**
 * Fails closed unless the service-role recovery authority explicitly allows a
 * user-facing Stripe billing action.
 */
export async function assertUserStripeBillingSurfaceAccess(userId: string): Promise<void> {
  const admin = getSupabaseAdmin()
  const rpc = Reflect.get(admin as object, 'rpc')
  if (typeof rpc !== 'function') {
    throw new Error('Stripe billing surface access authority is unavailable')
  }

  const rawResult = await Reflect.apply(rpc, admin, [
    'resolve_user_stripe_billing_surface_access_atomic',
    { p_user_id: userId },
  ])
  const result = record(rawResult)
  if (!result || result.error !== null) {
    throw new Error('Stripe billing surface access authority is unavailable')
  }

  const status = parseBillingSurfaceAccessStatus(result.data)
  if (status !== 'allowed') {
    throw new Error('Stripe billing surface access was not allowed')
  }
}
