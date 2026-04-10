'use client'

import { ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import Link from 'next/link'

// 锁图标 SVG
const LockIcon = ({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M19 11H5C3.89543 11 3 11.8954 3 13V20C3 21.1046 3.89543 22 5 22H19C20.1046 22 21 21.1046 21 20V13C21 11.8954 20.1046 11 19 11Z"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 11V7C7 5.67392 7.52678 4.40215 8.46447 3.46447C9.40215 2.52678 10.6739 2 12 2C13.3261 2 14.5979 2.52678 15.5355 3.46447C16.4732 4.40215 17 5.67392 17 7V11"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="16" r="1.5" fill={color} />
  </svg>
)

// 星星图标 SVG
const StarIcon = ({ size = 12, color = 'var(--color-on-accent)' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

/**
 * Per-feature benefit copy. Lets the gate show contextual upsell copy
 * instead of a generic "Pro membership required" lock. Audit P1-PROD-1.
 *
 * Each entry maps to a value-prop that's surfaced when the user actually
 * hits this gate, so the upsell is grounded in what the user just tried
 * to do (not abstract Pro marketing). Add new keys here as new gates
 * are introduced.
 */
type FeatureBenefitKey =
  | 'advancedAlerts'
  | 'comparison'
  | 'csvExport'
  | 'apiAccess'
  | 'scoreBreakdown'
  | 'advancedFilters'
  | 'historicalData'
  | 'unlimitedWatchlist'

const FEATURE_BENEFITS: Record<FeatureBenefitKey, { titleKey: string; benefitKeys: string[] }> = {
  advancedAlerts: {
    titleKey: 'gateAdvancedAlertsTitle',
    benefitKeys: ['gateBenefitAlertsRealtime', 'gateBenefitAlertsConditions', 'gateBenefitAlertsHistory'],
  },
  comparison: {
    titleKey: 'gateComparisonTitle',
    benefitKeys: ['gateBenefitCompareSideBySide', 'gateBenefitCompareMetrics', 'gateBenefitCompareExport'],
  },
  csvExport: {
    titleKey: 'gateCsvExportTitle',
    benefitKeys: ['gateBenefitCsvFullData', 'gateBenefitCsvScheduled', 'gateBenefitCsvUnlimited'],
  },
  apiAccess: {
    titleKey: 'gateApiAccessTitle',
    benefitKeys: ['gateBenefitApiRest', 'gateBenefitApiHistorical', 'gateBenefitApiHigherLimits'],
  },
  scoreBreakdown: {
    titleKey: 'gateScoreBreakdownTitle',
    benefitKeys: ['gateBenefitScoreSubScores', 'gateBenefitScoreFormula', 'gateBenefitScorePeerCompare'],
  },
  advancedFilters: {
    titleKey: 'gateAdvancedFiltersTitle',
    benefitKeys: ['gateBenefitFilters150Plus', 'gateBenefitFiltersSaved', 'gateBenefitFiltersCombo'],
  },
  historicalData: {
    titleKey: 'gateHistoricalDataTitle',
    benefitKeys: ['gateBenefitHistoryFullDepth', 'gateBenefitHistoryEquityCurves', 'gateBenefitHistoryDailyRollups'],
  },
  unlimitedWatchlist: {
    titleKey: 'gateUnlimitedWatchlistTitle',
    benefitKeys: ['gateBenefitWatchlistUnlimited', 'gateBenefitWatchlistAlerts', 'gateBenefitWatchlistFolders'],
  },
}

interface PremiumGateProps {
  children: ReactNode
  isPro: boolean
  isLoggedIn?: boolean
  blurAmount?: number
  featureName?: string
  /**
   * Contextual benefit key — when set, the gate shows a title +
   * 3 bullet benefits instead of a generic lock message. Strongly
   * preferred over `featureName` for new gates because it converts
   * better (audit P1-PROD-1 estimated +10-15% conversion impact).
   */
  featureKey?: FeatureBenefitKey
  customMessage?: string
  showUpgradeButton?: boolean
  lockOnly?: boolean
  minHeight?: number | string
}

export default function PremiumGate({
  children,
  isPro,
  isLoggedIn = true,
  blurAmount = 8,
  featureName,
  featureKey,
  customMessage,
  showUpgradeButton = true,
  lockOnly = false,
  minHeight,
}: PremiumGateProps) {
  const { t } = useLanguage()

  if (isPro) {
    return <>{children}</>
  }

  const loginMessage = t('loginToView')
  // Resolve copy in priority order:
  //   1. customMessage (caller-supplied raw string)
  //   2. featureKey (contextual title + benefits — preferred)
  //   3. featureName (legacy "Feature - Pro required" formatting)
  //   4. generic "Pro required"
  const benefitsConfig = featureKey ? FEATURE_BENEFITS[featureKey] : null
  const titleFromKey = benefitsConfig ? t(benefitsConfig.titleKey) : null
  const proMessage =
    customMessage ||
    titleFromKey ||
    (featureName ? `${featureName} - ${t('proRequired')}` : t('proRequired'))
  const message = !isLoggedIn ? loginMessage : proMessage

  return (
    <Box style={{ position: 'relative', minHeight: minHeight || 'auto' }}>
      {/* 模糊内容 */}
      <Box
        style={{
          filter: lockOnly ? 'none' : `blur(${blurAmount}px)`,
          opacity: lockOnly ? 1 : 0.5,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {children}
      </Box>

      {/* 遮罩层 */}
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[4],
          background: 'var(--color-blur-overlay)',
          backdropFilter: tokens.glass.blur.xs,
          WebkitBackdropFilter: tokens.glass.blur.xs,
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[6],
          textAlign: 'center',
        }}
      >
        {/* 锁定图标 */}
        <Box
          style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.xl,
            background: 'var(--color-pro-glow)',
            border: '1px solid var(--color-pro-gradient-start)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 32px var(--color-pro-badge-shadow)',
          }}
        >
          <LockIcon size={28} color="var(--color-pro-gradient-start)" />
        </Box>

        {/* 提示文字 */}
        <Box>
          <Text size="md" weight="bold" style={{ color: 'var(--color-text-primary)', marginBottom: tokens.spacing[1] }}>
            {message}
          </Text>
          {isLoggedIn && benefitsConfig && (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: `${tokens.spacing[2]} 0 0`,
                display: 'flex',
                flexDirection: 'column',
                gap: tokens.spacing[1],
                alignItems: 'flex-start',
                textAlign: 'left',
              }}
            >
              {benefitsConfig.benefitKeys.map((bk) => (
                <li key={bk} style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                  <span aria-hidden="true" style={{ color: 'var(--color-pro-gradient-start)', lineHeight: 1.4 }}>✓</span>
                  <Text size="sm" color="secondary">{t(bk)}</Text>
                </li>
              ))}
            </ul>
          )}
          {isLoggedIn && !benefitsConfig && (
            <Text size="sm" color="tertiary">
              {t('unlockProFeatures')}
            </Text>
          )}
        </Box>

        {/* 操作按钮 */}
        {showUpgradeButton && (
          <Link href={isLoggedIn ? '/pricing' : '/login'} style={{ textDecoration: 'none' }}>
            <Button
              variant="primary"
              style={{
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                boxShadow: '0 4px 16px var(--color-pro-badge-shadow)',
              }}
            >
              {isLoggedIn ? t('upgradeToPro') : t('login')}
            </Button>
          </Link>
        )}
      </Box>
    </Box>
  )
}

/**
 * 简化版模糊遮罩
 */
export function PremiumBlur({ 
  children, 
  isPro,
}: { 
  children: ReactNode
  isPro: boolean
}) {
  if (isPro) return <>{children}</>

  return (
    <Box style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <Box style={{ filter: 'blur(6px)', opacity: 0.4, pointerEvents: 'none' }}>
        {children}
      </Box>
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <LockIcon size={14} color="var(--color-text-tertiary)" />
      </Box>
    </Box>
  )
}

/**
 * Pro 标签
 */
export function ProLabel({ size = 'sm' }: { size?: 'xs' | 'sm' | 'md' }) {
  const sizeMap = {
    xs: { fontSize: 10, padding: '2px 6px', iconSize: 8, gap: 3 },
    sm: { fontSize: 10, padding: '3px 8px', iconSize: 10, gap: 4 },
    md: { fontSize: 11, padding: '4px 10px', iconSize: 11, gap: 4 },
  }

  const styles = sizeMap[size]

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: styles.gap,
        padding: styles.padding,
        borderRadius: tokens.radius.full,
        background: 'var(--color-pro-badge-bg)',
        boxShadow: '0 2px 8px var(--color-pro-badge-shadow)',
      }}
    >
      <StarIcon size={styles.iconSize} color="var(--color-on-accent)" />
      <span
        style={{
          fontSize: styles.fontSize,
          fontWeight: 700,
          color: tokens.colors.white,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
        }}
      >
        PRO
      </span>
    </Box>
  )
}
