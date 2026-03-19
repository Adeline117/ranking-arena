'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'

interface SensitiveContentWrapperProps {
  contentWarning?: string | null
  children: React.ReactNode
}

export function SensitiveContentWrapper({ contentWarning, children }: SensitiveContentWrapperProps) {
  const { t } = useLanguage()
  const [revealed, setRevealed] = useState(false)

  if (revealed) {
    return (
      <div style={{ position: 'relative' }}>
        {children}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setRevealed(false)
          }}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            padding: '2px 8px',
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.tertiary,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {t('hideContent')}
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: tokens.radius.md,
        overflow: 'hidden',
      }}
    >
      {/* Blurred content */}
      <div style={{
        filter: 'blur(8px)',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {children}
      </div>

      {/* Warning overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[2],
          background: `${tokens.colors.bg.primary}80`,
          backdropFilter: 'blur(2px)',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill={tokens.colors.accent.warning}>
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
        </svg>
        <span style={{
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: 600,
          color: tokens.colors.accent.warning,
        }}>
          {t('sensitiveContent')}
        </span>
        {contentWarning && (
          <span style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            textAlign: 'center',
            maxWidth: 200,
          }}>
            {contentWarning}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setRevealed(true)
          }}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 600,
            cursor: 'pointer',
            marginTop: 4,
          }}
        >
          {t('showContent')}
        </button>
      </div>
    </div>
  )
}

export default SensitiveContentWrapper
