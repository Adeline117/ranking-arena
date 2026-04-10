'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'
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
  const { getAuthHeadersAsync } = useAuthSession()
  const { isPremium: isPro } = usePremium()

  const [info, setInfo] = useState<MembershipInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('yearly')
  const [subscribing, setSubscribing] = useState(false)

  useEffect(() => {
    fetchMembershipInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; fetchMembershipInfo is defined after hook
  }, [])

  async function fetchMembershipInfo() {
    try {
      const headers = await getAuthHeadersAsync()

      const [subRes, nftRes, usageRes] = await Promise.all([
        fetch('/api/subscription', { headers }),
        fetch('/api/membership/nft', { headers }),
        fetch('/api/user/usage', { headers }),
      ])

      const subData = subRes.ok ? await subRes.json() : null
      const nftData = nftRes.ok ? await nftRes.json() : null
      const usageData = usageRes.ok ? await usageRes.json() : { followedTraders: 0, apiCallsToday: 0 }

      setInfo({
        subscription: subData?.subscription || null,
        nft: nftData || null,
        usage: usageData,
      })
    } catch (err) {
      logger.error('Failed to fetch membership info:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleSubscribe = async () => {
    setSubscribing(true)
    // Funnel event #2: user clicked the subscribe button. CEO review
    // 2026-04-09 flagged that there's no visibility between view_pricing and
    // pro_subscribe (the success page) — start_checkout closes that gap.
    trackEvent('start_checkout', { plan: selectedPlan })
    try {
      let { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession()
        session = refreshed.session
      }
      if (!session?.access_token) {
        showToast(t('pleaseLoginAgain'), 'error')
        router.push('/login?redirect=/user-center?tab=membership')
        return
      }

      const response = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          plan: selectedPlan,
          successUrl: `${window.location.origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${window.location.origin}/user-center?tab=membership`,
        }),
      })

      if (!response.ok) {
        let errorMsg = t('createCheckoutFailed')
        try {
          const errorData = await response.json()
          errorMsg = errorData.error || errorMsg
        } catch {
          errorMsg = `${errorMsg} (${response.status})`
        }
        showToast(errorMsg, 'error')
        return
      }

      const data = await response.json()
      if (data.url) {
        window.location.href = data.url
      } else if (data.error) {
        showToast(data.error, 'error')
      } else {
        showToast(t('getPaymentLinkFailed'), 'error')
      }
    } catch {
      showToast(t('subscriptionFailed'), 'error')
    } finally {
      setSubscribing(false)
    }
  }

  if (loading) {
    return (
      <div style={{
        minHeight: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <ButtonSpinner size="md" />
      </div>
    )
  }

  const cardStyle: React.CSSProperties = {
    background: tokens.glass.bg.light, backdropFilter: tokens.glass.blur.xs, WebkitBackdropFilter: tokens.glass.blur.xs,
    border: tokens.glass.border.light,
    borderRadius: tokens.radius.xl,
    padding: tokens.spacing[6],
    marginBottom: tokens.spacing[6],
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Current Plan Status */}
      <CurrentPlanCard
        isPro={isPro}
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
      {!isPro && (
        <ProFeaturesList cardStyle={cardStyle} t={t} />
      )}

      {/* NFT Membership */}
      {(info?.nft?.hasNft || isPro) && (
        <NftMembershipCard
          info={info}
          language={language}
          cardStyle={cardStyle}
          t={t}
        />
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
      {!isPro && (
        <FaqSection cardStyle={cardStyle} t={t} />
      )}

      {/* Subscription Management */}
      {isPro && (
        <SubscriptionManagement
          info={info}
          cardStyle={cardStyle}
          getAuthHeadersAsync={getAuthHeadersAsync}
          t={t}
        />
      )}
    </div>
  )
}
