'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
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
      style={{
        padding: 'clamp(16px, 4vw, 24px)',
        paddingBottom: 80,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 'clamp(520px, 90vw, 640px)',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 0, /* Intentional: each section controls its own marginTop for rhythm */
          animation: 'fadeIn 0.5s ease-out',
          position: 'relative',
        }}
      >
        {/* Language toggle — fixed top-right of container */}
        <div style={{ position: 'absolute', top: 0, right: 0, zIndex: 2 }}>
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

        {/* Personality Card — hero, generous spacing after */}
        <PersonalityCard
          type={pType}
          matchPercent={matchPercent}
          secondaryTypeLabel={secondaryLabel}
          tr={t}
        />

        {/* Master Biography — closely related to personality, moderate gap */}
        <div style={{ marginTop: 20 }}>
          <MasterSection type={pType} tr={t} />
        </div>

        {/* Style Analysis �� new conceptual section, wider gap */}
        <div style={{ marginTop: 24 }}>
          <StyleAnalysis type={pType} tr={t} />
        </div>

        {/* Type Breakdown — show score distribution across all types (only if data available) */}
        {allTypePercents && (
          <div style={{ marginTop: 16 }}>
            <TypeBreakdown
              allTypePercents={allTypePercents}
              primaryTypeId={typeId}
              tr={t}
            />
          </div>
        )}

        {/* Type Compatibility — companion to style, tighter */}
        <div
          style={{
            marginTop: 14,
            borderRadius: 14,
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            padding: 'clamp(16px, 3vw, 24px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 20, borderRadius: 2, background: pType.gradient }} />
            <h3 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: tokens.typography.fontWeight.bold, color: 'var(--color-text-primary)', margin: 0 }}>
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

        {/* Recommended Arena Traders — action-oriented, generous gap */}
        <div style={{ marginTop: 24 }}>
          <RecommendedTraders type={pType} traders={recommendedTraders} tr={t} />
        </div>

        {/* Share Actions — final section, moderate gap */}
        <div
          style={{
            marginTop: 18,
            borderRadius: 14,
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            padding: 'clamp(16px, 3vw, 24px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
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

        {/* CTAs — final call-to-action, generous top gap */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 28 }}>
          <Link
            href="/quiz"
            style={{
              flex: 1,
              minWidth: 140,
              padding: '13px 20px',
              borderRadius: 10,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              fontWeight: 500,
              textAlign: 'center',
              textDecoration: 'none',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-text-tertiary)'
              e.currentTarget.style.transform = 'translateY(-2px)'
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--glass-border-light)'
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            {t('quizRetake')}
          </Link>
          <Link
            href="/rankings"
            style={{
              flex: 1,
              minWidth: 140,
              padding: '13px 20px',
              borderRadius: 10,
              border: 'none',
              background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center',
              textDecoration: 'none',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: '0 2px 8px color-mix(in srgb, var(--color-brand) 25%, transparent)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px) scale(1.01)'
              e.currentTarget.style.boxShadow = '0 6px 20px color-mix(in srgb, var(--color-brand) 35%, transparent)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0) scale(1)'
              e.currentTarget.style.boxShadow = '0 2px 8px color-mix(in srgb, var(--color-brand) 25%, transparent)'
            }}
          >
            {t('quizFindTraders')}
          </Link>
        </div>
      </div>
    </div>
  )
}
