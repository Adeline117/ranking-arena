'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authedFetch } from '@/lib/api/client'
import { jwtSubject } from '@/lib/auth/token-subject'
import { getViewerScope, isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'

type ApiPlan = 'starter' | 'pro'

type ApiCheckoutResponse = {
  url?: string
  sessionId?: string
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

type UseApiCheckoutOptions = {
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

export function useApiCheckout(options: UseApiCheckoutOptions = {}) {
  const router = useRouter()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const redirectToCheckout = options.redirectToCheckout ?? defaultCheckoutRedirect

  const [rawIsLoading, setRawIsLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [uiOwner, setUiOwner] = useState<CheckoutViewerSnapshot | null>(null)
  const operationRef = useRef<CheckoutOperation | null>(null)
  const nextOperationIdRef = useRef(0)

  const checkout = useCallback(
    async (plan: ApiPlan) => {
      const viewer = captureCheckoutViewer(authRef.current)
      if (!viewer) {
        if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
          router.push(`/login?redirect=${encodeURIComponent('/api-docs')}`)
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

      const operationIsCurrent = () =>
        operationRef.current?.id === operation.id &&
        checkoutViewerIsCurrent(viewer, authRef.current)

      try {
        const response = await authedFetch<ApiCheckoutResponse>(
          '/api/stripe/create-api-checkout',
          'POST',
          viewer.accessToken,
          { plan },
          20_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
          }
        )

        // Creating a Checkout Session for A is harmless after A -> B only if
        // the stale response can no longer navigate B into A's payment flow.
        if (!operationIsCurrent() || response.stale) return

        const data = response.data
        if (!response.ok) {
          if (response.status === 401) {
            router.push(`/login?redirect=${encodeURIComponent('/api-docs')}`)
            return
          }
          if (data?.code === 'ALREADY_SUBSCRIBED') {
            router.push('/settings#api-keys')
            return
          }
          setRawError(data?.error || 'Checkout failed')
          return
        }

        if (typeof data?.url === 'string' && data.url) {
          // Last CAS immediately before the irreversible browser navigation.
          if (!operationIsCurrent()) return
          redirectToCheckout(data.url)
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

  // Do not expose A's loading/error state during the render that first sees B;
  // waiting for a passive effect here would leave a cross-account UI frame.
  const currentViewer = captureCheckoutViewer(auth)
  const uiBelongsToCurrentViewer = sameCheckoutViewer(uiOwner, currentViewer)

  return {
    checkout,
    isLoading: uiBelongsToCurrentViewer ? rawIsLoading : false,
    error: uiBelongsToCurrentViewer ? rawError : null,
  }
}
