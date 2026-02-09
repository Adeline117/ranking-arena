'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useSubscription } from '../home/hooks/useSubscription'

// 图标组件
const StarIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)


const ChartIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const FilterIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CompareIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="18" rx="1" />
    <rect x="14" y="3" width="7" height="18" rx="1" />
  </svg>
)

const BellIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

const UsersIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

// Pro 功能配置
const getProFeatures = (t: (key: string) => string) => [
  {
    key: 'category_ranking',
    icon: ChartIcon,
    title: t('featureCategoryRanking'),
    desc: t('featureCategoryRankingDesc'),
    href: '/?category=futures',
    action: 'scroll',
  },
  {
    key: 'trader_compare',
    icon: CompareIcon,
    title: t('featureTraderCompare'),
    desc: t('featureTraderCompareDesc'),
    href: '/compare',
  },
  {
    key: 'advanced_filter',
    icon: FilterIcon,
    title: t('featureAdvancedFilter'),
    desc: t('featureAdvancedFilterDesc'),
    href: '/?filter=advanced',
    action: 'filter',
  },
  {
    key: 'trader_alerts',
    icon: BellIcon,
    title: t('featureTraderAlerts'),
    desc: t('featureTraderAlertsDesc'),
    href: '/settings?tab=alerts',
  },
  {
    key: 'pro_groups',
    icon: UsersIcon,
    title: t('featureProGroups'),
    desc: t('featureProGroupsDesc'),
    href: '/groups?filter=pro',
  },
]

interface ProFeaturesPanelProps {
  compact?: boolean
  showTitle?: boolean
}

export default function ProFeaturesPanel({ compact = false, showTitle = true }: ProFeaturesPanelProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const { isPro, isLoading: _isLoading } = useSubscription()

  const features = getProFeatures(t)

  const handleFeatureClick = (feature: typeof features[0]) => {
    if (!isPro) {
      router.push('/pricing')
      return
    }
    router.push(feature.href)
  }

  return (
    <Box
      style={{
        background: `linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-bg-tertiary) 100%)`,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-pro-glow)',
        overflow: 'hidden',
      }}
    >
      {/* 标题 */}
      {showTitle && (
        <Box
          style={{
            padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
            borderBottom: '1px solid var(--color-border-primary)',
            background: 'var(--color-pro-glow)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Box style={{ color: 'var(--color-pro-gradient-start)' }}>
              <StarIcon size={16} />
            </Box>
            <Text size="sm" weight="bold">
              {t('proFeaturesTitle')}
            </Text>
          </Box>
          {!isPro && (
            <Link href="/pricing" style={{ textDecoration: 'none' }}>
              <Box
                style={{
                  padding: '3px 8px',
                  borderRadius: tokens.radius.full,
                  background: 'var(--color-pro-badge-bg)',
                  fontSize: 10,
                  fontWeight: 700,
                  color: tokens.colors.white,
                }}
              >
                {t('upgrade')}
              </Box>
            </Link>
          )}
        </Box>
      )}

      {/* 功能列表 */}
      <Box
        style={{
          padding: compact ? tokens.spacing[2] : tokens.spacing[3],
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[2],
        }}
      >
        {features.map((feature) => {
          const Icon = feature.icon
          return (
            <Box
              key={feature.key}
              onClick={() => handleFeatureClick(feature)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: compact ? tokens.spacing[2] : tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-secondary)',
                cursor: 'pointer',
                transition: 'all 0.2s',
                opacity: 1,
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-bg-hover)'
                e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'
                e.currentTarget.style.transform = 'translateX(4px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-bg-tertiary)'
                e.currentTarget.style.borderColor = 'var(--color-border-secondary)'
                e.currentTarget.style.transform = 'translateX(0)'
              }}
            >
              {/* 图标 */}
              <Box
                style={{
                  width: compact ? 28 : 32,
                  height: compact ? 28 : 32,
                  borderRadius: tokens.radius.md,
                  background: 'var(--color-pro-glow)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-pro-gradient-start)',
                  flexShrink: 0,
                }}
              >
                <Icon size={compact ? 14 : 16} />
              </Box>

              {/* 文字 */}
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size={compact ? 'xs' : 'sm'} weight="bold" style={{ marginBottom: 2 }}>
                  {feature.title}
                </Text>
                {!compact && (
                  <Text size="xs" color="tertiary" style={{ lineHeight: 1.3 }}>
                    {feature.desc}
                  </Text>
                )}
              </Box>

              {/* 箭头 */}
              <Box style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* 底部升级提示 */}
      {!isPro && !compact && (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderTop: '1px solid var(--color-border-primary)',
            textAlign: 'center',
          }}
        >
          <Link href="/pricing" style={{ textDecoration: 'none' }}>
            <Button
              variant="primary"
              style={{
                width: '100%',
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
              }}
            >
              {t('upgradeToPro')}
            </Button>
          </Link>
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            {t('unlockAllPremiumFeatures')}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * 迷你版 Pro 功能入口
 * 用于在排行榜等位置显示
 */
export function ProFeaturesMini() {
  const router = useRouter()
  const { t } = useLanguage()
  const { isPro } = useSubscription()

  if (isPro) return null

  return (
    <Box
      onClick={() => router.push('/pricing')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.lg,
        background: 'var(--color-pro-glow)',
        border: '1px solid var(--color-pro-gradient-start)',
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = '0 4px 12px var(--color-pro-badge-shadow)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      <Box style={{ color: 'var(--color-pro-gradient-start)' }}>
        <StarIcon size={14} />
      </Box>
      <Text size="xs" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
        {t('unlockProLabel')}
      </Text>
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--color-pro-gradient-start)" strokeWidth="2">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </Box>
  )
}
