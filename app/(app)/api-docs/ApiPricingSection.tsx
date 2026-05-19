'use client'

import { tokens } from '@/lib/design-tokens'
import { useApiCheckout } from '@/lib/hooks/useApiCheckout'

const card = {
  padding: tokens.spacing[5],
  borderRadius: tokens.radius.lg,
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
} as const

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    period: '',
    description: 'Explore the API with no commitment.',
    limits: '100 requests/day',
    features: [
      'Rankings endpoint',
      'Trader detail endpoint',
      'Search endpoint',
      'IP-based rate limiting',
    ],
    cta: 'Start Free',
    plan: null as null | 'starter' | 'pro',
    highlighted: false,
  },
  {
    name: 'Starter',
    price: '$49',
    period: '/mo',
    description: 'For indie builders and small teams.',
    limits: '10,000 requests/day',
    features: [
      'Everything in Free',
      'API key authentication',
      'Usage dashboard',
      'Platforms metadata endpoint',
      'Email support',
    ],
    cta: 'Get Started',
    plan: 'starter' as null | 'starter' | 'pro',
    highlighted: true,
  },
  {
    name: 'Pro',
    price: '$199',
    period: '/mo',
    description: 'For trading platforms and hedge funds.',
    limits: 'Unlimited requests',
    features: [
      'Everything in Starter',
      'Historical time series',
      'Bulk export endpoint',
      'Webhook notifications',
      'Priority support + SLA',
    ],
    cta: 'Get Pro',
    plan: 'pro' as null | 'starter' | 'pro',
    highlighted: false,
  },
]

export function ApiPricingSection() {
  const { checkout, isLoading, error } = useApiCheckout()

  return (
    <section style={{ marginBottom: tokens.spacing[10] }}>
      <h2
        style={{
          fontSize: tokens.typography.fontSize.xl,
          fontWeight: 700,
          marginBottom: tokens.spacing[5],
          textAlign: 'center',
        }}
      >
        Pricing
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[4],
        }}
      >
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            style={{
              ...card,
              display: 'flex',
              flexDirection: 'column',
              border: plan.highlighted
                ? '2px solid var(--color-brand)'
                : '1px solid var(--color-border-primary)',
            }}
          >
            <div style={{ marginBottom: tokens.spacing[4] }}>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  color: plan.highlighted ? 'var(--color-brand)' : 'var(--color-text-secondary)',
                  marginBottom: tokens.spacing[1],
                }}
              >
                {plan.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                <span style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 800 }}>
                  {plan.price}
                </span>
                {plan.period && (
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {plan.period}
                  </span>
                )}
              </div>
              <p
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-secondary)',
                  marginTop: tokens.spacing[1],
                }}
              >
                {plan.description}
              </p>
            </div>

            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                marginBottom: tokens.spacing[2],
              }}
            >
              {plan.limits}
            </div>

            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                flex: 1,
                marginBottom: tokens.spacing[4],
              }}
            >
              {plan.features.map((f) => (
                <li
                  key={f}
                  style={{
                    fontSize: 13,
                    color: 'var(--color-text-secondary)',
                    padding: '4px 0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span style={{ color: 'var(--color-accent-success)', fontSize: 14 }}>
                    &#10003;
                  </span>
                  {f}
                </li>
              ))}
            </ul>

            {plan.plan ? (
              <button
                onClick={() => checkout(plan.plan!)}
                disabled={isLoading}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'center',
                  padding: '10px 0',
                  borderRadius: tokens.radius.md,
                  background: plan.highlighted ? 'var(--color-brand)' : 'var(--color-bg-tertiary)',
                  color: plan.highlighted ? '#fff' : 'var(--color-text-primary)',
                  fontSize: 14,
                  fontWeight: 600,
                  border: plan.highlighted ? 'none' : '1px solid var(--color-border-primary)',
                  cursor: isLoading ? 'wait' : 'pointer',
                  opacity: isLoading ? 0.7 : 1,
                }}
              >
                {isLoading ? 'Loading...' : plan.cta}
              </button>
            ) : (
              <a
                href="#endpoints"
                style={{
                  display: 'block',
                  textAlign: 'center',
                  padding: '10px 0',
                  borderRadius: tokens.radius.md,
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-primary)',
                  fontSize: 14,
                  fontWeight: 600,
                  textDecoration: 'none',
                  border: '1px solid var(--color-border-primary)',
                }}
              >
                {plan.cta}
              </a>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p
          style={{
            marginTop: tokens.spacing[3],
            fontSize: 13,
            color: 'var(--color-accent-danger)',
            textAlign: 'center',
          }}
        >
          {error}
        </p>
      )}
    </section>
  )
}
