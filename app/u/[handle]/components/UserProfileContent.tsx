'use client'

import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

import { features } from '@/lib/features'
import type { ServerProfile, ProfileTabKey, TraderPageData } from './types'

const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})

const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {[1, 2, 3].map(i => (
        <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
      ))}
    </div>
  ),
})

interface UserProfileContentProps {
  profile: ServerProfile
  handle: string
  isOwnProfile: boolean
  activeTab: ProfileTabKey
  traderData: TraderPageData | null | undefined
}

export default function UserProfileContent({
  profile,
  handle,
  isOwnProfile,
  activeTab,
  traderData,
}: UserProfileContentProps) {
  const router = useRouter()
  const { t } = useLanguage()

  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown
  const traderProfile = traderData?.profile ?? null

  return (
    <Box key={activeTab} style={{ animation: 'fadeInUp 0.4s ease-out forwards' }}>
      {activeTab === 'overview' && (
        <Box
          className="profile-content"
          style={{ maxWidth: 900 }}
        >
          {features.social ? (
            /* Posts — only shown when social features are enabled */
            <Box bg="secondary" p={4} radius="lg" border="primary">
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                <Text size="lg" weight="black">{t('posts')}</Text>
                {isOwnProfile && (
                  <button
                    onClick={() => router.push(`/u/${handle}/new`)}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.md, border: 'none',
                      background: tokens.colors.accent.brand, color: tokens.colors.white,
                      fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.black,
                      cursor: 'pointer',
                    }}
                  >
                    {t('newPost')}
                  </button>
                )}
              </Box>
              <PostFeed
                authorHandle={profile.handle}
                variant="compact"
                showSortButtons
                createPostHref={isOwnProfile ? `/u/${profile.handle}/new` : undefined}
              />
            </Box>
          ) : (
            /* Fallback when social is off — show profile summary */
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
                {t('userProfileNoStatsYet')}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {activeTab === 'stats' && (
        <Box style={{ maxWidth: 900 }}>
          {traderStats ? (
            <StatsPage
              stats={traderStats}
              traderHandle={traderProfile?.handle || profile.handle || ''}
              assetBreakdown={traderAssetBreakdown}
              equityCurve={traderEquityCurve}
              positionHistory={traderPositionHistory}
              isPro={true}
              onUnlock={() => router.push('/pricing')}
            />
          ) : (
            <Box style={{ padding: tokens.spacing[6], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.xl, border: `1px solid ${tokens.colors.border.primary}`, textAlign: 'center' }}>
              <Text size="sm" color="tertiary">{t('userProfileNoStatsYet')}</Text>
            </Box>
          )}
        </Box>
      )}

      {activeTab === 'portfolio' && (
        <Box style={{ maxWidth: 900 }}>
          <PortfolioTable items={traderPortfolio} history={traderPositionHistory} isPro={true} onUnlock={() => router.push('/pricing')} />
        </Box>
      )}

    </Box>
  )
}
