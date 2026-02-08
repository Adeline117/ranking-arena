'use client'

/**
 * 会员徽章组件
 * 显示用户的订阅等级标识
 */

import React from 'react'
import { Box } from '../base'
import { tokens } from '@/lib/design-tokens'
import { type SubscriptionTier } from '@/lib/premium'
import { usePremium } from '@/lib/premium/hooks'
import { useLanguage } from '../Providers/LanguageProvider'

// ============================================
// 类型定义
// ============================================

interface PremiumBadgeProps {
  /** 指定显示的等级（不指定则使用当前用户等级） */
  tier?: SubscriptionTier
  /** 尺寸 */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** 是否显示文字 */
  showLabel?: boolean
  /** 是否仅显示图标 */
  iconOnly?: boolean
  /** 自定义类名 */
  className?: string
  /** 自定义样式 */
  style?: React.CSSProperties
}

// ============================================
// 常量
// ============================================

const getTierLabel = (tier: SubscriptionTier, t: (key: string) => string): string => {
  if (tier === 'free') return t('free')
  return 'Pro'
}

const TIER_CONFIG: Record<SubscriptionTier, {
  icon: string
  color: string
  bgColor: string
  borderColor: string
}> = {
  free: {
    icon: '',
    color: tokens.colors.text.secondary,
    bgColor: tokens.colors.bg.tertiary,
    borderColor: tokens.colors.border.secondary,
  },
  pro: {
    icon: '',
    color: tokens.colors.accent.warning,
    bgColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
}

const SIZE_CONFIG = {
  xs: {
    padding: '2px 6px',
    fontSize: '10px',
    iconSize: '12px',
    gap: '2px',
    borderRadius: '4px',
  },
  sm: {
    padding: '3px 8px',
    fontSize: '12px',
    iconSize: '14px',
    gap: '4px',
    borderRadius: '6px',
  },
  md: {
    padding: '4px 10px',
    fontSize: '13px',
    iconSize: '16px',
    gap: '5px',
    borderRadius: '8px',
  },
  lg: {
    padding: '6px 12px',
    fontSize: '14px',
    iconSize: '18px',
    gap: '6px',
    borderRadius: '10px',
  },
}

// ============================================
// 组件
// ============================================

export function PremiumBadge({
  tier: tierProp,
  size = 'sm',
  showLabel = true,
  iconOnly = false,
  className,
  style,
}: PremiumBadgeProps) {
  const { t } = useLanguage()
  const { tier: currentTier, isLoading } = usePremium()
  const tier = tierProp || currentTier

  // 加载中不显示
  if (isLoading && !tierProp) {
    return null
  }

  // 免费用户默认不显示徽章
  if (tier === 'free' && !tierProp) {
    return null
  }

  const config = TIER_CONFIG[tier]
  const sizeConfig = SIZE_CONFIG[size]
  const tierLabel = getTierLabel(tier, t)
  const memberLabel = t('member')

  if (iconOnly) {
    return (
      <Box
        as="span"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: sizeConfig.iconSize,
          height: sizeConfig.iconSize,
          fontSize: sizeConfig.iconSize,
          ...style,
        }}
        className={className}
        title={tierLabel}
        aria-label={`${tierLabel} ${memberLabel}`}
      >
        {config.icon}
      </Box>
    )
  }

  return (
    <Box
      as="span"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: sizeConfig.gap,
        padding: sizeConfig.padding,
        backgroundColor: config.bgColor,
        border: `1px solid ${config.borderColor}`,
        borderRadius: sizeConfig.borderRadius,
        color: config.color,
        fontSize: sizeConfig.fontSize,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
      className={className}
      aria-label={`${tierLabel} ${memberLabel}`}
    >
      <span style={{ fontSize: sizeConfig.iconSize }}>{config.icon}</span>
      {showLabel && <span>{tierLabel}</span>}
    </Box>
  )
}

// ============================================
// 变体组件
// ============================================

/**
 * Pro 徽章
 */
export function ProBadge(props: Omit<PremiumBadgeProps, 'tier'>) {
  return <PremiumBadge tier="pro" {...props} />
}

/**
 * 当前用户徽章（自动获取等级）
 */
export function UserPremiumBadge(props: Omit<PremiumBadgeProps, 'tier'>) {
  return <PremiumBadge {...props} />
}

// ============================================
// 功能标签
// ============================================

interface FeatureTagProps {
  /** 需要的等级 */
  tier: SubscriptionTier
  /** 尺寸 */
  size?: 'xs' | 'sm'
  /** 自定义样式 */
  style?: React.CSSProperties
}

/**
 * 功能所需等级标签
 * 用于在功能旁边标记需要的订阅等级
 */
export function FeatureTag({ tier, size = 'xs', style }: FeatureTagProps) {
  const { t } = useLanguage()
  if (tier === 'free') return null

  const config = TIER_CONFIG[tier]
  const sizeConfig = SIZE_CONFIG[size]
  const tierLabel = getTierLabel(tier, t)

  return (
    <Box
      as="span"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        padding: size === 'xs' ? '1px 4px' : '2px 6px',
        backgroundColor: config.bgColor,
        borderRadius: sizeConfig.borderRadius,
        color: config.color,
        fontSize: size === 'xs' ? '9px' : '10px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        ...style,
      }}
    >
      {config.icon} {tierLabel}
    </Box>
  )
}

// ============================================
// 导出
// ============================================

export type { PremiumBadgeProps, FeatureTagProps }
