'use client'

interface SkipLinkProps {
  targetId?: string
}

/**
 * Skip to main content link for accessibility
 * Allows keyboard users to skip navigation
 */
export function SkipLink({ targetId = 'main-content' }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
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
      }}
      onBlur={(e) => {
        e.currentTarget.style.left = '-9999px'
        e.currentTarget.style.width = '1px'
        e.currentTarget.style.height = '1px'
        e.currentTarget.style.overflow = 'hidden'
      }}
    >
      Skip to main content
    </a>
  )
}

export default SkipLink
