'use client'

import { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
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
  const { language } = useLanguage()

  // 计算时间差
  const { ageText, isStale, isCritical } = useMemo(() => {
    if (!lastUpdated) {
      return { ageText: null, isStale: false, isCritical: false }
    }

    const date = typeof lastUpdated === 'string' ? new Date(lastUpdated) : lastUpdated
    const now = Date.now()
    const diffMs = now - date.getTime()
    const diffMinutes = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)

    let ageText: string
    if (diffMinutes < 1) {
      ageText = language === 'zh' ? '刚刚' : 'just now'
    } else if (diffMinutes < 60) {
      ageText = language === 'zh' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
    } else if (diffHours < 24) {
      ageText = language === 'zh' ? `${diffHours}小时前` : `${diffHours}h ago`
    } else {
      const diffDays = Math.floor(diffHours / 24)
      ageText = language === 'zh' ? `${diffDays}天前` : `${diffDays}d ago`
    }

    // 6小时以上为 stale，24小时以上为 critical
    const isStale = diffHours >= 6
    const isCritical = diffHours >= 24

    return { ageText, isStale, isCritical }
  }, [lastUpdated, language])

  // 更新层级对应的描述
  const tierInfo = useMemo(() => {
    switch (updateTier) {
      case 'realtime':
        return {
          label: language === 'zh' ? '实时' : 'Real-time',
          interval: language === 'zh' ? '15分钟' : '15min',
          color: tokens.colors.accent.success,
          icon: <RealtimeIcon size={size === 'sm' ? 10 : 12} />,
        }
      case 'delayed':
        return {
          label: language === 'zh' ? '延迟' : 'Delayed',
          interval: language === 'zh' ? '4小时+' : '4h+',
          color: tokens.colors.accent.warning,
          icon: <ClockIcon size={size === 'sm' ? 10 : 12} />,
        }
      default:
        return {
          label: language === 'zh' ? '标准' : 'Standard',
          interval: language === 'zh' ? '4小时' : '4h',
          color: tokens.colors.text.tertiary,
          icon: <ClockIcon size={size === 'sm' ? 10 : 12} />,
        }
    }
  }, [updateTier, language, size])

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
          {language === 'zh' ? '更新于 ' : 'Updated '}{ageText}
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
          {language === 'zh' ? '数据可能过时' : 'Data may be stale'}
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
  const { language } = useLanguage()

  const config = {
    realtime: {
      label: language === 'zh' ? '实时' : 'Live',
      color: tokens.colors.accent.success,
    },
    standard: {
      label: language === 'zh' ? '4h' : '4h',
      color: tokens.colors.text.tertiary,
    },
    delayed: {
      label: language === 'zh' ? '延迟' : 'Delayed',
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
