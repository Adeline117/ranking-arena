'use client'

/**
 * useDirectCheckout — One-click payment infrastructure.
 *
 * ROOT-ROOT CAUSE FIX: Previously the pricing page linked to /user-center?tab=membership,
 * requiring 2 extra clicks before reaching Stripe. This hook handles the entire flow:
 * auth check → create Stripe session → redirect to checkout.
 *
 * Usage:
 *   const { checkout, isLoading } = useDirectCheckout()
 *   <button onClick={() => checkout({ plan: 'yearly' })} disabled={isLoading}>Subscribe</button>
 */

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import {
  buildPricingCheckoutLoginHref,
  type PricingCheckoutIntent,
} from '@/lib/premium/pricing-login-intent'

type DirectCheckoutIntent = PricingCheckoutIntent & {
  promotionCode?: string
}

export function useDirectCheckout() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [alreadySubscribed, setAlreadySubscribed] = useState(false)
  // Synchronous re-entrancy guard. `isLoading` is React state (async), so a
  // rapid double-click can fire two checkout() calls before the first re-render
  // disables the button — creating two Stripe sessions. A ref flips immediately.
  const inFlightRef = useRef(false)

  const checkout = useCallback(
    async (intent: DirectCheckoutIntent) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setIsLoading(true)
      setError(null)
      setAlreadySubscribed(false)

      try {
        const loginHref = buildPricingCheckoutLoginHref(intent)
        // Server auth reads the Authorization Bearer header (cookie fallback is
        // unreliable — sessions live in localStorage, not cookies). Without this
        // header, logged-in users got a 401 and the subscribe button did nothing.
        const accessToken = await tokenRefreshCoordinator.getValidToken()
        if (!accessToken) {
          router.push(loginHref)
          return
        }

        const res = await fetch('/api/stripe/create-checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({
            plan: intent.plan,
            promotionCode: intent.promotionCode,
            trial: intent.plan === 'lifetime' ? undefined : intent.trial,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          if (res.status === 401) {
            // Keep only the typed pricing intent in a fixed internal return path.
            // The pricing page restores the selection but never auto-starts payment.
            router.push(loginHref)
            return
          }
          if (data.code === 'ALREADY_SUBSCRIBED') {
            // Signal to caller so they can show feedback (toast, banner, etc.)
            setAlreadySubscribed(true)
            router.push('/user-center?tab=membership')
            return
          }
          setError(data.error || 'Checkout failed')
          return
        }

        if (data.url) {
          window.location.href = data.url
        }
      } catch {
        setError('Network error. Please try again.')
      } finally {
        setIsLoading(false)
        inFlightRef.current = false
      }
    },
    [router]
  )

  return { checkout, isLoading, error, alreadySubscribed }
}
