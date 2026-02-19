'use client'

import { useLanguage } from './LanguageProvider'

interface SkipLinkProps {
  targetId?: string
}

/**
 * Skip to main content link for accessibility
 * Allows keyboard users to skip navigation
 */
export function SkipLink({ targetId = 'main-content' }: SkipLinkProps) {
  const { t } = useLanguage()

  return (
    <a
      href={`#${targetId}`}
      className="skip-link"
      style={{
        position: 'absolute',
        left: '-9999px',
        top: 'auto',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
      }}
      onFocus={(e) => {
        e.currentTarget.style.left = '16px'
        e.currentTarget.style.top = '16px'
        e.currentTarget.style.width = 'auto'
        e.currentTarget.style.height = 'auto'
        e.currentTarget.style.overflow = 'visible'
        e.currentTarget.style.background = 'var(--color-bg-primary)'
        e.currentTarget.style.color = 'var(--color-text-primary)'
        e.currentTarget.style.padding = '8px 16px'
        e.currentTarget.style.borderRadius = '4px'
        e.currentTarget.style.zIndex = '9999'
        e.currentTarget.style.fontWeight = '600'
        e.currentTarget.style.textDecoration = 'none'
        e.currentTarget.style.border = '2px solid var(--color-accent-primary)'
      }}
      onBlur={(e) => {
        e.currentTarget.style.left = '-9999px'
        e.currentTarget.style.width = '1px'
        e.currentTarget.style.height = '1px'
        e.currentTarget.style.overflow = 'hidden'
      }}
    >
      {t('skipToContent')}
    </a>
  )
}

export default SkipLink
