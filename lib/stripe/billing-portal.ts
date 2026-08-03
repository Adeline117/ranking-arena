import 'server-only'
import type Stripe from 'stripe'
import {
  assertStripeSubscriptionIdentity,
  stripeMetadataUserId,
  stripeObjectId,
} from '@/lib/stripe/identity'

export type BillingPortalFlow = 'payment_method_update' | 'subscription_cancel'
export type BillingPortalScope = 'membership' | 'api'
export type BillingPortalPlan = 'monthly' | 'yearly' | 'starter' | 'pro'

export type BillingPortalPriceCatalog = {
  membership: {
    monthly: string
    yearly: string
  }
  api: {
    starter: string
    pro: string
  }
}

export type BillingPortalAuthority = {
  userId: string
  customerId: string
  subscriptionId: string
  scope: BillingPortalScope
  plan: BillingPortalPlan
  localStatus: string
  livemode: boolean
}

type BillingPortalFlowRequest = {
  stripe: BillingPortalStripeClient
  authority: BillingPortalAuthority
  returnUrl: string
} & (
  | {
      flow: 'payment_method_update'
      prices: BillingPortalPriceCatalog
    }
  | {
      flow: 'subscription_cancel'
      prices?: BillingPortalPriceCatalog
    }
)

type BillingPortalStripeClient = {
  customers: {
    retrieve(customerId: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>
  }
  subscriptions: {
    retrieve(subscriptionId: string): Promise<Stripe.Subscription>
  }
  billingPortal: {
    sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams
      ): Promise<Stripe.BillingPortal.Session>
    }
  }
}

type PortalFlowData = NonNullable<Stripe.BillingPortal.SessionCreateParams['flow_data']>
type PortalAfterCompletion = NonNullable<PortalFlowData['after_completion']>

const manageableStatuses = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
])

function assertStripeId(value: string, prefix: 'cus_' | 'sub_' | 'price_', field: string): void {
  if (
    !new RegExp(`^${prefix}[A-Za-z0-9_]+$`).test(value) ||
    value.length <= prefix.length ||
    value.length > 255
  ) {
    throw new Error(`Billing Portal ${field} is invalid`)
  }
}

function assertCustomerShape(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
  authority: BillingPortalAuthority
): asserts customer is Stripe.Customer {
  if (
    customer.object !== 'customer' ||
    customer.id !== authority.customerId ||
    customer.deleted === true
  ) {
    throw new Error('Billing Portal customer identity is invalid')
  }
  if (customer.livemode !== authority.livemode) {
    throw new Error('Billing Portal customer mode is invalid')
  }

  const metadataUserId = stripeMetadataUserId(customer.metadata, `Stripe customer ${customer.id}`)
  if (metadataUserId !== authority.userId) {
    throw new Error('Billing Portal customer belongs to a different user')
  }
}

function assertAuthorityPlan(authority: BillingPortalAuthority): void {
  if (authority.scope === 'membership') {
    if (authority.plan !== 'monthly' && authority.plan !== 'yearly') {
      throw new Error('Billing Portal membership plan is invalid')
    }
    return
  }

  if (authority.plan !== 'starter' && authority.plan !== 'pro') {
    throw new Error('Billing Portal API plan is invalid')
  }
}

function expectedPriceId(
  authority: BillingPortalAuthority,
  catalog: BillingPortalPriceCatalog
): string {
  if (authority.scope === 'membership') {
    if (authority.plan !== 'monthly' && authority.plan !== 'yearly') {
      throw new Error('Billing Portal membership plan is invalid')
    }
    const monthly = catalog.membership.monthly
    const yearly = catalog.membership.yearly
    assertStripeId(monthly, 'price_', 'monthly price')
    assertStripeId(yearly, 'price_', 'yearly price')
    if (monthly === yearly) {
      throw new Error('Billing Portal membership price identity is ambiguous')
    }

    const selected = catalog.membership[authority.plan]
    if (selected === catalog.api.starter || selected === catalog.api.pro) {
      throw new Error('Billing Portal product scope is ambiguous')
    }
    return selected
  }

  if (authority.plan !== 'starter' && authority.plan !== 'pro') {
    throw new Error('Billing Portal API plan is invalid')
  }
  const starter = catalog.api.starter
  const pro = catalog.api.pro
  assertStripeId(starter, 'price_', 'API Starter price')
  assertStripeId(pro, 'price_', 'API Pro price')
  if (starter === pro) {
    throw new Error('Billing Portal API price identity is ambiguous')
  }

  const selected = catalog.api[authority.plan]
  if (selected === catalog.membership.monthly || selected === catalog.membership.yearly) {
    throw new Error('Billing Portal product scope is ambiguous')
  }
  return selected
}

function assertSubscriptionShape(
  subscription: Stripe.Subscription,
  authority: BillingPortalAuthority,
  expectedPrice: string | null
): void {
  assertStripeSubscriptionIdentity(subscription, {
    subscriptionId: authority.subscriptionId,
    customerId: authority.customerId,
    userId: authority.userId,
    source: 'Billing Portal authority',
  })

  if (subscription.object !== 'subscription' || subscription.livemode !== authority.livemode) {
    throw new Error('Billing Portal subscription mode is invalid')
  }
  if (!manageableStatuses.has(subscription.status)) {
    throw new Error('Billing Portal subscription is not manageable')
  }

  const metadataUserId = stripeMetadataUserId(
    subscription.metadata,
    `Stripe subscription ${subscription.id}`
  )
  if (metadataUserId !== authority.userId) {
    throw new Error('Billing Portal subscription belongs to a different user')
  }

  const items = subscription.items
  if (
    !items ||
    items.object !== 'list' ||
    items.has_more !== false ||
    !Array.isArray(items.data) ||
    items.data.length !== 1 ||
    items.data[0]?.object !== 'subscription_item' ||
    items.data[0].quantity !== 1 ||
    !/^si_[A-Za-z0-9_]+$/.test(items.data[0].id) ||
    items.data[0].id.length > 255
  ) {
    throw new Error('Billing Portal subscription item identity is ambiguous')
  }

  const price = items.data[0].price
  if (
    !price ||
    price.object !== 'price' ||
    typeof price.id !== 'string' ||
    !/^price_[A-Za-z0-9_]+$/.test(price.id) ||
    price.id.length > 255 ||
    price.livemode !== authority.livemode
  ) {
    throw new Error('Billing Portal subscription item price identity is invalid')
  }
  if (expectedPrice !== null && price.id !== expectedPrice) {
    throw new Error('Billing Portal subscription belongs to a different product scope')
  }

  const metadata = subscription.metadata
  if (authority.scope === 'api') {
    if (metadata.type !== 'api_tier') {
      throw new Error('Billing Portal API subscription metadata is invalid')
    }
    if (metadata.api_plan !== authority.plan) {
      throw new Error('Billing Portal API plan metadata is invalid')
    }
  } else {
    if (metadata.type !== 'pro_membership') {
      throw new Error('Billing Portal membership subscription metadata is invalid')
    }
    if (metadata.plan !== authority.plan) {
      throw new Error('Billing Portal membership plan metadata is invalid')
    }
  }
}

function portalSessionParams(
  authority: BillingPortalAuthority,
  flow: BillingPortalFlow,
  returnUrl: string
): Stripe.BillingPortal.SessionCreateParams {
  if (flow !== 'payment_method_update' && flow !== 'subscription_cancel') {
    throw new Error('Billing Portal flow is not allowed')
  }

  const afterCompletion: PortalAfterCompletion = {
    type: 'redirect',
    redirect: { return_url: returnUrl },
  }

  if (flow === 'subscription_cancel') {
    return {
      customer: authority.customerId,
      flow_data: {
        type: 'subscription_cancel',
        subscription_cancel: { subscription: authority.subscriptionId },
        after_completion: afterCompletion,
      },
    }
  }

  return {
    customer: authority.customerId,
    flow_data: {
      type: 'payment_method_update',
      after_completion: afterCompletion,
    },
  }
}

function assertCreatedPortalSession(
  session: Stripe.BillingPortal.Session,
  authority: BillingPortalAuthority,
  flow: BillingPortalFlow,
  returnUrl: string
): void {
  if (
    !session.id?.startsWith('bps_') ||
    session.object !== 'billing_portal.session' ||
    session.customer !== authority.customerId ||
    session.livemode !== authority.livemode ||
    session.flow?.type !== flow ||
    session.flow.after_completion.type !== 'redirect' ||
    session.flow.after_completion.redirect?.return_url !== returnUrl
  ) {
    throw new Error('Stripe returned an invalid Billing Portal flow')
  }

  if (
    flow === 'subscription_cancel' &&
    session.flow.subscription_cancel?.subscription !== authority.subscriptionId
  ) {
    throw new Error('Stripe returned a Billing Portal flow for a different subscription')
  }
  if (flow === 'payment_method_update' && session.flow.subscription_cancel !== null) {
    throw new Error('Stripe returned an ambiguous Billing Portal flow')
  }
  if (
    session.flow.subscription_update !== null ||
    session.flow.subscription_update_confirm !== null
  ) {
    throw new Error('Stripe returned a subscription-update Billing Portal flow')
  }

  const sessionCustomerId = stripeObjectId(session.customer)
  if (sessionCustomerId !== authority.customerId) {
    throw new Error('Stripe returned a Billing Portal flow for a different customer')
  }

  let url: URL
  try {
    url = new URL(session.url)
  } catch {
    throw new Error('Stripe returned an invalid Billing Portal URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('Stripe returned an insecure Billing Portal URL')
  }
}

/**
 * Creates only a Stripe-hosted, single-action portal flow.
 *
 * There is intentionally no generic portal-homepage or subscription-update
 * option here. Stripe deep-link flows hide the rest of the portal navigation,
 * and the redirect completion prevents the customer from falling through to a
 * Dashboard-configured portal homepage after finishing the action.
 */
export async function createBillingPortalFlow(
  params: BillingPortalFlowRequest
): Promise<Stripe.BillingPortal.Session> {
  const { authority } = params
  if (params.flow !== 'payment_method_update' && params.flow !== 'subscription_cancel') {
    throw new Error('Billing Portal flow is not allowed')
  }
  if (!authority.userId || (authority.scope !== 'membership' && authority.scope !== 'api')) {
    throw new Error('Billing Portal authority scope is invalid')
  }
  assertStripeId(authority.customerId, 'cus_', 'customer')
  assertStripeId(authority.subscriptionId, 'sub_', 'subscription')
  assertAuthorityPlan(authority)
  if (!manageableStatuses.has(authority.localStatus as Stripe.Subscription.Status)) {
    throw new Error('Billing Portal local subscription is not manageable')
  }

  const redirect = new URL(params.returnUrl)
  if (
    redirect.protocol !== 'https:' &&
    !(redirect.protocol === 'http:' && redirect.hostname === 'localhost')
  ) {
    throw new Error('Billing Portal completion URL must be HTTPS')
  }

  // Cancellation is a cost-reducing action. Its exact durable local and Stripe
  // identity is sufficient; unrelated current Checkout price configuration is
  // deliberately outside that decision. Payment-method updates retain the
  // current catalog boundary because they can enable future charges.
  const expectedPrice =
    params.flow === 'payment_method_update' ? expectedPriceId(authority, params.prices) : null
  const customer = await params.stripe.customers.retrieve(authority.customerId)
  assertCustomerShape(customer, authority)

  const subscription = await params.stripe.subscriptions.retrieve(authority.subscriptionId)
  assertSubscriptionShape(subscription, authority, expectedPrice)

  const session = await params.stripe.billingPortal.sessions.create(
    portalSessionParams(authority, params.flow, redirect.href)
  )
  assertCreatedPortalSession(session, authority, params.flow, redirect.href)
  return session
}
