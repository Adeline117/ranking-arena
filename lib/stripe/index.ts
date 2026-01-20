import Stripe from 'stripe'

// Stripe 服务端实例
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
  typescript: true,
})

// 价格 ID 配置 - 使用环境变量中的 Stripe Price ID
export const STRIPE_PRICE_IDS = {
  monthly: process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_PRICE_MONTHLY_ID || 'price_monthly',
  yearly: process.env.STRIPE_ELITE_PRICE_ID || process.env.STRIPE_PRICE_YEARLY_ID || 'price_yearly',
}

// 订阅计划配置 - 与 Stripe 价格保持一致
export const SUBSCRIPTION_PLANS = {
  monthly: {
    name: 'Pro Monthly',
    nameCn: 'Pro 月付会员',
    price: 9.99,
    originalPrice: 15,
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
    price: 99.99,
    originalPrice: 180,
    interval: 'year' as const,
    features: [
      'All monthly features',
      'Save 17%',
      'Priority support',
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
}): Promise<Stripe.Checkout.Session> {
  const session = await stripe.checkout.sessions.create({
    customer: params.customerId,
    // 订阅模式只支持 card，alipay/wechat_pay 不支持 subscription
    payment_method_types: ['card'],
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
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    locale: 'auto',
  })

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
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  )
}
