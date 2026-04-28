'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
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

export default function ResultPageClient({
  typeId,
  matchPercent,
  recommendedTraders,
  secondaryTypeId,
  allTypePercents,
}: ResultPageClientProps) {
  const { language, t } = useLanguage()
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
              border: '1px solid rgba(255,255,255,0.08)',
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

        {/* 2. Mini share — X + Copy only */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              const text = `${t('quizShareChallenge') !== 'quizShareChallenge' ? t('quizShareChallenge') : `Just scored ${matchPercent}% ${t(pType.nameKey)} on Arena's trader personality test. Bet you can't beat my match`} ${resultUrl}`
              window.open(
                `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
                '_blank',
                'noopener,noreferrer'
              )
            }}
            className="quiz-share-x-btn"
            style={{ flex: 1 }}
            aria-label="Share on X"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            {t('quizShareOnX') !== 'quizShareOnX' ? t('quizShareOnX') : 'Share on X'}
          </button>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(resultUrl).catch(() => {})}
            style={{
              padding: '12px 16px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--color-text-primary)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            aria-label="Copy link"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>

        {/* 3. Style Analysis */}
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
                    background: ct.color + '12',
                    border: '1px solid ' + ct.color + '25',
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
                    background: 'var(--color-accent-error-10)',
                    border: '1px solid var(--color-accent-error-20)',
                    fontSize: 13,
                    color: 'var(--color-accent-error)',
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

        {/* 9. Bottom CTAs */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/quiz" className="quiz-cta-secondary">
            {t('quizRetake')}
          </Link>
          <Link
            href="/rankings"
            className="quiz-cta-primary"
            style={{ background: pType.gradient }}
          >
            {t('quizFindTraders')}
          </Link>
        </div>
      </div>
    </div>
  )
}
