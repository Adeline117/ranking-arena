'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'

interface StarRatingProps {
  rating?: number          // average rating for display
  ratingCount?: number     // number of ratings
  userRating?: number      // current user's rating
  onRate?: (rating: number) => void
  size?: number
  readonly?: boolean
  showCount?: boolean
}

const GOLD = tokens.colors.rating.filled
const GOLD_DIM = tokens.colors.rating.empty

function StarIcon({ fill, size = 20 }: { fill: 'full' | 'half' | 'empty'; size?: number }) {
  if (fill === 'full') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={GOLD} stroke={GOLD} strokeWidth="1">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    )
  }
  if (fill === 'half') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" stroke={GOLD} strokeWidth="1">
        <defs>
          <linearGradient id="halfGrad">
            <stop offset="50%" stopColor={GOLD} />
            <stop offset="50%" stopColor={GOLD_DIM} />
          </linearGradient>
        </defs>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="url(#halfGrad)" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={GOLD_DIM} stroke={GOLD} strokeWidth="1" opacity={0.4}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

export default function StarRating({
  rating = 0,
  ratingCount = 0,
  userRating,
  onRate,
  size = 20,
  readonly = false,
  showCount = true,
}: StarRatingProps) {
  const [hoverRating, setHoverRating] = useState(0)

  const displayRating = hoverRating || userRating || rating
  const interactive = !readonly && !!onRate

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{ display: 'flex', gap: 2, cursor: interactive ? 'pointer' : 'default' }}
        onMouseLeave={() => interactive && setHoverRating(0)}
      >
        {[1, 2, 3, 4, 5].map(star => {
          const fill = displayRating >= star ? 'full' : displayRating >= star - 0.5 ? 'half' : 'empty'
          return (
            <span
              key={star}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `${star} star${star > 1 ? 's' : ''}` : undefined}
              onMouseEnter={() => interactive && setHoverRating(star)}
              onClick={() => interactive && onRate?.(star)}
              onKeyDown={(e) => { if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRate?.(star) } }}
              style={{ display: 'inline-flex', transition: 'transform 0.15s' }}
              onMouseDown={e => {
                if (interactive) (e.currentTarget as HTMLElement).style.transform = 'scale(1.2)'
              }}
              onMouseUp={e => {
                if (interactive) (e.currentTarget as HTMLElement).style.transform = 'scale(1)'
              }}
            >
              <StarIcon fill={interactive && hoverRating ? (hoverRating >= star ? 'full' : 'empty') : fill} size={size} />
            </span>
          )
        })}
      </div>
      {showCount && (
        <span style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
          {rating > 0 && <span style={{ color: GOLD, fontWeight: 600 }}>{rating.toFixed(1)}</span>}
          {ratingCount > 0 && <span> ({ratingCount})</span>}
        </span>
      )}
    </div>
  )
}
