const TIP_CHECKOUT_PATH = '/api/tip/checkout'

export function isTipCheckoutEnabled(
  value: string | undefined = process.env.STRIPE_TIP_CHECKOUT_ENABLED
): boolean {
  return value === 'true'
}

export function shouldFreezeTipCheckout(
  pathname: string,
  method: string,
  value: string | undefined = process.env.STRIPE_TIP_CHECKOUT_ENABLED
): boolean {
  const isCheckoutPath = pathname === TIP_CHECKOUT_PATH || pathname === `${TIP_CHECKOUT_PATH}/`
  return isCheckoutPath && method.toUpperCase() === 'POST' && !isTipCheckoutEnabled(value)
}
