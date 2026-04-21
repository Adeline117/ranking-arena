'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { BASE_URL } from '@/lib/constants/urls'
import { PERSONALITY_TYPE_MAP, PERSONALITY_TYPES } from '../components/quiz-data'
import type { PersonalityTypeId, RecommendedTrader } from '../components/types'
import PersonalityCard from './components/PersonalityCard'
import MasterSection from './components/MasterSection'
import StyleAnalysis from './components/StyleAnalysis'
import RecommendedTraders from './components/RecommendedTraders'
import ShareActions from './components/ShareActions'

interface ResultPageClientProps {
  typeId: PersonalityTypeId
  matchPercent: number
  recommendedTraders: RecommendedTrader[]
}

export default function ResultPageClient({ typeId, matchPercent, recommendedTraders }: ResultPageClientProps) {
  const { t } = useLanguage()
  const pType = PERSONALITY_TYPE_MAP[typeId] || PERSONALITY_TYPES[0]

  // Find secondary type (next in compatibility list)
  const secondaryId = pType.compatibleTypes[0] || 'analyst'
  const secondaryType = PERSONALITY_TYPE_MAP[secondaryId]
  const secondaryLabel = secondaryType ? t(secondaryType.nameKey) : secondaryId

  const resultUrl = `${BASE_URL}/quiz/result?type=${typeId}&match=${matchPercent}`

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 'clamp(16px, 4vw, 32px)',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 560,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          animation: 'fadeIn 0.5s ease-out',
        }}
      >
        {/* Personality Card */}
        <PersonalityCard
          type={pType}
          matchPercent={matchPercent}
          secondaryTypeLabel={secondaryLabel}
          tr={t}
        />

        {/* Master Biography */}
        <MasterSection type={pType} tr={t} />

        {/* Style Analysis */}
        <StyleAnalysis type={pType} tr={t} />

        {/* Recommended Arena Traders */}
        <RecommendedTraders type={pType} traders={recommendedTraders} tr={t} />

        {/* Share Actions */}
        <div
          style={{
            borderRadius: 16,
            background: 'var(--color-backdrop-heavy)',
            border: '1px solid var(--glass-border-light)',
            padding: 'clamp(20px, 4vw, 28px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <h3
            style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.bold,
              color: 'var(--color-text-primary)',
              margin: 0,
            }}
          >
            {t('quizShareTitle')}
          </h3>
          <ShareActions type={pType} matchPercent={matchPercent} resultUrl={resultUrl} tr={t} />
        </div>

        {/* CTAs */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link
            href="/quiz"
            style={{
              flex: 1,
              minWidth: 140,
              padding: '12px 20px',
              borderRadius: 12,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: tokens.typography.fontSize.base,
              fontWeight: tokens.typography.fontWeight.medium,
              textAlign: 'center',
              textDecoration: 'none',
              transition: 'border-color 0.2s',
            }}
          >
            {t('quizRetake')}
          </Link>
          <Link
            href="/rankings"
            style={{
              flex: 1,
              minWidth: 140,
              padding: '12px 20px',
              borderRadius: 12,
              border: 'none',
              background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
              color: '#fff',
              fontSize: tokens.typography.fontSize.base,
              fontWeight: tokens.typography.fontWeight.bold,
              textAlign: 'center',
              textDecoration: 'none',
              boxShadow: '0 4px 20px rgba(139, 92, 246, 0.35)',
            }}
          >
            {t('quizFindTraders')}
          </Link>
        </div>
      </div>
    </div>
  )
}
