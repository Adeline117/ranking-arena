/**
 * Shared button size styles used by MessageButton, UserFollowButton, ContactSupportButton.
 * Extracted to eliminate duplication across 3 components.
 */

import { tokens } from '@/lib/design-tokens'

export type ButtonSize = 'sm' | 'md' | 'lg'

export const BUTTON_SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: {
    padding: `${tokens.spacing[2.5]} ${tokens.spacing[4]}`,
    fontSize: tokens.typography.fontSize.sm,
    borderRadius: tokens.radius.md,
    minHeight: '44px',
  },
  md: {
    padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
    fontSize: tokens.typography.fontSize.base,
    borderRadius: tokens.radius.lg,
    minHeight: '44px',
  },
  lg: {
    padding: `${tokens.spacing[3.5]} ${tokens.spacing[6]}`,
    fontSize: tokens.typography.fontSize.md,
    borderRadius: tokens.radius.lg,
    minHeight: '48px',
  },
}

export const GLASS_BUTTON_BASE: React.CSSProperties = {
  border: '1px solid var(--glass-border-medium)',
  background: 'var(--glass-bg-light)',
  color: tokens.colors.text.primary,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: tokens.spacing[1.5],
  transition: 'all 200ms ease',
}

export function MessageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}
