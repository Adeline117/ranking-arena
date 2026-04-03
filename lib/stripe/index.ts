import 'server-only'
import Stripe from 'stripe'

/**
 * Validates that a required Stripe environment variable is set.
 * Throws a descriptive error if missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not configured. ` +
      `Please set it in your environment variables (Vercel Dashboard → Settings → Environment Variables).`
    )
  }
  return value
}

// Stripe 服务端实例 - 懒加载以避免构建时环境变量未定义的问题
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const secretKey = requireEnv('STRIPE_SECRET_KEY')
    _stripe = new Stripe(secretKey, {
      apiVersion: '2026-03-25.dahlia',
      typescript: true,
    })
  }
  return _stripe
}

// 保留 stripe 导出以保持兼容性（但现在是 getter）
export const stripe = {
  get customers() { return getStripe().customers },
  get subscriptions() { return getStripe().subscriptions },
  get checkout() { return getStripe().checkout },
  get billingPortal() { return getStripe().billingPortal },
  get webhooks() { return getStripe().webhooks },
}

// 价格 ID 配置 - Pro 会员的月付/年付/终身价格
// Falls back to STRIPE_PRO_PRICE_ID for both if specific monthly/yearly IDs not set
export const STRIPE_PRICE_IDS = {
  monthly: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_MONTHLY_ID || process.env.STRIPE_PRO_PRICE_ID || '',
  yearly: process.env.STRIPE_PRO_YEARLY_PRICE_ID || process.env.STRIPE_PRICE_YEARLY_ID || process.env.STRIPE_ELITE_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID || '',
  lifetime: process.env.STRIPE_PRO_LIFETIME_PRICE_ID || '',
}

// 订阅计划配置 - 与 Stripe 价格保持一致
export const SUBSCRIPTION_PLANS = {
  monthly: {
    name: 'Pro Monthly',
    nameCn: 'Pro 月付会员',
    price: 4.99,
    originalPrice: null,
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
    price: 29.99,
    originalPrice: 59.88,
    interval: 'year' as const,
    features: [
      'All monthly features',
      'Save 50%',
      'Priority support',
    ],
  },
  lifetime: {
    name: 'Founding Member Lifetime',
    nameCn: '创始会员终身',
    price: 49.99,
    originalPrice: null,
    interval: 'once' as const,
    spotsTotal: 200,
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
  metadata?: Record<string, string>
): Promise<string> {
  // 先查找是否已存在客户
  const existingCustomers = await stripe.customers.list({
    email,
    limit: 1,
  })

  if (existingCustomers.data.length > 0) {
    return existingCustomers.data[0].id
  }

  // 创建新客户
  const customer = await stripe.customers.create({
    email,
    metadata: {
      userId,
      ...metadata,
    },
  })

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
}): Promise<Stripe.Checkout.Session> {
  // Validate priceId before making Stripe API call
  if (!params.priceId || !params.priceId.startsWith('price_')) {
    throw new Error(
      `Invalid Stripe price ID: "${params.priceId}". ` +
      `Please configure STRIPE_PRO_MONTHLY_PRICE_ID and STRIPE_PRO_YEARLY_PRICE_ID environment variables.`
    )
  }

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
    },
    allow_promotion_codes: !params.promotionCode, // Disable UI promotion code input if one is explicitly provided
    billing_address_collection: 'auto',
    locale: 'auto',
  }

  // Apply explicit promotion code if provided
  if (params.promotionCode) {
    sessionParams.discounts = [{ promotion_code: params.promotionCode }]
  }

  const session = await stripe.checkout.sessions.create(sessionParams)
  return session
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
export async function resumeSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  })
}

// 获取订阅详情
export async function getSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.retrieve(subscriptionId)
}

// 获取客户的所有订阅
export async function getCustomerSubscriptions(
  customerId: string
): Promise<Stripe.Subscription[]> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
  })

  return subscriptions.data
}

// Webhook 签名验证
export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET')
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    webhookSecret
  )
}
