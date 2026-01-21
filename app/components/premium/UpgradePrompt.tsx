'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// 图标组件
const LockIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3ZM12 13C13.1 13 14 13.9 14 15C14 16.1 13.1 17 12 17C10.9 17 10 16.1 10 15C10 13.9 10.9 13 12 13Z" />
  </svg>
)

const StarIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

interface UpgradePromptProps {
  /** 功能名称 */
  featureName?: string
  /** 功能描述 */
  featureDescription?: string
  /** 显示样式: inline(行内提示), card(卡片), overlay(覆盖层) */
  variant?: 'inline' | 'card' | 'overlay'
  /** 是否显示图标 */
  showIcon?: boolean
  /** 自定义按钮文字 */
  buttonText?: string
  /** 自定义跳转地址 */
  href?: string
  /** 点击回调 */
  onClick?: () => void
  /** 自定义样式 */
  style?: React.CSSProperties
}

/**
 * 统一的 Pro 会员升级提示组件
 * 用于在各处显示一致的升级提示
 */
export default function UpgradePrompt({
  featureName,
  featureDescription,
  variant = 'inline',
  showIcon = true,
  buttonText,
  href = '/pricing',
  onClick,
  style,
}: UpgradePromptProps) {
  const router = useRouter()
  const { t } = useLanguage()

  const defaultButtonText = t('upgradeToPro')
  const finalButtonText = buttonText || defaultButtonText

  const handleClick = () => {
    if (onClick) {
      onClick()
    }
    router.push(href)
  }

  // 行内样式
  if (variant === 'inline') {
    return (
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
          background: 'var(--color-pro-badge-bg, linear-gradient(135deg, #8b6fa8 0%, #a78bba 100%))',
          borderRadius: tokens.radius.full,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          ...style,
        }}
        onClick={handleClick}
      >
        {showIcon && <LockIcon size={12} />}
        <Text size="xs" weight="bold" style={{ color: '#fff' }}>
          Pro
        </Text>
      </Box>
    )
  }

  // 卡片样式
  if (variant === 'card') {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          border: '1px solid var(--color-border-primary)',
          textAlign: 'center',
          ...style,
        }}
      >
        {showIcon && (
          <Box
            style={{
              width: 48,
              height: 48,
              margin: '0 auto',
              marginBottom: tokens.spacing[3],
              borderRadius: '50%',
              background: 'var(--color-pro-glow, rgba(139, 111, 168, 0.15))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-pro-text, #c9b8db)',
            }}
          >
            <StarIcon size={24} />
          </Box>
        )}
        
        {featureName && (
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {featureName}
          </Text>
        )}
        
        {featureDescription && (
          <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
            {featureDescription}
          </Text>
        )}
        
        <Link href={href} style={{ textDecoration: 'none' }}>
          <Button
            variant="primary"
            onClick={onClick}
            style={{
              width: '100%',
              background: 'var(--color-pro-badge-bg, linear-gradient(135deg, #8b6fa8 0%, #a78bba 100%))',
              border: 'none',
              boxShadow: '0 4px 12px var(--color-pro-badge-shadow, rgba(139, 111, 168, 0.3))',
            }}
          >
            {finalButtonText}
          </Button>
        </Link>
      </Box>
    )
  }

  // 覆盖层样式
  return (
    <Box
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-blur-overlay, rgba(10, 10, 12, 0.85))',
        backdropFilter: 'blur(8px)',
        borderRadius: tokens.radius.lg,
        zIndex: 10,
        ...style,
      }}
    >
      {showIcon && (
        <Box
          style={{
            width: 56,
            height: 56,
            marginBottom: tokens.spacing[3],
            borderRadius: '50%',
            background: 'var(--color-pro-glow, rgba(139, 111, 168, 0.15))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-pro-text, #c9b8db)',
            boxShadow: '0 0 30px var(--color-pro-glow, rgba(139, 111, 168, 0.3))',
          }}
        >
          <LockIcon size={28} />
        </Box>
      )}
      
      <Text
        size="lg"
        weight="bold"
        style={{
          marginBottom: tokens.spacing[2],
          background: 'linear-gradient(135deg, #c9b8db 0%, #e8dff0 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        {featureName || t('proOnly')}
      </Text>
      
      {featureDescription && (
        <Text
          size="sm"
          color="secondary"
          style={{ marginBottom: tokens.spacing[4], textAlign: 'center', maxWidth: 280 }}
        >
          {featureDescription}
        </Text>
      )}
      
      <Link href={href} style={{ textDecoration: 'none' }}>
        <Button
          variant="primary"
          onClick={onClick}
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
            background: 'var(--color-pro-badge-bg, linear-gradient(135deg, #8b6fa8 0%, #a78bba 100%))',
            border: 'none',
            boxShadow: '0 4px 20px var(--color-pro-badge-shadow, rgba(139, 111, 168, 0.4))',
          }}
        >
          {finalButtonText}
        </Button>
      </Link>
    </Box>
  )
}
