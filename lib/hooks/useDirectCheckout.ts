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

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { authedFetch } from '@/lib/api/client'
import { jwtSubject } from '@/lib/auth/token-subject'
import { getViewerScope, isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import { isTrustedStripeCheckoutUrl } from '@/lib/stripe/hosted-url'
import {
  buildPricingCheckoutLoginHref,
  type PricingCheckoutIntent,
} from '@/lib/premium/pricing-login-intent'

type DirectCheckoutIntent = PricingCheckoutIntent & {
  promotionCode?: string
}

type DirectCheckoutResponse = {
  url?: string
  error?: string
  code?: string
}

type CheckoutViewerSnapshot = ViewerScope & {
  accessToken: string
  userId: string
  viewerKey: `user:${string}`
}

type CheckoutOperation = {
  id: number
  viewer: CheckoutViewerSnapshot
}

type UseDirectCheckoutOptions = {
  /** Test seam for the hard browser navigation used by Stripe Checkout. */
  redirectToCheckout?: (url: string) => void
}

function defaultCheckoutRedirect(url: string): void {
  window.location.href = url
}

function captureCheckoutViewer(auth: AuthSessionReturn): CheckoutViewerSnapshot | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.userId ||
    !auth.accessToken ||
    auth.viewerKey !== `user:${auth.userId}` ||
    jwtSubject(auth.accessToken) !== auth.userId
  ) {
    return null
  }

  const processScope = getViewerScope()
  if (
    processScope.viewerKey !== auth.viewerKey ||
    processScope.userId !== auth.userId ||
    processScope.sessionGeneration !== auth.sessionGeneration
  ) {
    return null
  }

  return {
    viewerKey: auth.viewerKey as `user:${string}`,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    accessToken: auth.accessToken,
  }
}

function checkoutViewerIsCurrent(viewer: CheckoutViewerSnapshot, auth: AuthSessionReturn): boolean {
  return (
    isViewerScopeCurrent(viewer) &&
    auth.authChecked &&
    !auth.loading &&
    auth.viewerKey === viewer.viewerKey &&
    auth.userId === viewer.userId &&
    auth.sessionGeneration === viewer.sessionGeneration
  )
}

function sameCheckoutViewer(
  left: CheckoutViewerSnapshot | null,
  right: CheckoutViewerSnapshot | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.viewerKey === right.viewerKey &&
    left.userId === right.userId &&
    left.sessionGeneration === right.sessionGeneration
  )
}

export function useDirectCheckout(options: UseDirectCheckoutOptions = {}) {
  const router = useRouter()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const redirectToCheckout = options.redirectToCheckout ?? defaultCheckoutRedirect
  const mountedRef = useRef(false)
  const [rawIsLoading, setRawIsLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [rawAlreadySubscribed, setRawAlreadySubscribed] = useState(false)
  const [uiOwner, setUiOwner] = useState<CheckoutViewerSnapshot | null>(null)
  const operationRef = useRef<CheckoutOperation | null>(null)
  const nextOperationIdRef = useRef(0)
  // Keep one caller-owned operation across technical retries. Stripe and the
  // durable reservation can then recover the same Session instead of turning a
  // timeout/retry into a second admission attempt.
  const recurringOperationIdsRef = useRef(new Map<string, string>())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current = null
    }
  }, [])

  const checkout = useCallback(
    async (intent: DirectCheckoutIntent) => {
      const loginHref = buildPricingCheckoutLoginHref(intent)
      const viewer = captureCheckoutViewer(authRef.current)
      if (!viewer) {
        if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
          router.push(loginHref)
        }
        return
      }

      const activeOperation = operationRef.current
      if (activeOperation && checkoutViewerIsCurrent(activeOperation.viewer, authRef.current)) {
        return
      }

      const operation: CheckoutOperation = {
        id: ++nextOperationIdRef.current,
        viewer,
      }
      operationRef.current = operation
      setUiOwner(viewer)
      setRawIsLoading(true)
      setRawError(null)
      setRawAlreadySubscribed(false)

      const operationIsCurrent = () =>
        mountedRef.current &&
        operationRef.current?.id === operation.id &&
        checkoutViewerIsCurrent(viewer, authRef.current)

      try {
        const operationKey =
          intent.plan === 'lifetime'
            ? null
            : `${viewer.viewerKey}:${viewer.sessionGeneration}:${intent.plan}:${
                intent.trial === true ? 'trial' : 'paid'
              }`
        let operationId: string | undefined
        if (operationKey) {
          operationId = recurringOperationIdsRef.current.get(operationKey)
          if (!operationId) {
            operationId = globalThis.crypto.randomUUID()
            recurringOperationIdsRef.current.set(operationKey, operationId)
          }
        }

        const response = await authedFetch<DirectCheckoutResponse>(
          '/api/stripe/create-checkout',
          'POST',
          viewer.accessToken,
          {
            plan: intent.plan,
            promotionCode: intent.promotionCode,
            trial: intent.plan === 'lifetime' ? undefined : intent.trial,
            operationId,
          },
          20_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
          }
        )

        if (!operationIsCurrent() || response.stale) return
        const data = response.data
        if (!response.ok) {
          if (response.status === 401) {
            // Keep only the typed pricing intent in a fixed internal return path.
            // The pricing page restores the selection but never auto-starts payment.
            router.push(loginHref)
            return
          }
          if (data?.code === 'ALREADY_SUBSCRIBED') {
            // Signal to caller so they can show feedback (toast, banner, etc.)
            setRawAlreadySubscribed(true)
            router.push('/user-center?tab=membership')
            return
          }
          setRawError(data?.error || 'Checkout failed')
          return
        }

        if (isTrustedStripeCheckoutUrl(data?.url)) {
          // Last ownership CAS immediately before the irreversible navigation.
          if (!operationIsCurrent()) return
          redirectToCheckout(data.url)
        } else {
          setRawError('Checkout failed')
        }
      } catch {
        if (operationIsCurrent()) setRawError('Network error. Please try again.')
      } finally {
        if (operationIsCurrent()) {
          setRawIsLoading(false)
          operationRef.current = null
        }
      }
    },
    [redirectToCheckout, router]
  )

  // Never expose A's billing state in the first render that observes B.
  const currentViewer = captureCheckoutViewer(auth)
  const uiBelongsToCurrentViewer = sameCheckoutViewer(uiOwner, currentViewer)

  return {
    checkout,
    isLoading: uiBelongsToCurrentViewer ? rawIsLoading : false,
    error: uiBelongsToCurrentViewer ? rawError : null,
    alreadySubscribed: uiBelongsToCurrentViewer ? rawAlreadySubscribed : false,
  }
}
