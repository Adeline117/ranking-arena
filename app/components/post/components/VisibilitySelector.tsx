'use client'

import { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'
import type { PostVisibility } from '@/lib/types/post'

interface VisibilitySelectorProps {
  value: PostVisibility
  onChange: (value: PostVisibility) => void
  /** Whether the post is in a group (locks to 'group') */
  isGroupPost?: boolean
}

const VISIBILITY_OPTIONS: Array<{
  value: PostVisibility
  iconPath: string
  labelKey: string
  descKey: string
}> = [
  {
    value: 'public',
    // Globe icon
    iconPath: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    labelKey: 'visibilityPublic',
    descKey: 'visibilityPublicDesc',
  },
  {
    value: 'followers',
    // People icon
    iconPath: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    labelKey: 'visibilityFollowers',
    descKey: 'visibilityFollowersDesc',
  },
  {
    value: 'group',
    // Lock icon
    iconPath: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    labelKey: 'visibilityGroup',
    descKey: 'visibilityGroupDesc',
  },
]

export function VisibilitySelector({ value, onChange, isGroupPost }: VisibilitySelectorProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selected = VISIBILITY_OPTIONS.find(o => o.value === value) || VISIBILITY_OPTIONS[0]

  // If it's a group post, lock to group visibility
  if (isGroupPost) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: tokens.colors.bg.tertiary,
        border: `1px solid ${tokens.colors.border.primary}`,
        fontSize: tokens.typography.fontSize.xs,
        color: tokens.colors.text.secondary,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d={VISIBILITY_OPTIONS[2].iconPath} />
        </svg>
        {t('visibilityGroup')}
      </div>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          background: tokens.colors.bg.tertiary,
          border: `1px solid ${tokens.colors.border.primary}`,
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.secondary,
          cursor: 'pointer',
          transition: 'border-color 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = tokens.colors.accent.brand
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d={selected.iconPath} />
        </svg>
        {t(selected.labelKey)}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.5 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: 4,
          minWidth: 220,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          boxShadow: tokens.shadow.lg,
          zIndex: 50,
          overflow: 'hidden',
        }}>
          {VISIBILITY_OPTIONS.filter(o => o.value !== 'group').map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background: value === option.value ? `${tokens.colors.accent.brand}15` : 'transparent',
                border: 'none',
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                if (value !== option.value) {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = value === option.value ? `${tokens.colors.accent.brand}15` : 'transparent'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={value === option.value ? tokens.colors.accent.brand : tokens.colors.text.secondary} style={{ marginTop: 2, flexShrink: 0 }}>
                <path d={option.iconPath} />
              </svg>
              <div>
                <div style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: value === option.value ? 600 : 500,
                  color: value === option.value ? tokens.colors.accent.brand : tokens.colors.text.primary,
                }}>
                  {t(option.labelKey)}
                </div>
                <div style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                  marginTop: 2,
                }}>
                  {t(option.descKey)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default VisibilitySelector
