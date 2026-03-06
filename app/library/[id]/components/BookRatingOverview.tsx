'use client'

import { tokens } from '@/lib/design-tokens'
import StarRating from '@/app/components/ui/StarRating'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface BookRatingOverviewProps {
  average: number
  count: number
  distribution: Record<number, number>
}

export default function BookRatingOverview({ average, count, distribution }: BookRatingOverviewProps) {
  const { t } = useLanguage()
  const maxDist = Math.max(...Object.values(distribution), 1)

  return (
    <div style={{
      display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center',
    }}>
      <div style={{ textAlign: 'center', minWidth: 100 }}>
        <div style={{ fontSize: 56, fontWeight: 800, color: tokens.colors.rating.filled, lineHeight: 1, letterSpacing: '-0.04em' }}>
          {average.toFixed(1)}
        </div>
        <StarRating rating={average} size={20} readonly showCount={false} />
        <div style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginTop: 4 }}>
          {count} {t('bookRatings')}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 200 }}>
        {[5, 4, 3, 2, 1].map(star => (
          <div key={star} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: tokens.colors.text.secondary, width: 16, textAlign: 'right' }}>{star}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill={tokens.colors.rating.filled} stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
            <div style={{ flex: 1, height: 10, borderRadius: tokens.radius.sm, background: tokens.colors.bg.primary, overflow: 'hidden' }}>
              <div style={{
                width: `${(distribution[star as keyof typeof distribution] / maxDist) * 100}%`,
                height: '100%', borderRadius: tokens.radius.sm,
                background: tokens.gradient.warning,
                transition: `width ${tokens.transition.slow}`,
              }} />
            </div>
            <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, width: 28, textAlign: 'right' }}>
              {distribution[star as keyof typeof distribution]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
