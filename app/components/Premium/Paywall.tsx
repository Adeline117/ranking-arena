'use client'

/**
 * 付费墙组件
 * 限制付费功能访问，引导用户升级
 */

import React from 'react'
import { Box, Text, Button } from '../Base'
import { tokens } from '@/lib/design-tokens'
import {
  type PremiumFeatureId,
  type SubscriptionTier,
  SUBSCRIPTION_PLANS,
  getFeature,
} from '@/lib/premium'
import { useFeatureAccess, usePremium } from '@/lib/premium/hooks'

// ============================================
// 类型定义
// ============================================

interface PaywallProps {
  /** 需要的功能 ID */
  feature?: PremiumFeatureId
  /** 需要的最低等级 */
  tier?: SubscriptionTier
  /** 标题 */
  title?: string
  /** 描述 */
  description?: string
  /** 子内容（被遮挡的内容） */
  children?: React.ReactNode
  /** 布局模式 */
  variant?: 'inline' | 'overlay' | 'card' | 'banner'
  /** 是否显示价格 */
  showPricing?: boolean
  /** 升级按钮文案 */
  upgradeText?: string
  /** 升级按钮点击 */
  onUpgradeClick?: () => void
}

// ============================================
// 主组件
// ============================================

export function Paywall({
  feature,
  tier,
  title,
  description,
  children,
  variant = 'card',
  showPricing = true,
  upgradeText = '升级解锁',
  onUpgradeClick,
}: PaywallProps) {
  const { tier: currentTier } = usePremium()
  const featureAccess = feature ? useFeatureAccess(feature) : null

  // 检查是否需要显示付费墙
  let shouldShowPaywall = false
  let requiredTier: SubscriptionTier = 'pro'
  let featureInfo = feature ? getFeature(feature) : null

  if (feature && featureAccess) {
    shouldShowPaywall = !featureAccess.hasAccess || featureAccess.isLimitReached
    requiredTier = featureInfo?.tier[0] || 'pro'
  } else if (tier) {
    const tierOrder: SubscriptionTier[] = ['free', 'pro', 'elite', 'enterprise']
    shouldShowPaywall = tierOrder.indexOf(currentTier) < tierOrder.indexOf(tier)
    requiredTier = tier
  }

  if (!shouldShowPaywall) {
    return <>{children}</>
  }

  // 获取目标计划
  const targetPlan = SUBSCRIPTION_PLANS.find(p => p.id === requiredTier)

  // 默认文案
  const defaultTitle = featureInfo?.name 
    ? `解锁「${featureInfo.name}」` 
    : '升级获取更多功能'
  const defaultDescription = featureAccess?.message || featureAccess?.upgradeMessage || featureInfo?.description || '升级您的订阅以访问此功能'

  const handleUpgrade = () => {
    if (onUpgradeClick) {
      onUpgradeClick()
    } else {
      // 默认跳转到订阅页面
      window.location.href = '/settings?tab=subscription'
    }
  }

  // 根据变体渲染
  switch (variant) {
    case 'overlay':
      return (
        <OverlayPaywall
          title={title || defaultTitle}
          description={description || defaultDescription}
          targetPlan={targetPlan}
          showPricing={showPricing}
          upgradeText={upgradeText}
          onUpgrade={handleUpgrade}
          featureIcon={featureInfo?.icon}
        >
          {children}
        </OverlayPaywall>
      )
    case 'inline':
      return (
        <InlinePaywall
          title={title || defaultTitle}
          description={description || defaultDescription}
          upgradeText={upgradeText}
          onUpgrade={handleUpgrade}
        />
      )
    case 'banner':
      return (
        <BannerPaywall
          title={title || defaultTitle}
          description={description || defaultDescription}
          upgradeText={upgradeText}
          onUpgrade={handleUpgrade}
        />
      )
    case 'card':
    default:
      return (
        <CardPaywall
          title={title || defaultTitle}
          description={description || defaultDescription}
          targetPlan={targetPlan}
          showPricing={showPricing}
          upgradeText={upgradeText}
          onUpgrade={handleUpgrade}
          featureIcon={featureInfo?.icon}
        />
      )
  }
}

// ============================================
// 变体组件
// ============================================

interface PaywallContentProps {
  title: string
  description: string
  targetPlan?: typeof SUBSCRIPTION_PLANS[0]
  showPricing?: boolean
  upgradeText: string
  onUpgrade: () => void
  featureIcon?: string
  children?: React.ReactNode
}

/**
 * 卡片式付费墙
 */
function CardPaywall({
  title,
  description,
  targetPlan,
  showPricing,
  upgradeText,
  onUpgrade,
  featureIcon,
}: PaywallContentProps) {
  return (
    <Box
      style={{
        padding: tokens.spacing[6],
        backgroundColor: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.secondary}`,
        textAlign: 'center',
        maxWidth: '400px',
        margin: '0 auto',
      }}
    >
      {/* 图标 */}
      <Box
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255, 193, 7, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
          marginBottom: tokens.spacing[4],
          fontSize: '28px',
        }}
      >
        {featureIcon || '⭐'}
      </Box>

      {/* 标题 */}
      <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>

      {/* 描述 */}
      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
        {description}
      </Text>

      {/* 价格 */}
      {showPricing && targetPlan && targetPlan.price.monthly > 0 && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="2xl" weight="bold" style={{ color: tokens.colors.accent.primary }}>
            ${targetPlan.price.monthly}
          </Text>
          <Text size="sm" color="tertiary">/月</Text>
          {targetPlan.price.yearly > 0 && (
            <Text size="xs" color="tertiary" style={{ display: 'block', marginTop: tokens.spacing[1] }}>
              年付 ${targetPlan.price.yearly}/年（省 {Math.round((1 - targetPlan.price.yearly / (targetPlan.price.monthly * 12)) * 100)}%）
            </Text>
          )}
        </Box>
      )}

      {/* 升级按钮 */}
      <Button variant="primary" size="lg" onClick={onUpgrade} style={{ width: '100%' }}>
        {upgradeText}
      </Button>
    </Box>
  )
}

/**
 * 遮罩式付费墙
 */
function OverlayPaywall({
  title,
  description,
  targetPlan,
  showPricing,
  upgradeText,
  onUpgrade,
  featureIcon,
  children,
}: PaywallContentProps) {
  return (
    <Box style={{ position: 'relative' }}>
      {/* 被遮罩的内容 */}
      <Box
        style={{
          filter: 'blur(4px)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
        aria-hidden="true"
      >
        {children}
      </Box>

      {/* 遮罩层 */}
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(2px)',
          borderRadius: tokens.radius.lg,
        }}
      >
        <CardPaywall
          title={title}
          description={description}
          targetPlan={targetPlan}
          showPricing={showPricing}
          upgradeText={upgradeText}
          onUpgrade={onUpgrade}
          featureIcon={featureIcon}
        />
      </Box>
    </Box>
  )
}

/**
 * 内联式付费墙
 */
function InlinePaywall({
  title,
  description,
  upgradeText,
  onUpgrade,
}: PaywallContentProps) {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: tokens.spacing[3],
        backgroundColor: 'rgba(255, 193, 7, 0.1)',
        borderRadius: tokens.radius.md,
        gap: tokens.spacing[3],
      }}
    >
      <Box>
        <Text size="sm" weight="medium">{title}</Text>
        <Text size="xs" color="secondary">{description}</Text>
      </Box>
      <Button variant="primary" size="sm" onClick={onUpgrade}>
        {upgradeText}
      </Button>
    </Box>
  )
}

/**
 * 横幅式付费墙
 */
function BannerPaywall({
  title,
  description,
  upgradeText,
  onUpgrade,
}: PaywallContentProps) {
  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: `linear-gradient(135deg, ${tokens.colors.accent.primary}20 0%, ${tokens.colors.accent.brand}20 100%)`,
        borderLeft: `4px solid ${tokens.colors.accent.primary}`,
        borderRadius: tokens.radius.md,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacing[3],
      }}
    >
      <Box>
        <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
          ⭐ {title}
        </Text>
        <Text size="sm" color="secondary">{description}</Text>
      </Box>
      <Button variant="primary" size="md" onClick={onUpgrade}>
        {upgradeText}
      </Button>
    </Box>
  )
}

// ============================================
// 导出
// ============================================

export type { PaywallProps }
