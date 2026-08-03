'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'

const ProUpsellModal = dynamic(
  () => import('@/app/components/ui/ProGate').then((m) => ({ default: m.ProUpsellModal })),
  { ssr: false }
)
import { tokens, alpha } from '@/lib/design-tokens'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import LinkedAccountStatus from '@/app/components/trader/LinkedAccountStatus'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useLinkedAccounts } from '@/lib/hooks/useLinkedAccounts'
import { trackEvent } from '@/lib/analytics/track'
import OverviewPerformanceCard, {
  type ExtendedPerformance,
} from '@/app/components/trader/OverviewPerformanceCard'

import type { ServerProfile, ProfileTabKey, TraderPageData } from './types'
import { profileStyles } from './profileStyles'

const EquityCurveSection = dynamic(
  () =>
    import('@/app/components/trader/stats/components/EquityCurveSection').then((m) => ({
      default: m.EquityCurveSection,
    })),
  { ssr: false, loading: () => <div style={{ minHeight: 320 }} /> }
)
const TraderFeed = dynamic(() => import('@/app/components/trader/TraderFeed'))
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'))
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})
const ExchangeLinksBar = dynamic(() => import('@/app/components/trader/ExchangeLinksBar'), {
  ssr: false,
  loading: () => <div style={{ minHeight: 40 }} />,
})
const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), { ssr: false })

interface TraderProfileViewProps {
  email: string | null
  handle: string
  profile: ServerProfile
  serverProfile: ServerProfile | null
  currentUserId: string | null
  isPro: boolean
  activeTab: ProfileTabKey
  onTabChange: (tab: ProfileTabKey) => void
  traderData: TraderPageData | null | undefined
}

export default function TraderProfileView({
  email,
  handle,
  profile,
  serverProfile,
  currentUserId,
  isPro,
  activeTab,
  onTabChange,
  traderData,
}: TraderProfileViewProps) {
  const router = useRouter()
  const { t } = useLanguage()

  const traderProfile = traderData?.profile ?? null
  const traderPerformance = traderData?.performance ?? null
  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown
  const _traderFeed = traderData?.feed ?? []
  const _traderSimilar = traderData?.similarTraders ?? []

  const isOwn = !!(currentUserId && profile.id === currentUserId)
  const canView = isPro || isOwn

  // This legacy route has one fixed traderData payload. Linked membership may
  // enrich the primary header and external links, but must never pretend that
  // the fixed payload can switch account scope or become an aggregate view.
  const membershipTraderKey = traderProfile?.trader_key || traderProfile?.id
  const {
    linkedAccounts,
    hasMultipleAccounts,
    isLoading: isLinkedAccountsLoading,
    authoritativeReady,
    error: linkedAccountsError,
  } = useLinkedAccounts(traderProfile?.source, membershipTraderKey)
  const hasProvenLinkedAccounts = authoritativeReady && hasMultipleAccounts
  const [proUpsellOpen, setProUpsellOpen] = useState(false)

  // Tabs — include 'posts' for own profile or claimed user
  type TraderTabKey = 'overview' | 'stats' | 'portfolio' | 'posts'
  const showPosts = isOwn || profile.isRegistered
  const traderActiveTab = ['overview', 'stats', 'portfolio', 'posts'].includes(activeTab)
    ? (activeTab as TraderTabKey)
    : 'overview'

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${alpha(tokens.colors.bg.secondary, 19)} 100%)`,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        className="page-container"
        style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}
      >
        <Breadcrumb
          items={[
            { label: t('userProfileLeaderboard'), href: '/rankings' },
            { label: traderProfile?.handle || profile.handle || handle },
          ]}
        />

        {/* TraderHeader — pass user profile bio/avatar for claimed users */}
        <TraderHeader
          handle={
            traderProfile?.handle || traderProfile?.trader_key || serverProfile?.traderHandle || ''
          }
          displayName={traderProfile?.display_name || undefined}
          traderId={traderProfile?.id || profile.id}
          registeredUserId={profile.isRegistered ? profile.id : undefined}
          avatarUrl={traderProfile?.avatar_url || profile.avatar_url}
          coverUrl={traderProfile?.cover_url || profile.cover_url}
          isRegistered={profile.isRegistered}
          isOwnProfile={isOwn}
          followers={traderProfile?.followers ?? profile.followers}
          source={traderProfile?.source}
          roi90d={traderPerformance?.roi_90d}
          arenaScore={(traderPerformance as ExtendedPerformance | null)?.arena_score_90d ?? null}
          currentUserId={currentUserId}
          isVerifiedTrader={profile.isVerifiedTrader}
          claimedBio={profile.bio}
          claimedAvatarUrl={profile.avatar_url}
          linkedAccountCount={hasProvenLinkedAccounts ? linkedAccounts.length : undefined}
          linkedPlatforms={
            hasProvenLinkedAccounts ? linkedAccounts.map((account) => account.platform) : undefined
          }
        />

        <LinkedAccountStatus isLoading={isLinkedAccountsLoading} error={linkedAccountsError} />

        {/* Exchange links — copy-trade / DEX view */}
        {traderProfile?.source && membershipTraderKey && (
          <ExchangeLinksBar
            primary={{
              platform: traderProfile.source,
              traderKey: membershipTraderKey,
              handle: traderProfile.handle,
            }}
            linkedAccounts={
              hasProvenLinkedAccounts
                ? linkedAccounts.map((account) => ({
                    platform: account.platform,
                    traderKey: account.traderKey,
                    handle: account.handle,
                  }))
                : undefined
            }
            isOwnProfile={isOwn}
          />
        )}

        {/* TraderTabs */}
        <TraderTabs
          activeTab={traderActiveTab}
          onTabChange={(tab) => onTabChange(tab as ProfileTabKey)}
          isPro={isPro}
          onProRequired={() => {
            trackEvent('paywall_blocked', { source: 'claimed_profile_tab' })
            setProUpsellOpen(true)
          }}
          extraTabs={showPosts ? ['posts'] : undefined}
        />
        <ProUpsellModal
          open={proUpsellOpen}
          onClose={() => setProUpsellOpen(false)}
          featureKey="upgradeProStatsDesc"
        />

        {/* Tab content remains scoped to the route's fixed primary trader payload. */}
        <div>
          <Box
            key={traderActiveTab}
            style={{
              animation: 'fadeInUp 0.4s ease-out forwards',
            }}
          >
            {traderActiveTab === 'overview' && (
              <TraderOverviewTab
                handle={handle}
                email={email}
                traderProfile={traderProfile}
                traderPerformance={traderPerformance}
                traderEquityCurve={traderEquityCurve}
                traderFeed={_traderFeed}
                traderSimilar={_traderSimilar}
                serverProfile={serverProfile}
                t={t}
              />
            )}

            {traderActiveTab === 'stats' &&
              (traderStats ? (
                <StatsPage
                  stats={traderStats}
                  traderHandle={traderProfile?.handle || serverProfile?.traderHandle || ''}
                  assetBreakdown={traderAssetBreakdown}
                  equityCurve={traderEquityCurve}
                  positionHistory={traderPositionHistory}
                  isPro={canView}
                  onUnlock={() => router.push('/pricing')}
                />
              ) : (
                <Box
                  style={{
                    padding: tokens.spacing[6],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.xl,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                  }}
                >
                  <Text size="sm" color="tertiary">
                    {t('noStatsData')}
                  </Text>
                </Box>
              ))}

            {traderActiveTab === 'portfolio' && (
              <PortfolioTable
                items={traderPortfolio}
                history={traderPositionHistory}
                isPro={canView}
                onUnlock={() => router.push('/pricing')}
              />
            )}

            {traderActiveTab === 'posts' && showPosts && (
              <Box style={{ maxWidth: 900 }}>
                <PostFeed authorHandle={profile.handle} variant="compact" showSortButtons />
              </Box>
            )}
          </Box>
        </div>

        <style>{profileStyles}</style>
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* Overview Tab                                                        */
/* ------------------------------------------------------------------ */

interface TraderOverviewTabProps {
  handle: string
  email: string | null
  traderProfile: TraderPageData['profile']
  traderPerformance: TraderPageData['performance']
  traderEquityCurve: TraderPageData['equityCurve']
  traderFeed: NonNullable<TraderPageData['feed']>
  traderSimilar: NonNullable<TraderPageData['similarTraders']>
  serverProfile: ServerProfile | null
  t: (key: string) => string
}

function TraderOverviewTab({
  handle,
  email,
  traderProfile,
  traderPerformance,
  traderEquityCurve,
  traderFeed,
  traderSimilar,
  serverProfile,
  t,
}: TraderOverviewTabProps) {
  return (
    <Box
      className="profile-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: traderSimilar.length > 0 ? '1fr 300px' : '1fr',
        gap: tokens.spacing[8],
      }}
    >
      <Box
        className="stagger-enter"
        style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}
      >
        {traderPerformance ? (
          <Box style={{ position: 'relative' }}>
            <OverviewPerformanceCard
              performance={traderPerformance as ExtendedPerformance}
              equityCurve={traderEquityCurve?.['90D']}
              allEquityCurves={
                traderEquityCurve as
                  | Partial<
                      Record<
                        '7D' | '30D' | '90D',
                        Array<{ date: string; roi: number; pnl: number }>
                      >
                    >
                  | undefined
              }
              source={traderProfile?.source}
            />
            {!email && traderEquityCurve?.['90D'] && (
              <Box
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: '40%',
                  background:
                    'linear-gradient(to bottom, transparent 0%, var(--color-blur-overlay) 60%, var(--color-lock-bg) 100%)',
                  backdropFilter: tokens.glass.blur.xs,
                  WebkitBackdropFilter: tokens.glass.blur.xs,
                  borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 5,
                }}
              >
                <Link
                  href={`/login?returnUrl=${encodeURIComponent(`/u/${handle}`)}`}
                  style={{ textDecoration: 'none' }}
                >
                  <Box
                    style={{
                      padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                      background: `${alpha(tokens.colors.accent.primary, 13)}`,
                      border: `1px solid ${alpha(tokens.colors.accent.primary, 31)}`,
                      borderRadius: tokens.radius.lg,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                      {t('userProfileSignUpViewHistory')}
                    </Text>
                  </Box>
                </Link>
              </Box>
            )}
          </Box>
        ) : (
          <Box
            style={{
              padding: tokens.spacing[6],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
              textAlign: 'center',
            }}
          >
            <Text size="sm" color="tertiary">
              {t('noPerformanceData')}
            </Text>
          </Box>
        )}
        {/* Equity Curve Chart */}
        {traderEquityCurve && (
          <EquityCurveSection
            equityCurve={traderEquityCurve}
            traderHandle={traderProfile?.handle || serverProfile?.traderHandle || ''}
            delay={0}
          />
        )}
        <TraderFeed
          items={traderFeed.filter((f: { type: string }) => f.type !== 'group_post')}
          title={t('activities')}
          isRegistered={traderProfile?.isRegistered}
          traderId={traderProfile?.id || ''}
          traderHandle={traderProfile?.handle || ''}
          source={traderProfile?.source}
        />
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
        {traderSimilar.length > 0 && <SimilarTraders traders={traderSimilar} />}
      </Box>
    </Box>
  )
}
