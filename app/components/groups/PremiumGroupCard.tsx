'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../utils/LanguageProvider'

interface PremiumGroupCardProps {
  groupId: string
  groupName: string
  description?: string
  avatarUrl?: string
  memberCount?: number
  priceMonthly: number
  priceYearly: number
  originalPriceMonthly?: number
  originalPriceYearly?: number
  isSubscribed?: boolean
  subscriptionTier?: 'monthly' | 'yearly' | 'trial'
  expiresAt?: string
  onSubscribe?: (tier: 'monthly' | 'yearly') => void
  onManage?: () => void
}

// 星星图标
const StarIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

// 勾选图标
const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function formatPrice(price: number): string {
  return `$${price.toFixed(price % 1 === 0 ? 0 : 2)}`
}

export default function PremiumGroupCard({
  groupId,
  groupName,
  description,
  avatarUrl,
  memberCount = 0,
  priceMonthly,
  priceYearly,
  originalPriceMonthly,
  originalPriceYearly,
  isSubscribed = false,
  subscriptionTier,
  expiresAt,
  onSubscribe,
  onManage,
}: PremiumGroupCardProps) {
  const { language, t } = useLanguage()
  const [selectedTier, setSelectedTier] = useState<'monthly' | 'yearly'>('yearly')
  const [hoveredTier, setHoveredTier] = useState<'monthly' | 'yearly' | null>(null)

  const monthlyDiscount = originalPriceMonthly 
    ? Math.round((1 - priceMonthly / originalPriceMonthly) * 100)
    : 0
  const yearlySavings = Math.round((1 - (priceYearly / 12) / priceMonthly) * 100)

  return (
    <Box
      style={{
        background: `linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-bg-tertiary) 100%)`,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-pro-glow)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Pro 标签 */}
      <Box
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          padding: '4px 10px',
          borderRadius: tokens.radius.full,
          background: 'var(--color-pro-badge-bg)',
          boxShadow: '0 2px 8px var(--color-pro-badge-shadow)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <StarIcon size={10} />
        <Text size="xs" weight="bold" style={{ color: '#fff' }}>
          {t('proExclusive')}
        </Text>
      </Box>

      {/* 群组信息 */}
      <Box style={{ padding: tokens.spacing[5] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
          <Box
            style={{
              width: 56,
              height: 56,
              borderRadius: tokens.radius.lg,
              background: avatarUrl 
                ? `url(${avatarUrl}) center/cover`
                : 'var(--color-pro-glow)',
              border: '2px solid var(--color-border-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {!avatarUrl && (
              <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                {groupName.charAt(0).toUpperCase()}
              </Text>
            )}
          </Box>
          
          <Box style={{ flex: 1 }}>
            <Text size="lg" weight="bold">{groupName}</Text>
            <Text size="xs" color="tertiary">
              {memberCount} {t('members')}
            </Text>
          </Box>
        </Box>

        {description && (
          <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4], lineHeight: 1.5 }}>
            {description}
          </Text>
        )}

        {/* 已订阅状态 */}
        {isSubscribed ? (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: 'var(--color-accent-success)10',
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-accent-success)25',
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Box style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Box style={{ color: 'var(--color-accent-success)' }}>
                    <CheckIcon size={16} />
                  </Box>
                  <Text size="sm" weight="bold" style={{ color: 'var(--color-accent-success)' }}>
                    {t('subscribed')}
                  </Text>
                </Box>
                <Text size="xs" color="tertiary">
                  {subscriptionTier === 'yearly' 
                    ? t('yearlyPlan') 
                    : subscriptionTier === 'trial' 
                      ? (language === 'en' ? 'Trial' : '试用中')
                      : t('monthlyPlan')
                  }
                  {expiresAt && ` · ${language === 'en' ? 'Expires:' : '到期：'}${new Date(expiresAt).toLocaleDateString()}`}
                </Text>
              </Box>
              {onManage && (
                <Button variant="secondary" size="sm" onClick={onManage}>
                  {language === 'en' ? 'Manage' : '管理订阅'}
                </Button>
              )}
            </Box>
          </Box>
        ) : (
          <>
            {/* 价格选项 */}
            <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
              {/* 月付 */}
              <Box
                onClick={() => setSelectedTier('monthly')}
                onMouseEnter={() => setHoveredTier('monthly')}
                onMouseLeave={() => setHoveredTier(null)}
                style={{
                  flex: 1,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.lg,
                  border: `2px solid ${selectedTier === 'monthly' ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
                  background: selectedTier === 'monthly' ? 'var(--color-pro-glow)' : 'transparent',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  transform: hoveredTier === 'monthly' ? 'translateY(-2px)' : 'none',
                }}
              >
                <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{t('monthlyPrice')}</Text>
                <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  {originalPriceMonthly && originalPriceMonthly > priceMonthly && (
                    <Text size="xs" style={{ textDecoration: 'line-through', color: 'var(--color-text-quaternary)' }}>
                      {formatPrice(originalPriceMonthly)}
                    </Text>
                  )}
                  <Text size="lg" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                    {formatPrice(priceMonthly)}
                  </Text>
                  <Text size="xs" color="tertiary">{t('perMonth')}</Text>
                </Box>
              </Box>

              {/* 年付 */}
              <Box
                onClick={() => setSelectedTier('yearly')}
                onMouseEnter={() => setHoveredTier('yearly')}
                onMouseLeave={() => setHoveredTier(null)}
                style={{
                  flex: 1,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.lg,
                  border: `2px solid ${selectedTier === 'yearly' ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
                  background: selectedTier === 'yearly' ? 'var(--color-pro-glow)' : 'transparent',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  transform: hoveredTier === 'yearly' ? 'translateY(-2px)' : 'none',
                  position: 'relative',
                }}
              >
                {/* 推荐标签 */}
                <Box
                  style={{
                    position: 'absolute',
                    top: -10,
                    right: 8,
                    padding: '2px 8px',
                    borderRadius: tokens.radius.full,
                    background: 'var(--color-accent-success)',
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#fff',
                  }}
                >
                  {language === 'en' ? `Save ${yearlySavings}%` : `省 ${yearlySavings}%`}
                </Box>

                <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{t('yearlyPrice')}</Text>
                <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  {originalPriceYearly && originalPriceYearly > priceYearly && (
                    <Text size="xs" style={{ textDecoration: 'line-through', color: 'var(--color-text-quaternary)' }}>
                      {formatPrice(originalPriceYearly)}
                    </Text>
                  )}
                  <Text size="lg" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                    {formatPrice(priceYearly)}
                  </Text>
                  <Text size="xs" color="tertiary">{t('perYear')}</Text>
                </Box>
                <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                  {language === 'en' 
                    ? `~${formatPrice(priceYearly / 12)}/month`
                    : `相当于 ${formatPrice(priceYearly / 12)}/月`
                  }
                </Text>
              </Box>
            </Box>

            {/* 订阅按钮 */}
            <Button
              variant="primary"
              style={{
                width: '100%',
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
              }}
              onClick={() => onSubscribe?.(selectedTier)}
            >
              {t('subscribe')} {selectedTier === 'yearly' ? t('yearlyPlan') : t('monthlyPlan')}
            </Button>
          </>
        )}
      </Box>
    </Box>
  )
}
