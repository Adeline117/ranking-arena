'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

// ============ Star Icon ============

export function StarIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? tokens.colors.medal.gold : 'none'}
      stroke={filled ? tokens.colors.medal.gold : tokens.colors.text.tertiary}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

// ============ Star Rating ============

export function StarRating({
  rating,
  interactive = false,
  size = 16,
  onChange,
}: {
  rating: number
  interactive?: boolean
  size?: number
  onChange?: (rating: number) => void
}) {
  const [hoverRating, setHoverRating] = useState(0)
  const displayRating = interactive && hoverRating > 0 ? hoverRating : rating

  return (
    <Box style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => interactive && onChange?.(star)}
          onMouseEnter={() => interactive && setHoverRating(star)}
          onMouseLeave={() => interactive && setHoverRating(0)}
          disabled={!interactive}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: interactive ? 'pointer' : 'default',
            display: 'flex',
            transition: 'transform 0.15s',
            transform: interactive && hoverRating === star ? 'scale(1.2)' : 'scale(1)',
          }}
        >
          <StarIcon filled={star <= displayRating} size={size} />
        </button>
      ))}
    </Box>
  )
}

// ============ Rating Distribution Bar ============

export function RatingDistributionBar({ stars, count, total }: { stars: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text size="xs" style={{ width: 16, textAlign: 'right', color: tokens.colors.text.tertiary }}>{stars}</Text>
      <Box style={{
        flex: 1,
        height: 6,
        borderRadius: 3,
        background: tokens.colors.bg.tertiary,
        overflow: 'hidden',
      }}>
        <Box style={{
          width: `${pct}%`,
          height: '100%',
          borderRadius: 3,
          background: tokens.colors.medal.gold,
          transition: 'width 0.5s ease',
        }} />
      </Box>
      <Text size="xs" style={{ width: 24, color: tokens.colors.text.tertiary }}>{count}</Text>
    </Box>
  )
}
