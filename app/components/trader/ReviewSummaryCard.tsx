'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { StarRating } from './ReviewStars'
import { RatingDistributionBar } from './ReviewStars'
import type { ReviewSummary } from '@/lib/data/reviews'

export function ReviewSummaryCard({
  summary,
  t,
}: {
  summary: ReviewSummary
  t: (key: string) => string
}) {
  return (
    <Box style={{
      padding: tokens.spacing[5],
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.xl,
      border: `1px solid ${tokens.colors.border.primary}`,
      display: 'flex',
      gap: tokens.spacing[6],
      alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      {/* Big average */}
      <Box style={{ textAlign: 'center', minWidth: 100 }}>
        <Text size="3xl" weight="black" style={{ color: tokens.colors.text.primary, lineHeight: 1 }}>
          {summary.review_count > 0 ? summary.avg_rating.toFixed(1) : '—'}
        </Text>
        <Box style={{ margin: '6px 0 4px' }}>
          <StarRating rating={Math.round(summary.avg_rating)} size={18} />
        </Box>
        <Text size="xs" color="tertiary">
          {summary.review_count} {t('reviewCount')}
        </Text>
      </Box>

      {/* Distribution */}
      <Box style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[5, 4, 3, 2, 1].map((star) => (
          <RatingDistributionBar
            key={star}
            stars={star}
            count={summary.rating_distribution[star] || 0}
            total={summary.review_count}
          />
        ))}
      </Box>
    </Box>
  )
}
