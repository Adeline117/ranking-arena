import type { CSSProperties } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ARENA_PURPLE } from '@/lib/utils/content'
import type { Comment } from '../hooks/usePostComments'

export type { Comment }
export type CommentSortMode = 'best' | 'time'

export const REPLIES_PREVIEW_COUNT = 2

// Shared styles used across comment sub-components
export const commentStyles = {
  actionButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    color: tokens.colors.text.tertiary,
    padding: '8px 10px',
    minHeight: 44,
    minWidth: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  } satisfies CSSProperties,
  input: {
    flex: 1,
    padding: '6px 10px',
    borderRadius: tokens.radius.md,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.tertiary,
    color: tokens.colors.text.primary,
    fontSize: 13,
    outline: 'none',
  } satisfies CSSProperties,
  submitButton: (disabled: boolean) => ({
    padding: '6px 12px',
    borderRadius: tokens.radius.md,
    border: 'none',
    background: ARENA_PURPLE,
    color: tokens.colors.white,
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }) satisfies CSSProperties,
  avatar: (size: number) => ({
    width: size,
    height: size,
    borderRadius: '50%',
    objectFit: 'cover' as const,
  }),
  avatarPlaceholder: (size: number) => ({
    width: size,
    height: size,
    borderRadius: '50%',
    background: tokens.colors.bg.tertiary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: tokens.colors.text.tertiary,
  }) satisfies CSSProperties,
}
