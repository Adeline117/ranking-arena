'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { setLanguage, onTranslationsReady } from '@/lib/i18n'
import { BASE_URL } from '@/lib/constants/urls'
import { PERSONALITY_TYPE_MAP, PERSONALITY_TYPES } from '../components/quiz-data'
import type { PersonalityTypeId, RecommendedTrader } from '../components/types'
import PersonalityCard from './components/PersonalityCard'
import MasterSection from './components/MasterSection'
import StyleAnalysis from './components/StyleAnalysis'
import TypeBreakdown from './components/TypeBreakdown'
import RecommendedTraders from './components/RecommendedTraders'
import ShareActions from './components/ShareActions'
import '../quiz.css'

interface ResultPageClientProps {
  typeId: PersonalityTypeId
  matchPercent: number
  recommendedTraders: RecommendedTrader[]
  secondaryTypeId?: PersonalityTypeId
  allTypePercents?: Record<PersonalityTypeId, number> | null
}

export default function ResultPageClient({ typeId, matchPercent, recommendedTraders, secondaryTypeId, allTypePercents }: ResultPageClientProps) {
  const { language, t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)

  useEffect(() => {
    setMounted(true)
    const unsub = onTranslationsReady(() => setTxnReady(true))
    if (t('quizTitle') !== 'quizTitle') setTxnReady(true)
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pType = PERSONALITY_TYPE_MAP[typeId] || PERSONALITY_TYPES[0]

  // Use actual secondary type from quiz scores if available, otherwise fall back to compatibility list
  const secondaryId = secondaryTypeId || pType.compatibleTypes[0] || 'analyst'
  const secondaryType = PERSONALITY_TYPE_MAP[secondaryId]
  const secondaryLabel = secondaryType ? t(secondaryType.nameKey) : secondaryId

  const resultUrl = `${BASE_URL}/quiz/result?type=${typeId}&match=${matchPercent}`

  const handleToggleLanguage = () => {
    const newLang = language === 'en' ? 'zh' : 'en'
    setLanguage(newLang)
  }

  // Show loading until both mounted AND translations ready
  if (!mounted || !txnReady) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '80vh',
          padding: 20,
        }}
      >
        <div
          role="status"
          aria-label="Loading results"
          style={{
            width: 40,
            height: 40,
            border: '3px solid var(--color-accent-primary-08)',
            borderTopColor: 'var(--color-brand)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="quiz-result-page"
      style={{
        '--quiz-type-color-15': `${pType.color}26`,
      } as React.CSSProperties}
    >
      <div className="quiz-result-container">
        {/* Language toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button
            type="button"
            onClick={handleToggleLanguage}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            aria-label="Toggle language"
          >
            {language === 'en' ? '\u4E2D\u6587' : 'EN'}
          </button>
        </div>

        {/* Top navigation — retake button for quick access */}
        <div style={{ marginBottom: 8 }}>
          <Link
            href="/quiz"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
              transition: 'border-color 0.2s, color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-text-tertiary)'
              e.currentTarget.style.color = 'var(--color-text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--glass-border-light)'
              e.currentTarget.style.color = 'var(--color-text-secondary)'
            }}
          >
            <span aria-hidden="true">&larr;</span>
            {t('quizRetake') !== 'quizRetake' ? t('quizRetake') : 'Retake Quiz'}
          </Link>
        </div>

        {/* Hero Personality Card */}
        <PersonalityCard
          type={pType}
          matchPercent={matchPercent}
          secondaryTypeLabel={secondaryLabel}
          tr={t}
        />

        {/* Master Biography */}
        <div style={{ marginTop: 20 }}>
          <MasterSection type={pType} tr={t} />
        </div>

        {/* Style Analysis */}
        <div style={{ marginTop: 24 }}>
          <StyleAnalysis type={pType} tr={t} />
        </div>

        {/* Type Breakdown (only if data available from quiz completion) */}
        {allTypePercents && (
          <div style={{ marginTop: 16 }}>
            <TypeBreakdown
              allTypePercents={allTypePercents}
              primaryTypeId={typeId}
              tr={t}
            />
          </div>
        )}

        {/* Type Compatibility */}
        <div className="quiz-section-card" style={{ marginTop: 14 }}>
          <div className="quiz-section-header">
            <div className="quiz-section-accent" style={{ background: pType.gradient }} />
            <h3 className="quiz-section-title">
              {t('quizCompatTitle')}
            </h3>
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
            {t('quizCompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.compatibleTypes.map(id => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span key={id} style={{ padding: '5px 12px', borderRadius: 20, background: ct.color + '15', border: '1px solid ' + ct.color + '25', fontSize: 13, color: ct.color, fontWeight: 600 }}>
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
            {t('quizIncompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.incompatibleTypes.map(id => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span key={id} style={{ padding: '5px 12px', borderRadius: 20, background: 'var(--color-accent-error-10)', border: '1px solid var(--color-accent-error-20)', fontSize: 13, color: 'var(--color-accent-error)', fontWeight: 600 }}>
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
        </div>

        {/* Recommended Arena Traders */}
        <div style={{ marginTop: 24 }}>
          <RecommendedTraders type={pType} traders={recommendedTraders} tr={t} />
        </div>

        {/* Share Actions */}
        <div className="quiz-section-card" style={{ marginTop: 18 }}>
          <div className="quiz-section-header">
            <div className="quiz-section-accent" style={{ background: pType.gradient }} />
            <h3 className="quiz-section-title">
              {t('quizShareTitle')}
            </h3>
          </div>
          <ShareActions type={pType} matchPercent={matchPercent} resultUrl={resultUrl} tr={t} />
        </div>

        {/* CTAs */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 28 }}>
          <Link href="/quiz" className="quiz-cta-secondary">
            {t('quizRetake')}
          </Link>
          <Link href="/rankings" className="quiz-cta-primary">
            {t('quizFindTraders')}
          </Link>
        </div>
      </div>
    </div>
  )
}
