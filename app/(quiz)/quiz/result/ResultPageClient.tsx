'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { type Language, translations, loadTranslations, onTranslationsReady } from '../i18n'
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

export default function ResultPageClient({
  typeId,
  matchPercent,
  recommendedTraders,
  secondaryTypeId,
  allTypePercents,
}: ResultPageClientProps) {
  const [language, setLanguage] = useState<Language>('en')
  const t = (key: string): string => {
    return translations[language]?.[key] ?? translations.en[key] ?? key
  }
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)

  useEffect(() => {
    setMounted(true)
    const unsub = onTranslationsReady(() => setTxnReady(true))
    if (t('quizTitle') !== 'quizTitle') setTxnReady(true)
    // Fallback: if translations fail to load within 3s, render anyway with raw keys
    const timeout = setTimeout(() => setTxnReady(true), 3000)
    return () => {
      unsub()
      clearTimeout(timeout)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pType = PERSONALITY_TYPE_MAP[typeId] || PERSONALITY_TYPES[0]

  // Use actual secondary type from quiz scores if available, otherwise fall back to compatibility list
  const secondaryId = secondaryTypeId || pType.compatibleTypes[0] || 'analyst'
  const secondaryType = PERSONALITY_TYPE_MAP[secondaryId]
  const secondaryLabel = secondaryType ? t(secondaryType.nameKey) : secondaryId

  const resultUrl = `${BASE_URL}/quiz/result?type=${typeId}&match=${matchPercent}`

  const handleToggleLanguage = async () => {
    const newLang = language === 'en' ? 'zh' : 'en'
    if (newLang !== 'en') await loadTranslations(newLang)
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
      style={
        {
          '--quiz-type-color-15': `${pType.color}26`,
        } as React.CSSProperties
      }
    >
      <div className="quiz-result-container" style={{ gap: 24 }}>
        {/* Top bar: retake + language toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Link
            href="/quiz"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 10px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              fontWeight: 500,
              textDecoration: 'none',
              transition: 'color 0.2s',
            }}
          >
            <span aria-hidden="true">{'\u2190'}</span>
            {t('quizRetake') !== 'quizRetake' ? t('quizRetake') : 'Retake'}
          </Link>
          <button
            type="button"
            onClick={handleToggleLanguage}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            aria-label={language === 'en' ? 'Switch to Chinese' : 'Switch to English'}
          >
            {language === 'en' ? '\u4E2D\u6587' : 'EN'}
          </button>
        </div>

        {/* 1. Hero Personality Card */}
        <PersonalityCard
          type={pType}
          matchPercent={matchPercent}
          secondaryTypeLabel={secondaryLabel}
          tr={t}
        />

        {/* 2. Style Analysis */}
        <div style={{ '--section-delay': '0.4s' } as React.CSSProperties}>
          <StyleAnalysis type={pType} tr={t} />
        </div>

        {/* 4. Type Breakdown */}
        {allTypePercents && (
          <div style={{ '--section-delay': '0.6s' } as React.CSSProperties}>
            <TypeBreakdown allTypePercents={allTypePercents} primaryTypeId={typeId} tr={t} />
          </div>
        )}

        {/* 5. Compatibility */}
        <div
          className="quiz-section-card"
          style={{ '--section-delay': '0.8s' } as React.CSSProperties}
        >
          <div className="quiz-section-header">
            <div className="quiz-section-accent" style={{ background: pType.gradient }} />
            <h3 className="quiz-section-title">{t('quizCompatTitle')}</h3>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              color: 'var(--color-accent-success)',
              fontWeight: 600,
            }}
          >
            <span>{'\u2713'}</span>
            {t('quizCompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.compatibleTypes.map((id) => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span
                  key={id}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 20,
                    background: ct.color + '18',
                    border: '1px solid ' + ct.color + '30',
                    fontSize: 13,
                    color: ct.color,
                    fontWeight: 600,
                  }}
                >
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              color: 'var(--color-accent-error)',
              fontWeight: 600,
              marginTop: 8,
            }}
          >
            <span>{'\u2717'}</span>
            {t('quizIncompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.incompatibleTypes.map((id) => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span
                  key={id}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 20,
                    background: '#EF444420',
                    border: '1px solid #EF444430',
                    fontSize: 13,
                    color: '#EF4444',
                    fontWeight: 600,
                  }}
                >
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
        </div>

        {/* 6. Master Biography */}
        <div style={{ '--section-delay': '1.0s' } as React.CSSProperties}>
          <MasterSection type={pType} tr={t} />
        </div>

        {/* 7. Recommended Traders */}
        <div style={{ '--section-delay': '1.2s' } as React.CSSProperties}>
          <RecommendedTraders type={pType} traders={recommendedTraders} tr={t} />
        </div>

        {/* 8. Full Share Actions */}
        <div
          className="quiz-section-card"
          style={{ '--section-delay': '1.4s' } as React.CSSProperties}
        >
          <div className="quiz-section-header">
            <div className="quiz-section-accent" style={{ background: pType.gradient }} />
            <h3 className="quiz-section-title">{t('quizShareTitle')}</h3>
          </div>
          <ShareActions type={pType} matchPercent={matchPercent} resultUrl={resultUrl} tr={t} />
        </div>

        {/* 9. Bottom CTAs — stack vertically so text never wraps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Link
            href="/rankings"
            className="quiz-cta-primary"
            style={{ background: pType.gradient, width: '100%' }}
          >
            {t('quizFindTraders')}
          </Link>
          <Link href="/quiz" className="quiz-cta-secondary" style={{ width: '100%' }}>
            {t('quizRetake')}
          </Link>
        </div>
      </div>
    </div>
  )
}
