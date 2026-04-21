'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { setLanguage, onTranslationsReady } from '@/lib/i18n'
import { BASE_URL } from '@/lib/constants/urls'
import { PERSONALITY_TYPE_MAP, PERSONALITY_TYPES } from '../components/quiz-data'
import type { PersonalityTypeId, RecommendedTrader } from '../components/types'
import { useQuizStore } from '@/lib/stores/quizStore'
import PersonalityCard from './components/PersonalityCard'
import TypeBreakdown from './components/TypeBreakdown'
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
  const { language, t } = useLanguage()
  const quizResult = useQuizStore((s) => s.result)
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)

  useEffect(() => {
    setMounted(true)
    const unsub = onTranslationsReady(() => setTxnReady(true))
    if (t('quizTitle') !== 'quizTitle') setTxnReady(true)
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pType = PERSONALITY_TYPE_MAP[typeId] || PERSONALITY_TYPES[0]

  // Find secondary type (next in compatibility list)
  const secondaryId = pType.compatibleTypes[0] || 'analyst'
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
      style={{
        padding: 'clamp(16px, 4vw, 24px)',
        paddingBottom: 80,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          animation: 'fadeIn 0.5s ease-out',
          position: 'relative',
        }}
      >
        {/* Language toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={handleToggleLanguage}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
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

        {/* Personality Card */}
        <PersonalityCard
          type={pType}
          matchPercent={matchPercent}
          secondaryTypeLabel={secondaryLabel}
          tr={t}
        />

        {/* Type Breakdown */}
        {quizResult?.allTypePercents && (
          <TypeBreakdown
            allTypePercents={quizResult.allTypePercents}
            primaryTypeId={typeId}
            tr={t}
          />
        )}

        {/* Master Biography */}
        <MasterSection type={pType} tr={t} />

        {/* Style Analysis */}
        <StyleAnalysis type={pType} tr={t} />

        {/* Type Compatibility */}
        <div
          style={{
            borderRadius: 12,
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            padding: 'clamp(16px, 3vw, 24px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 20, borderRadius: 2, background: pType.gradient }} />
            <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
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
                <span key={id} style={{ padding: '4px 10px', borderRadius: 6, background: ct.color + '15', border: '1px solid ' + ct.color + '25', fontSize: 13, color: ct.color, fontWeight: 600 }}>
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
                <span key={id} style={{ padding: '4px 10px', borderRadius: 6, background: 'var(--color-accent-error-10)', border: '1px solid var(--color-accent-error-20)', fontSize: 13, color: 'var(--color-accent-error)', fontWeight: 600 }}>
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
        </div>

        {/* Recommended Arena Traders */}
        <RecommendedTraders type={pType} traders={recommendedTraders} tr={t} />

        {/* Share Actions */}
        <div
          style={{
            borderRadius: 12,
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            padding: 'clamp(16px, 3vw, 24px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 20, borderRadius: 2, background: pType.gradient }} />
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
          </div>
          <ShareActions type={pType} matchPercent={matchPercent} resultUrl={resultUrl} tr={t} />
        </div>

        {/* CTAs */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <Link
            href="/quiz"
            style={{
              flex: 1,
              minWidth: 140,
              padding: '12px 20px',
              borderRadius: 8,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              fontWeight: 500,
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
              borderRadius: 8,
              border: 'none',
              background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center',
              textDecoration: 'none',
            }}
          >
            {t('quizFindTraders')}
          </Link>
        </div>
      </div>
    </div>
  )
}
