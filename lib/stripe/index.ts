import 'server-only'
import Stripe from 'stripe'
import { API_PRICING, PRICING } from '@/app/(app)/user-center/membership-config'
import { stripeMetadataUserId } from '@/lib/stripe/identity'

/**
 * Validates that a required Stripe environment variable is set.
 * Throws a descriptive error if missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(
      `${name} is not configured. ` +
        `Please set it in your environment variables (Vercel Dashboard → Settings → Environment Variables).`
    )
  }
  return value
}

function optionalEnv(name: string): string {
  return process.env[name]?.trim() || ''
}

// Stripe 服务端实例 - 懒加载以避免构建时环境变量未定义的问题
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const secretKey = requireEnv('STRIPE_SECRET_KEY')
    _stripe = new Stripe(secretKey, {
      apiVersion: '2026-04-22.dahlia',
      typescript: true,
    })
  }
  return _stripe
}

// 保留 stripe 导出以保持兼容性（但现在是 getter）
export const stripe = {
  get customers() {
    return getStripe().customers
  },
  get subscriptions() {
    return getStripe().subscriptions
  },
  get prices() {
    return getStripe().prices
  },
  get checkout() {
    return getStripe().checkout
  },
  get billingPortal() {
    return getStripe().billingPortal
  },
  get webhooks() {
    return getStripe().webhooks
  },
}

// 价格 ID 配置 - Pro 会员的月付/年付/终身价格
// Falls back to STRIPE_PRO_PRICE_ID for both if specific monthly/yearly IDs not set
export const STRIPE_PRICE_IDS = {
  monthly:
    optionalEnv('STRIPE_PRO_MONTHLY_PRICE_ID') ||
    optionalEnv('STRIPE_PRICE_MONTHLY_ID') ||
    optionalEnv('STRIPE_PRO_PRICE_ID') ||
    '',
  yearly:
    optionalEnv('STRIPE_PRO_YEARLY_PRICE_ID') ||
    optionalEnv('STRIPE_PRICE_YEARLY_ID') ||
    optionalEnv('STRIPE_ELITE_PRICE_ID') ||
    optionalEnv('STRIPE_PRO_PRICE_ID') ||
    '',
  lifetime: optionalEnv('STRIPE_PRO_LIFETIME_PRICE_ID'),
}

// B2B API tier price IDs — separate from Pro membership
export const STRIPE_API_PRICE_IDS = {
  starter: optionalEnv('STRIPE_API_STARTER_PRICE_ID'),
  pro: optionalEnv('STRIPE_API_PRO_PRICE_ID'),
}

// API tier → daily request limit mapping
export const API_TIER_LIMITS: Record<string, number> = {
  free: 100,
  starter: 10_000,
  pro: 0, // 0 = unlimited
}

type PriceContract = {
  unitAmount: number
  interval: 'month' | 'year' | null
}

async function assertPriceContract(priceId: string, expected: PriceContract): Promise<void> {
  if (!priceId || !priceId.startsWith('price_')) {
    throw new Error('Stripe price is not configured')
  }

  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] })
  const product = typeof price.product === 'string' ? null : price.product
  const secretIsLive = requireEnv('STRIPE_SECRET_KEY').startsWith('sk_live_')
  const productionPaywallEnabled =
    process.env.VERCEL_ENV === 'production' && process.env.NEXT_PUBLIC_PRO_FREE_PROMO === 'false'

  if (productionPaywallEnabled && (!secretIsLive || !price.livemode)) {
    throw new Error('Stripe live mode is required before the production paywall can be enabled')
  }
  if (price.livemode !== secretIsLive) {
    throw new Error('Stripe key and price mode do not match')
  }
  if (!price.active || !product || !('active' in product) || !product.active) {
    throw new Error('Stripe price or product is inactive')
  }
  if (price.currency !== 'usd' || price.unit_amount !== expected.unitAmount) {
    throw new Error('Stripe price amount does not match the product pricing contract')
  }
  if ((price.recurring?.interval ?? null) !== expected.interval) {
    throw new Error('Stripe price billing interval does not match the product pricing contract')
  }
}

export async function assertProPriceReady(
  plan: 'monthly' | 'yearly' | 'lifetime',
  priceId: string
): Promise<void> {
  const expected: Record<typeof plan, PriceContract> = {
    monthly: { unitAmount: Math.round(PRICING.monthly.price * 100), interval: 'month' },
    yearly: { unitAmount: Math.round(PRICING.yearly.price * 100), interval: 'year' },
    lifetime: { unitAmount: Math.round(PRICING.lifetime.price * 100), interval: null },
  }
  await assertPriceContract(priceId, expected[plan])
}

export async function assertApiPriceReady(plan: 'starter' | 'pro', priceId: string): Promise<void> {
  await assertPriceContract(priceId, {
    unitAmount: Math.round(API_PRICING[plan].price * 100),
    interval: 'month',
  })
}

// 订阅计划配置 - prices sourced from PRICING (single source of truth)
export const SUBSCRIPTION_PLANS = {
  monthly: {
    name: 'Pro Monthly',
    nameCn: 'Pro 月付会员',
    price: PRICING.monthly.price,
    originalPrice: PRICING.monthly.original,
    interval: 'month' as const,
    features: [
      'Category ranking',
      'Trader alerts',
      'Score breakdown',
      'Pro badge',
      'Advanced filter',
      'Trader comparison',
      'Pro groups',
      '90 days historical data',
    ],
  },
  yearly: {
    name: 'Pro Yearly',
    nameCn: 'Pro 年付会员',
    price: PRICING.yearly.price,
    originalPrice: PRICING.yearly.original,
    interval: 'year' as const,
    features: ['All monthly features', 'Save 50%', 'Priority support'],
  },
  lifetime: {
    name: 'Founding Member Lifetime',
    nameCn: '创始会员终身',
    price: PRICING.lifetime.price,
    originalPrice: null,
    interval: 'once' as const,
    spotsTotal: PRICING.lifetime.spots,
    features: [
      'All Pro features forever',
      'Founding member badge',
      'Priority support',
      'Future features included',
    ],
  },
}

// 订阅状态映射
export const SUBSCRIPTION_STATUS_MAP: Record<Stripe.Subscription.Status, string> = {
  active: 'active',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'expired',
  past_due: 'past_due',
  paused: 'paused',
  trialing: 'trialing',
  unpaid: 'unpaid',
}

// 获取 Stripe 客户 ID 或创建新客户
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  metadata?: Record<string, string>,
  existingCustomerId?: string | null
): Promise<string> {
  const forbiddenOwnerAliases = ['userId', 'user_id', 'supabase_user_id'] as const
  const injectedOwnerAlias = metadata
    ? forbiddenOwnerAliases.find((key) => Object.prototype.hasOwnProperty.call(metadata, key))
    : undefined
  if (injectedOwnerAlias) {
    throw new Error(`Stripe customer metadata must not include owner alias ${injectedOwnerAlias}`)
  }

  if (existingCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(existingCustomerId)
      if (!existing.deleted) {
        const owner = stripeMetadataUserId(
          existing.metadata,
          `Stored Stripe customer ${existing.id}`
        )
        if (owner && owner !== userId) {
          throw new Error('Stored Stripe customer belongs to a different user')
        }
        if (!owner) {
          // The local profile link is strong enough to repair a legacy
          // ownerless Customer. Exact payment authority requires the Stripe
          // Customer itself to carry the same user identity before Checkout.
          await stripe.customers.update(existing.id, {
            metadata: { userId },
          })
        }
        return existing.id
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      // Expected during test→live cutover: a test customer ID does not exist
      // under the live key. Other failures must block checkout.
      if (code !== 'resource_missing') throw error
    }
  }

  let startingAfter: string | undefined
  while (true) {
    const existingCustomers = await stripe.customers.list({
      email,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })

    const ownedCustomer = existingCustomers.data.find((customer) => {
      try {
        return stripeMetadataUserId(customer.metadata, `Stripe customer ${customer.id}`) === userId
      } catch {
        return false
      }
    })
    if (ownedCustomer) {
      return ownedCustomer.id
    }

    if (!existingCustomers.has_more) break
    const lastCustomer = existingCustomers.data.at(-1)
    if (!lastCustomer || lastCustomer.id === startingAfter) {
      throw new Error('Stripe customer email lookup pagination did not advance')
    }
    startingAfter = lastCustomer.id
  }

  const mode = requireEnv('STRIPE_SECRET_KEY').startsWith('sk_live_') ? 'live' : 'test'
  const customer = await stripe.customers.create(
    {
      email,
      metadata: {
        ...metadata,
        userId,
      },
    },
    { idempotencyKey: `arena_customer_${mode}_${userId}` }
  )

  return customer.id
}

// 创建 Checkout Session
export async function createCheckoutSession(params: {
  customerId: string
  priceId: string
  successUrl: string
  cancelUrl: string
  metadata?: Record<string, string>
  promotionCode?: string
  allowPromotionCodes?: boolean
  trialDays?: number
}): Promise<Stripe.Checkout.Session> {
  // Validate priceId before making Stripe API call
  if (!params.priceId || !params.priceId.startsWith('price_')) {
    throw new Error(
      `Invalid Stripe price ID: "${params.priceId}". ` +
        `Please configure STRIPE_PRO_MONTHLY_PRICE_ID and STRIPE_PRO_YEARLY_PRICE_ID environment variables.`
    )
  }

  // payment_method_types: card + link. Apple Pay / Google Pay are enabled
  // automatically via Stripe's card payment method when configured in Dashboard.
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: params.customerId,
    payment_method_types: ['card', 'link'],
    line_items: [
      {
        price: params.priceId,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: params.metadata,
    subscription_data: {
      metadata: params.metadata,
      ...(params.trialDays ? { trial_period_days: params.trialDays } : {}),
    },
    // B2C paid authority can explicitly disable the promotion-code field
    // without changing the API-tier/default helper behavior.
    allow_promotion_codes: params.allowPromotionCodes ?? !params.promotionCode,
    billing_address_collection: 'auto',
    locale: 'auto',
  }

  // Apply explicit promotion code if provided
  if (params.promotionCode) {
    sessionParams.discounts = [{ promotion_code: params.promotionCode }]
  }

  // Idempotency key prevents duplicate checkout sessions if the client retries
  // (double-click, network retry, browser prefetch). Stripe deduplicates within 24h.
  // Key is scoped to customer + price so switching plans creates a new session.
  const idempotencyKey = `checkout_${params.customerId}_${params.priceId}_${Math.floor(Date.now() / 60_000)}`
  const session = await stripe.checkout.sessions.create(sessionParams, {
    idempotencyKey,
  })
  return session
}

/**
 * Create a one-time payment checkout session with MANDATORY idempotency.
 * Use for lifetime purchases, tips, group payments — anything mode:'payment'.
 *
 * Idempotency key is auto-generated from userId + a discriminator + minute window.
 * Stripe deduplicates within 24h, preventing double-charges on retry/double-click.
 */
export async function createOneTimePaymentSession(params: {
  customerId?: string
  customerEmail?: string
  userId: string
  /** Unique discriminator (e.g. 'lifetime', `tip_${postId}`, `group_${groupId}`) */
  discriminator: string
  lineItems: Stripe.Checkout.SessionCreateParams['line_items']
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
  promotionCode?: string
}): Promise<Stripe.Checkout.Session> {
  const idempotencyKey = `payment_${params.userId}_${params.discriminator}_${Math.floor(Date.now() / 60_000)}`

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: params.customerId,
    customer_email: params.customerId ? undefined : params.customerEmail,
    payment_method_types: ['card', 'link'],
    line_items: params.lineItems,
    mode: 'payment',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { ...params.metadata, user_id: params.userId },
    allow_promotion_codes: !params.promotionCode,
    billing_address_collection: 'auto',
    locale: 'auto',
  }

  if (params.promotionCode) {
    sessionParams.discounts = [{ promotion_code: params.promotionCode }]
  }

  return stripe.checkout.sessions.create(sessionParams, { idempotencyKey })
}

// 创建客户门户会话 (用于管理订阅)
export async function createPortalSession(
  customerId: string,
  returnUrl: string
): Promise<Stripe.BillingPortal.Session> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })

  return session
}

// 取消订阅
export async function cancelSubscription(
  subscriptionId: string,
  immediately: boolean = false
): Promise<Stripe.Subscription> {
  if (immediately) {
    return await stripe.subscriptions.cancel(subscriptionId)
  }

  // 在当前周期结束时取消
  return await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  })
}

// 恢复已取消的订阅
export async function resumeSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  })
}

// 获取订阅详情
export async function getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.retrieve(subscriptionId)
}

// 获取客户的所有订阅
export async function getCustomerSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
  })

  return subscriptions.data
}

// Webhook 签名验证
export function constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
  const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET')
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret)
}
