const TIP_CHECKOUT_PATH = '/api/tip/checkout'

export function isTipCheckoutEnabled(
  value: string | undefined = process.env.STRIPE_TIP_CHECKOUT_ENABLED
): boolean {
  return value === 'true'
}

export function isTipCheckoutLiveModeConfigured(
  secretKey: string | undefined = process.env.STRIPE_SECRET_KEY,
  publishableKey: string | undefined = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
): boolean {
  return (
    secretKey?.startsWith('sk_live_') === true &&
    secretKey.length > 'sk_live_'.length &&
    secretKey === secretKey.trim() &&
    publishableKey?.startsWith('pk_live_') === true &&
    publishableKey.length > 'pk_live_'.length &&
    publishableKey === publishableKey.trim()
  )
}

export function isTipCheckoutRuntimeEnabled(
  value: string | undefined = process.env.STRIPE_TIP_CHECKOUT_ENABLED,
  secretKey: string | undefined = process.env.STRIPE_SECRET_KEY,
  publishableKey: string | undefined = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
): boolean {
  return isTipCheckoutEnabled(value) && isTipCheckoutLiveModeConfigured(secretKey, publishableKey)
}

export function shouldFreezeTipCheckout(
  pathname: string,
  method: string,
  value: string | undefined = process.env.STRIPE_TIP_CHECKOUT_ENABLED,
  secretKey: string | undefined = process.env.STRIPE_SECRET_KEY,
  publishableKey: string | undefined = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
): boolean {
  const isCheckoutPath = pathname === TIP_CHECKOUT_PATH || pathname === `${TIP_CHECKOUT_PATH}/`
  return (
    isCheckoutPath &&
    method.toUpperCase() === 'POST' &&
    !isTipCheckoutRuntimeEnabled(value, secretKey, publishableKey)
  )
}
