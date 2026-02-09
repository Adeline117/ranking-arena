'use client'

import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface PaywallOverlayProps {
  /** 功能描述，如 "完整排行榜"、"高级筛选" */
  feature?: string
  /** 是否紧凑模式（内联在列表中） */
  compact?: boolean
  style?: React.CSSProperties
}

const LockIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const CrownIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z" />
  </svg>
)

export default function PaywallOverlay({ feature, compact = false, style }: PaywallOverlayProps) {
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const title = isZh ? '升级 Pro，解锁全部功能' : 'Upgrade to Pro to unlock all features'
  const featureText = feature
    ? (isZh ? `${feature} 为 Pro 专属功能` : `${feature} is a Pro-only feature`)
    : undefined
  const priceText = isZh ? '低至 $8.3/月' : 'Starting at $8.3/mo'
  const buttonText = isZh ? '查看方案' : 'View Plans'

  if (compact) {
    return (
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: '16px 20px',
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          border: '1px solid var(--color-pro-gold-glow)',
          ...style,
        }}
      >
        <Box style={{ color: tokens.colors.medal.gold, display: 'flex', alignItems: 'center' }}>
          <LockIcon size={18} />
        </Box>
        <Text style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>
          {featureText || title}
        </Text>
        <Button
          onClick={() => router.push('/pricing')}
          style={{
            padding: '6px 16px',
            fontSize: 13,
            fontWeight: 600,
            background: 'linear-gradient(135deg, #D4A847, #C4963C)',
            color: 'var(--color-on-accent)',
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {buttonText}
        </Button>
      </Box>
    )
  }

  return (
    <Box
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        textAlign: 'center',
        background: 'linear-gradient(180deg, transparent 0%, var(--color-bg-primary) 20%)',
        backdropFilter: 'blur(4px)',
        borderRadius: tokens.radius.lg,
        ...style,
      }}
    >
      {/* 锁图标 */}
      <Box
        style={{
          width: 56,
          height: 56,
          borderRadius: tokens.radius.full,
          background: 'var(--color-pro-gold-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
          color: tokens.colors.medal.gold,
        }}
      >
        <LockIcon size={28} />
      </Box>

      {/* 标题 */}
      <Text
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          marginBottom: 8,
        }}
      >
        {title}
      </Text>

      {/* 功能描述 */}
      {featureText && (
        <Text
          style={{
            fontSize: 14,
            color: 'var(--color-text-secondary)',
            marginBottom: 12,
          }}
        >
          {featureText}
        </Text>
      )}

      {/* 价格 */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 20,
          color: tokens.colors.medal.gold,
        }}
      >
        <CrownIcon size={16} />
        <Text style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.medal.gold }}>
          {priceText}
        </Text>
      </Box>

      {/* 升级按钮 */}
      <Button
        onClick={() => router.push('/pricing')}
        style={{
          padding: '12px 32px',
          fontSize: 16,
          fontWeight: 700,
          background: 'linear-gradient(135deg, #D4A847, #C4963C)',
          color: 'var(--color-on-accent)',
          border: 'none',
          borderRadius: tokens.radius.md,
          cursor: 'pointer',
          boxShadow: '0 4px 12px var(--color-pro-gold-glow)',
          transition: 'transform 0.15s, box-shadow 0.15s',
        }}
      >
        {buttonText}
      </Button>
    </Box>
  )
}

/**
 * 半透明遮罩版本 - 覆盖在内容上方
 * 用于排行榜100名后的渐变遮罩
 */
export function PaywallGradientOverlay({ feature, style }: { feature?: string; style?: React.CSSProperties }) {
  return (
    <Box
      style={{
        position: 'relative',
        marginTop: -80,
        paddingTop: 80,
        background: 'linear-gradient(180deg, transparent 0%, var(--color-bg-primary) 60px)',
        ...style,
      }}
    >
      <PaywallOverlay feature={feature} />
    </Box>
  )
}
