'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

type ApiPlan = 'starter' | 'pro'

export function useApiCheckout() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checkout = useCallback(
    async (plan: ApiPlan) => {
      setIsLoading(true)
      setError(null)

      try {
        // Server auth requires the Authorization Bearer header — without it,
        // logged-in users got a 401 (cookie fallback can't see localStorage sessions).
        const accessToken = await tokenRefreshCoordinator.getValidToken()
        if (!accessToken) {
          router.push(`/login?redirect=${encodeURIComponent('/api-docs')}`)
          return
        }

        const res = await fetch('/api/stripe/create-api-checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ plan }),
        })

        const data = await res.json()

        if (!res.ok) {
          if (res.status === 401) {
            router.push(`/login?redirect=${encodeURIComponent('/api-docs')}`)
            return
          }
          if (data.code === 'ALREADY_SUBSCRIBED') {
            router.push('/settings#api-keys')
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
      }
    },
    [router]
  )

  return { checkout, isLoading, error }
}
