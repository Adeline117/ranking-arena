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
const StarIcon = ({ size = 12, color = '#fff' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

interface PremiumGateProps {
  children: ReactNode
  isPro: boolean
  isLoggedIn?: boolean
  blurAmount?: number
  featureName?: string
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
  customMessage,
  showUpgradeButton = true,
  lockOnly = false,
  minHeight,
}: PremiumGateProps) {
  const { language, t } = useLanguage()

  if (isPro) {
    return <>{children}</>
  }

  const loginMessage = t('pleaseLogin')

  const proMessage = customMessage || (
    featureName
      ? `${featureName} · ${t('proOnly')}`
      : t('proOnly')
  )

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
          backdropFilter: 'blur(4px)',
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
          {isLoggedIn && (
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
    xs: { fontSize: 9, padding: '2px 6px', iconSize: 8, gap: 3 },
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
      <StarIcon size={styles.iconSize} color="#fff" />
      <span
        style={{
          fontSize: styles.fontSize,
          fontWeight: 700,
          color: '#fff',
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
        }}
      >
        PRO
      </span>
    </Box>
  )
}
