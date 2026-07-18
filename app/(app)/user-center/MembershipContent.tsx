'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'
import { apiRequest } from '@/lib/api/client'
import { type MembershipInfo, type PlanType } from './membership-config'
import CurrentPlanCard from './CurrentPlanCard'
import UpgradeSection from './UpgradeSection'
import ProFeaturesList from './ProFeaturesList'
import NftMembershipCard from './NftMembershipCard'
import ComparisonTable from './ComparisonTable'
import UsageStatsCard from './UsageStatsCard'
import FaqSection from './FaqSection'
import SubscriptionManagement from './SubscriptionManagement'

export default function MembershipContent() {
  const { t, language } = useLanguage()
  const router = useRouter()
  const { showToast } = useToast()
  const auth = useAuthSession()
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
  const infoOwnerScopeKeyRef = useRef(scopeKey)
  const info = infoOwnerScopeKeyRef.current === scopeKey ? infoState : null
  const loading = infoOwnerScopeKeyRef.current === scopeKey ? loadingState : true
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('yearly')
  const [subscribing, setSubscribing] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    if (!auth.authChecked) return
    const capturedScope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    infoOwnerScopeKeyRef.current = scopeKey
    setInfo(null)
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

      const subData = subRes.ok ? await subRes.json() : null
      const nftData = nftRes.ok ? await nftRes.json() : null
      const usageData = usageRes.ok
        ? await usageRes.json()
        : { followedTraders: 0, apiCallsToday: 0 }

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
    } catch (err) {
      // Silently ignore navigation-interrupted fetches (component unmounted or route
      // change): AbortError OR the "TypeError: Failed to fetch" a torn-down fetch
      // throws. Neither is a real membership-fetch failure.
      const msg = err instanceof Error ? err.message : ''
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        /Failed to fetch/i.test(msg)
      )
        return
      logger.error('Failed to fetch membership info:', err)
    } finally {
      if (!signal?.aborted && scopeIsCurrent()) setLoading(false)
    }
  }

  const handleSubscribe = async () => {
    // Ref-based guard: synchronous check prevents duplicate Stripe checkout
    // sessions even when React batches the setState(subscribing) update.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubscribing(true)
    // Funnel event #2: user clicked the subscribe button. CEO review
    // 2026-04-09 flagged that there's no visibility between view_pricing and
    // pro_subscribe (the success page) — start_checkout closes that gap.
    trackEvent('start_checkout', { plan: selectedPlan })
    try {
      const capturedScope = {
        viewerKey: auth.viewerKey,
        sessionGeneration: auth.sessionGeneration,
        userId: auth.userId,
      }
      const scopeIsCurrent = () => {
        const current = authScopeRef.current
        return (
          current.viewerKey === capturedScope.viewerKey &&
          current.sessionGeneration === capturedScope.sessionGeneration &&
          current.userId === capturedScope.userId
        )
      }
      const accessToken = await auth.getToken()
      if (!scopeIsCurrent()) return
      if (!accessToken) {
        showToast(t('pleaseLoginAgain'), 'error')
        router.push('/login?redirect=/user-center?tab=membership')
        return
      }

      const result = await apiRequest<{ url?: string; error?: string }>(
        '/api/stripe/create-checkout',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: {
            plan: selectedPlan,
            successUrl: `${window.location.origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${window.location.origin}/user-center?tab=membership`,
          },
          timeoutMs: 20_000,
        }
      )
      if (!scopeIsCurrent()) return

      if (!result.success) {
        const errorMsg =
          result.error?.code === 'TIMEOUT'
            ? t('requestTimeout')
            : result.error?.message || t('createCheckoutFailed')
        showToast(errorMsg, 'error')
        return
      }

      if (result.data?.url) {
        // Don't re-enable the button — we're navigating away to Stripe
        window.location.href = result.data.url
        return
      } else if (result.data?.error) {
        showToast(result.data.error, 'error')
      } else {
        showToast(t('getPaymentLinkFailed'), 'error')
      }
    } catch {
      showToast(t('subscriptionFailed'), 'error')
    } finally {
      // Only reset on error paths — successful checkout navigates away to
      // Stripe, so we keep the guard active to prevent duplicate sessions.
      setSubscribing(false)
      submittingRef.current = false
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
  // never-paid user has `info.subscription === null`, so claiming "Current Plan: Pro"
  // + rendering the Stripe subscription-management panel (Change Plan / Billing
  // History / Cancel → /api/stripe/portal → dead-ends to /pricing) is a false claim.
  // NFT ownership is a display badge, not payment authority.
  const hasRealSubscription = !!info?.subscription
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
          setSelectedPlan={setSelectedPlan}
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

      {/* Subscription Management — only for a REAL Stripe subscription. The portal
          buttons (Change Plan / Billing History / Cancel) all hit /api/stripe/portal,
          which returns { redirect: '/pricing' } for a user with no stripe_customer_id
          — a dead-end for promo users. Mirror the Cancel button's existing
          `info?.subscription` gate. */}
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
