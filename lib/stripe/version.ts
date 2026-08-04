import type Stripe from 'stripe'

type StripeApiVersion = NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']

export const STRIPE_API_VERSION = '2026-07-29.dahlia' satisfies StripeApiVersion
