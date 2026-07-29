'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import ErrorState from '@/app/components/ui/ErrorState'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'
import { authedFetch } from '@/lib/api/client'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { type MembershipInfo, type PlanType } from './membership-config'
import CurrentPlanCard from './CurrentPlanCard'
import UpgradeSection from './UpgradeSection'
import ProFeaturesList from './ProFeaturesList'
import NftMembershipCard from './NftMembershipCard'
import ComparisonTable from './ComparisonTable'
import UsageStatsCard from './UsageStatsCard'
import FaqSection from './FaqSection'
import SubscriptionManagement from './SubscriptionManagement'

type MembershipContentProps = {
  /** Test seam for the irreversible browser navigation to Stripe Checkout. */
  redirectToCheckout?: (url: string) => void
}

type CheckoutOperation = {
  id: number
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

type CheckoutUiOwner = Pick<SettingsViewerSnapshot, 'viewerKey' | 'sessionGeneration' | 'userId'>

function sameCheckoutViewer(
  left: CheckoutUiOwner | null,
  right: SettingsViewerSnapshot | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.viewerKey === right.viewerKey &&
    left.sessionGeneration === right.sessionGeneration &&
    left.userId === right.userId
  )
}

function defaultCheckoutRedirect(url: string): void {
  window.location.href = url
}

export default function MembershipContent({
  redirectToCheckout = defaultCheckoutRedirect,
}: MembershipContentProps = {}) {
  const { t, language } = useLanguage()
  const router = useRouter()
  const { showToast } = useToast()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const authScopeRef = useRef({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  })
  authScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  }
  const { isPremium: isPro } = usePremium()

  const [infoState, setInfo] = useState<MembershipInfo | null>(null)
  const [loadingState, setLoading] = useState(true)
  const [loadErrorState, setLoadError] = useState(false)
  const infoOwnerScopeKeyRef = useRef(scopeKey)
  const info = infoOwnerScopeKeyRef.current === scopeKey ? infoState : null
  const loading = infoOwnerScopeKeyRef.current === scopeKey ? loadingState : true
  const loadError = infoOwnerScopeKeyRef.current === scopeKey ? loadErrorState : false
  const [selectedPlanState, setSelectedPlanState] = useState<PlanType>('yearly')
  const [planOwner, setPlanOwner] = useState<CheckoutUiOwner | null>(null)
  const [subscribingState, setSubscribing] = useState(false)
  const [checkoutUiOwner, setCheckoutUiOwner] = useState<CheckoutUiOwner | null>(null)
  const checkoutOperationRef = useRef<CheckoutOperation | null>(null)
  const nextCheckoutOperationIdRef = useRef(0)
  const mountedRef = useRef(false)
  const recurringOperationIdsRef = useRef(new Map<string, string>())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      checkoutOperationRef.current?.controller.abort()
      checkoutOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = checkoutOperationRef.current
    if (operation && !isSettingsViewerCurrent(operation.viewer, authRef.current)) {
      operation.controller.abort()
      checkoutOperationRef.current = null
    }
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, auth.viewerKey])

  useEffect(() => {
    if (!auth.authChecked) return
    const capturedScope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    infoOwnerScopeKeyRef.current = scopeKey
    setInfo(null)
    setLoadError(false)
    setLoading(true)
    const controller = new AbortController()
    fetchMembershipInfo(capturedScope, controller.signal)
    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope primitives intentionally own this request
  }, [auth.authChecked, auth.sessionGeneration, auth.userId, auth.viewerKey, scopeKey])

  async function fetchMembershipInfo(
    capturedScope: { viewerKey: string; sessionGeneration: number; userId: string | null },
    signal?: AbortSignal
  ) {
    const scopeIsCurrent = () => {
      const current = authScopeRef.current
      return (
        current.viewerKey === capturedScope.viewerKey &&
        current.sessionGeneration === capturedScope.sessionGeneration &&
        current.userId === capturedScope.userId
      )
    }
    try {
      const headers = await auth.getAuthHeadersAsync()
      if (!scopeIsCurrent()) return

      const [subRes, nftRes, usageRes] = await Promise.all([
        fetch('/api/subscription', { headers, signal }),
        fetch('/api/membership/nft', { headers, signal }),
        fetch('/api/user/usage', { headers, signal }),
      ])

      // If the component unmounted while awaiting, bail out
      if (signal?.aborted || !scopeIsCurrent()) return

      if (!subRes.ok || !nftRes.ok || !usageRes.ok) {
        throw new Error(
          `Membership request failed (subscription=${subRes.status}, nft=${nftRes.status}, usage=${usageRes.status})`
        )
      }

      const [subData, nftData, usageData] = await Promise.all([
        subRes.json(),
        nftRes.json(),
        usageRes.json(),
      ])

      if (signal?.aborted || !scopeIsCurrent()) return

      // Map API response to MembershipInfo shape.
      // The API returns both UserSubscription fields (endDate, autoRenew) and
      // extended fields (currentPeriodEnd, cancelAtPeriodEnd, plan) for the UI.
      const rawSub = subData?.subscription
      const mappedSub = rawSub
        ? {
            tier: rawSub.tier,
            status: rawSub.status,
            plan: rawSub.plan || undefined,
            currentPeriodEnd: rawSub.currentPeriodEnd || rawSub.endDate || undefined,
            cancelAtPeriodEnd:
              rawSub.cancelAtPeriodEnd ?? (rawSub.autoRenew === false && rawSub.tier === 'pro'),
          }
        : null

      setInfo({
        subscription: mappedSub,
        nft: nftData || null,
        usage: usageData,
      })
      setLoadError(false)
    } catch (err) {
      // Only an explicitly aborted request is a navigation/unmount outcome.
      // A generic "Failed to fetch" can also be a real outage and must not be
      // rendered as a free plan with zero usage.
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      logger.error('Failed to fetch membership info:', err)
      if (scopeIsCurrent()) {
        setInfo(null)
        setLoadError(true)
      }
    } finally {
      if (!signal?.aborted && scopeIsCurrent()) setLoading(false)
    }
  }

  function retryMembershipInfo() {
    const capturedScope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    infoOwnerScopeKeyRef.current = scopeKey
    setLoadError(false)
    setLoading(true)
    void fetchMembershipInfo(capturedScope)
  }

  const currentViewer = captureSettingsViewer(auth)
  const selectedPlan = sameCheckoutViewer(planOwner, currentViewer) ? selectedPlanState : 'yearly'
  const subscribing = sameCheckoutViewer(checkoutUiOwner, currentViewer) ? subscribingState : false

  const selectPlan = (plan: PlanType) => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer) return
    setPlanOwner(viewer)
    setSelectedPlanState(plan)
  }

  const handleSubscribe = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        router.push(`/login?redirect=${encodeURIComponent('/user-center?tab=membership')}`)
      }
      return
    }

    const activeOperation = checkoutOperationRef.current
    if (activeOperation && isSettingsViewerCurrent(activeOperation.viewer, authRef.current)) {
      return
    }
    activeOperation?.controller.abort()

    const operation: CheckoutOperation = {
      id: ++nextCheckoutOperationIdRef.current,
      viewer,
      controller: new AbortController(),
    }
    checkoutOperationRef.current = operation
    setCheckoutUiOwner(viewer)
    setSubscribing(true)
    const operationIsCurrent = () =>
      mountedRef.current &&
      checkoutOperationRef.current?.id === operation.id &&
      isSettingsViewerCurrent(viewer, authRef.current)

    // Funnel event #2: user clicked the subscribe button. CEO review
    // 2026-04-09 flagged that there's no visibility between view_pricing and
    // pro_subscribe (the success page) — start_checkout closes that gap.
    trackEvent('start_checkout', { plan: selectedPlan })
    let navigating = false
    try {
      const operationKey =
        selectedPlan === 'lifetime'
          ? null
          : `${viewer.viewerKey}:${viewer.sessionGeneration}:${selectedPlan}:paid`
      let operationId: string | undefined
      if (operationKey) {
        operationId = recurringOperationIdsRef.current.get(operationKey)
        if (!operationId) {
          operationId = globalThis.crypto.randomUUID()
          recurringOperationIdsRef.current.set(operationKey, operationId)
        }
      }

      const result = await authedFetch<{ url?: unknown; error?: unknown }>(
        '/api/stripe/create-checkout',
        'POST',
        viewer.accessToken,
        {
          plan: selectedPlan,
          operationId,
          successUrl: `${window.location.origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${window.location.origin}/user-center?tab=membership`,
        },
        20_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent() || result.stale) return

      if (!result.ok) {
        if (result.status === 401) {
          showToast(t('pleaseLoginAgain'), 'error')
          if (!operationIsCurrent()) return
          router.push(`/login?redirect=${encodeURIComponent('/user-center?tab=membership')}`)
          return
        }
        const errorMsg =
          typeof result.data?.error === 'string'
            ? result.data.error
            : result.status === 0
              ? t('requestTimeout')
              : t('createCheckoutFailed')
        showToast(errorMsg, 'error')
        return
      }

      if (typeof result.data?.url === 'string' && result.data.url.startsWith('https://')) {
        // Last CAS immediately before the irreversible browser navigation.
        if (!operationIsCurrent()) return
        navigating = true
        redirectToCheckout(result.data.url)
        return
      } else if (typeof result.data?.error === 'string') {
        showToast(result.data.error, 'error')
      } else {
        showToast(t('getPaymentLinkFailed'), 'error')
      }
    } catch {
      if (operationIsCurrent()) showToast(t('subscriptionFailed'), 'error')
    } finally {
      // Keep the synchronous guard active after a successful redirect. Browser
      // navigation is not guaranteed to unload before another input event.
      if (!navigating && operationIsCurrent()) {
        setSubscribing(false)
        checkoutOperationRef.current = null
      }
    }
  }

  if (loading) {
    return (
      <div
        style={{
          minHeight: 200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ButtonSpinner size="md" />
      </div>
    )
  }

  if (loadError || !info) {
    return (
      <ErrorState
        description={t('loadFailedRetryShort')}
        retry={retryMembershipInfo}
        variant="compact"
      />
    )
  }

  const cardStyle: React.CSSProperties = {
    background: tokens.glass.bg.light,
    backdropFilter: tokens.glass.blur.xs,
    WebkitBackdropFilter: tokens.glass.blur.xs,
    border: tokens.glass.border.light,
    borderRadius: tokens.radius.xl,
    padding: tokens.spacing[6],
    marginBottom: tokens.spacing[6],
  }

  // Honest entitlement — a genuinely paid/owned Pro plan, NOT the promo-inflated
  // `isPro` (which is true for EVERYONE during PRO_FREE_PROMO). During the promo a
  // never-paid user receives a synthesized Free subscription payload. Gate the
  // Stripe management controls on the server-reported paid tier, not object
  // presence or the promo entitlement. NFT ownership is display-only here.
  const hasRealSubscription = info?.subscription?.tier === 'pro'
  const hasGenuinePro = hasRealSubscription

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Current Plan Status — label reflects a genuine plan, not the promo unlock */}
      <CurrentPlanCard
        isPro={hasGenuinePro}
        info={info}
        language={language}
        cardStyle={cardStyle}
        t={t}
      />

      {/* Upgrade to Pro — only shown for free users */}
      {!isPro && (
        <UpgradeSection
          selectedPlan={selectedPlan}
          setSelectedPlan={selectPlan}
          subscribing={subscribing}
          onSubscribe={handleSubscribe}
          cardStyle={cardStyle}
          t={t}
        />
      )}

      {/* Pro Features (for free users) */}
      {!isPro && <ProFeaturesList cardStyle={cardStyle} t={t} />}

      {/* NFT Membership */}
      {(info?.nft?.hasNft || isPro) && (
        <NftMembershipCard info={info} language={language} cardStyle={cardStyle} t={t} />
      )}

      {/* Free vs Pro Comparison */}
      <ComparisonTable cardStyle={cardStyle} t={t} />

      {/* Usage Stats */}
      <UsageStatsCard
        followedTraders={info?.usage?.followedTraders || 0}
        maxFollows={isPro ? FEATURE_LIMITS.pro.maxFollows : FEATURE_LIMITS.free.maxFollows}
        cardStyle={cardStyle}
        t={t}
      />

      {/* FAQ (for free users) */}
      {!isPro && <FaqSection cardStyle={cardStyle} t={t} />}

      {/* The route re-verifies the exact Stripe subscription before it creates either
          single-action payment-method or cancellation flow. */}
      {hasRealSubscription && (
        <SubscriptionManagement
          info={info}
          cardStyle={cardStyle}
          getAuthHeadersAsync={auth.getAuthHeadersAsync}
          t={t}
        />
      )}
    </div>
  )
}
