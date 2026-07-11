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
 *   <button onClick={() => checkout('yearly')} disabled={isLoading}>Subscribe</button>
 */

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

type Plan = 'monthly' | 'yearly' | 'lifetime'

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
    async (plan: Plan, options?: { promotionCode?: string; trial?: boolean }) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setIsLoading(true)
      setError(null)
      setAlreadySubscribed(false)

      try {
        // Server auth reads the Authorization Bearer header (cookie fallback is
        // unreliable — sessions live in localStorage, not cookies). Without this
        // header, logged-in users got a 401 and the subscribe button did nothing.
        const accessToken = await tokenRefreshCoordinator.getValidToken()
        if (!accessToken) {
          router.push(`/login?redirect=${encodeURIComponent('/pricing')}`)
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
            plan,
            promotionCode: options?.promotionCode,
            trial: options?.trial,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          if (res.status === 401) {
            // Not logged in — redirect to login with return URL
            router.push(`/login?redirect=${encodeURIComponent('/pricing')}`)
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
