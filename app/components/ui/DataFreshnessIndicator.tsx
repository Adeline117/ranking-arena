'use client'

import { useMemo, useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// 时钟图标
const ClockIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
)

// 实时图标（闪电）
const RealtimeIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
)

export type UpdateTier = 'realtime' | 'standard' | 'delayed'

interface DataFreshnessIndicatorProps {
  /** 最后更新时间 */
  lastUpdated?: Date | string | null
  /** 更新频率层级 */
  updateTier?: UpdateTier
  /** 是否显示完整信息 */
  showDetails?: boolean
  /** 尺寸 */
  size?: 'sm' | 'md'
}

/**
 * 数据新鲜度指示器
 * 显示数据的更新时间和更新频率
 */
export default function DataFreshnessIndicator({
  lastUpdated,
  updateTier = 'standard',
  showDetails = true,
  size = 'sm',
}: DataFreshnessIndicatorProps) {
  const { language, t } = useLanguage()

  // 计算时间差 - use useState + useEffect to avoid hydration mismatch
  // Date.now() differs between server and client, so defer to client-only
  const [freshnessState, setFreshnessState] = useState<{
    ageText: string | null
    isStale: boolean
    isCritical: boolean
  }>({ ageText: null, isStale: false, isCritical: false })

  useEffect(() => {
    if (!lastUpdated) {
      setFreshnessState({ ageText: null, isStale: false, isCritical: false })
      return
    }

    const computeFreshness = () => {
      const date = typeof lastUpdated === 'string' ? new Date(lastUpdated) : lastUpdated
      const now = Date.now()
      const diffMs = now - date.getTime()
      const diffMinutes = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)

      let ageText: string
      if (diffMinutes < 1) {
        ageText = t('justNow')
      } else if (diffMinutes < 60) {
        ageText = t('minutesAgoShort').replace('{n}', String(diffMinutes))
      } else if (diffHours < 24) {
        ageText = t('hoursAgoShort').replace('{n}', String(diffHours))
      } else {
        const diffDays = Math.floor(diffHours / 24)
        ageText = t('daysAgoShort').replace('{n}', String(diffDays))
      }

      // 6小时以上为 stale，24小时以上为 critical
      const isStale = diffHours >= 6
      const isCritical = diffHours >= 24

      setFreshnessState({ ageText, isStale, isCritical })
    }

    computeFreshness()
    // Refresh freshness every 60 seconds
    const interval = setInterval(computeFreshness, 60000)
    return () => clearInterval(interval)
  }, [lastUpdated, language, t])

  const { ageText, isStale, isCritical } = freshnessState

  // 更新层级对应的描述
  const tierInfo = useMemo(() => {
    switch (updateTier) {
      case 'realtime':
        return {
          label: t('realtime'),
          interval: t('interval15min'),
          color: tokens.colors.accent.success,
          icon: <RealtimeIcon size={size === 'sm' ? 10 : 12} />,
        }
      case 'delayed':
        return {
          label: t('delayed'),
          interval: t('interval4hPlus'),
          color: tokens.colors.accent.warning,
          icon: <ClockIcon size={size === 'sm' ? 10 : 12} />,
        }
      default:
        return {
          label: t('standard'),
          interval: t('interval4h'),
          color: tokens.colors.text.tertiary,
          icon: <ClockIcon size={size === 'sm' ? 10 : 12} />,
        }
    }
  }, [updateTier, size, t])

  // 确定显示颜色
  const displayColor = isCritical
    ? tokens.colors.accent.error
    : isStale
      ? tokens.colors.accent.warning
      : tierInfo.color

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        flexWrap: 'wrap',
      }}
    >
      {/* 更新层级徽章 */}
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: size === 'sm' ? '2px 6px' : '3px 8px',
          borderRadius: tokens.radius.full,
          background: `${tierInfo.color}15`,
          border: `1px solid ${tierInfo.color}30`,
        }}
      >
        <Box style={{ color: tierInfo.color, display: 'flex', alignItems: 'center' }}>
          {tierInfo.icon}
        </Box>
        <Text
          size="xs"
          weight="bold"
          style={{
            color: tierInfo.color,
            fontSize: size === 'sm' ? '10px' : '11px',
            lineHeight: 1,
          }}
        >
          {tierInfo.label}
        </Text>
      </Box>

      {/* 更新时间 */}
      {showDetails && ageText && (
        <Text
          size="xs"
          style={{
            color: displayColor,
            fontSize: size === 'sm' ? '10px' : '11px',
          }}
        >
          {t('updatedAgo')}{ageText}
        </Text>
      )}

      {/* 警告提示 */}
      {isCritical && showDetails && (
        <Text
          size="xs"
          weight="bold"
          style={{
            color: tokens.colors.accent.error,
            fontSize: size === 'sm' ? '10px' : '11px',
          }}
        >
          {t('dataMayBeStale')}
        </Text>
      )}
    </Box>
  )
}

/**
 * 更新层级徽章（简化版）
 * 用于表格行内显示
 */
export function UpdateTierBadge({
  tier,
  size = 'sm'
}: {
  tier: UpdateTier
  size?: 'xs' | 'sm'
}) {
  const { t } = useLanguage()

  const config = {
    realtime: {
      label: t('live'),
      color: tokens.colors.accent.success,
    },
    standard: {
      label: '4h',
      color: tokens.colors.text.tertiary,
    },
    delayed: {
      label: t('delayed'),
      color: tokens.colors.accent.warning,
    },
  }

  const { label, color } = config[tier]

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: size === 'xs' ? '1px 4px' : '2px 6px',
        borderRadius: tokens.radius.sm,
        background: `${color}15`,
        border: `1px solid ${color}30`,
      }}
    >
      <Text
        size="xs"
        weight="semibold"
        style={{
          color,
          fontSize: size === 'xs' ? '9px' : '10px',
          lineHeight: 1,
        }}
      >
        {label}
      </Text>
    </Box>
  )
}
