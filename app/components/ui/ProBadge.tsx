'use client'

import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

interface ProBadgeProps {
  tier?: 'pro'
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
  style?: React.CSSProperties
}

// Pro 会员徽章配置
const PRO_CONFIG = {
  label: 'Pro',
  labelZh: 'Pro',
  gradient: 'var(--color-pro-badge-bg)',
  glow: 'var(--color-pro-badge-shadow)',
  iconColor: tokens.colors.medal.gold,
}

// 淡淡发光动画样式（注入一次）
const glowKeyframes = `
@keyframes proBadgeGlow {
  0%, 100% { box-shadow: 0 2px 8px var(--color-pro-badge-shadow), 0 0 12px var(--color-pro-gold-glow); }
  50% { box-shadow: 0 2px 12px var(--color-pro-badge-shadow), 0 0 20px var(--color-pro-gold-glow); }
}
`
if (typeof document !== 'undefined' && !document.getElementById('pro-badge-glow')) {
  const style = document.createElement('style')
  style.id = 'pro-badge-glow'
  style.textContent = glowKeyframes
  document.head.appendChild(style)
}

// 尺寸配置
const SIZE_CONFIG = {
  sm: { badge: 18, font: 9, padding: '2px 6px', iconSize: 10 },
  md: { badge: 22, font: 10, padding: '3px 8px', iconSize: 12 },
  lg: { badge: 28, font: 12, padding: '4px 12px', iconSize: 14 },
}

// 星星图标
const StarIcon = ({ size = 12, color = 'var(--color-on-accent)' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

export default function ProBadge({ size = 'md', showLabel = true, style }: ProBadgeProps) {
  const { language } = useLanguage()
  const config = PRO_CONFIG
  const sizeConfig = SIZE_CONFIG[size]
  const label = localizedLabel(config.labelZh, config.label, language)

  if (!showLabel) {
    return (
      <Box
        style={{
          width: sizeConfig.badge,
          height: sizeConfig.badge,
          borderRadius: tokens.radius.full,
          background: config.gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 2px 8px ${config.glow}, 0 0 12px var(--color-pro-gold-glow)`,
          animation: 'proBadgeGlow 3s ease-in-out infinite',
          flexShrink: 0,
          ...style,
        }}
      >
        <StarIcon size={sizeConfig.iconSize} color={config.iconColor} />
      </Box>
    )
  }

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: sizeConfig.padding,
        borderRadius: tokens.radius.full,
        background: config.gradient,
        boxShadow: `0 2px 8px ${config.glow}, 0 0 12px var(--color-pro-gold-glow)`,
        animation: 'proBadgeGlow 3s ease-in-out infinite',
        ...style,
      }}
    >
      <StarIcon size={sizeConfig.iconSize} color={config.iconColor} />
      <Text
        style={{
          fontSize: sizeConfig.font,
          fontWeight: 700,
          color: tokens.colors.white,
          lineHeight: 1.2,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </Box>
  )
}

// 头像角标徽章
export function ProBadgeOverlay({ 
  position = 'bottom-right' 
}: { 
  position?: 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left'
}) {
  const config = PRO_CONFIG
  
  const positionStyles: Record<string, React.CSSProperties> = {
    'top-right': { top: -2, right: -2 },
    'bottom-right': { bottom: 0, right: 0 },
    'top-left': { top: -2, left: -2 },
    'bottom-left': { bottom: 0, left: 0 },
  }

  return (
    <Box
      style={{
        position: 'absolute',
        ...positionStyles[position],
        width: 20,
        height: 20,
        borderRadius: tokens.radius.full,
        background: config.gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 2px 6px ${config.glow}, 0 0 10px var(--color-pro-gold-glow), 0 0 0 2px var(--color-bg-primary)`,
        animation: 'proBadgeGlow 3s ease-in-out infinite',
        zIndex: tokens.zIndex.dropdown,
      }}
    >
      <StarIcon size={11} color={config.iconColor} />
    </Box>
  )
}
