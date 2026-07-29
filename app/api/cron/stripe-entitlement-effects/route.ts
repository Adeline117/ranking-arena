import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { joinProOfficialGroup } from '@/app/api/pro-official-group/route'
import { assertStripePaymentRuntimeReady, getStripe } from '@/lib/stripe'
import {
  createStripeEntitlementEffectStore,
  drainStripeEntitlementEffects,
} from '@/lib/stripe/entitlement-effect-worker'
import { reconcilePreparedAccountDeletionBilling } from '@/lib/account/deletion-billing-reconciliation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron(
  'stripe-entitlement-effects',
  async (_request: NextRequest, { supabase }) => {
    // Do not lease durable financial work unless this runtime can safely
    // execute its Stripe side effects in the matching mode.
    assertStripePaymentRuntimeReady()
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || ''
    if (!secretKey.startsWith('sk_live_') && !secretKey.startsWith('sk_test_')) {
      throw new Error('Stripe secret key mode is invalid')
    }

    const stripeClient = getStripe()
    const [effects, accountDeletionBilling] = await Promise.all([
      drainStripeEntitlementEffects(
        {
          store: createStripeEntitlementEffectStore(supabase),
          stripe: stripeClient,
          expectedLivemode: secretKey.startsWith('sk_live_'),
          joinProOfficialGroup,
          sendRateLimitedAlert,
        },
        { limit: 10, leaseSeconds: 120 }
      ),
      reconcilePreparedAccountDeletionBilling({
        supabase,
        stripeClient,
        limit: 5,
      }),
    ])

    return { ...effects, accountDeletionBilling }
  },
  { safetyTimeoutMs: 50_000 }
)
