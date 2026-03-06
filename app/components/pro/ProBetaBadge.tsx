'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ProBetaBadgeProps {
  style?: React.CSSProperties
  size?: 'xs' | 'sm'
}

/**
 * 显示在 Pro 功能旁边的"Pro · 限时免费"标签。
 * Beta 期间代替 PaywallOverlay 使用。
 */
export default function ProBetaBadge({ style, size = 'xs' }: ProBetaBadgeProps) {
  const { t } = useLanguage()

  const fontSize = size === 'xs' ? 10 : 11

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 6px',
        borderRadius: tokens.radius.full,
        background: 'color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 15%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 35%, transparent)',
        fontSize,
        fontWeight: 700,
        color: 'var(--color-pro-gradient-start, #a78bfa)',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
        ...style,
      }}
    >
      Pro · {t('proFreeNow')}
    </span>
  )
}
