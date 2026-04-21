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
import RecommendedTraders from './components/RecommendedTraders'
import ShareActions from './components/ShareActions'

/** Dark-theme palette */
const Q = {
  BG_PAGE: '#0C0C14',
  BG_CARD: '#161625',
  BORDER: 'rgba(255,255,255,0.08)',
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.7)',
  TEXT_TERTIARY: 'rgba(255,255,255,0.45)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
  ERROR_BG: 'rgba(255,85,85,0.1)',
  ERROR_BORDER: 'rgba(255,85,85,0.2)',
  ERROR_COLOR: '#FF5555',
  CTA_BORDER: 'rgba(255,255,255,0.12)',
} as const

/** Light-theme palette */
const QL = {
  BG_PAGE: '#F5F5F7',
  BG_CARD: '#FFFFFF',
  BORDER: 'rgba(0,0,0,0.08)',
  TEXT_PRIMARY: '#1A1A2E',
  TEXT_SECONDARY: 'rgba(0,0,0,0.6)',
  TEXT_TERTIARY: 'rgba(0,0,0,0.4)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
  ERROR_BG: 'rgba(255,85,85,0.08)',
  ERROR_BORDER: 'rgba(255,85,85,0.15)',
  ERROR_COLOR: '#DC2626',
  CTA_BORDER: 'rgba(0,0,0,0.12)',
} as const

/** Sun icon SVG */
function SunIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  )
}

/** Moon icon SVG */
function MoonIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

interface ResultPageClientProps {
  typeId: PersonalityTypeId
  matchPercent: number
  recommendedTraders: RecommendedTrader[]
}

export default function ResultPageClient({ typeId, matchPercent, recommendedTraders }: ResultPageClientProps) {
  const { language, t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    setMounted(true)
    const unsub = onTranslationsReady(() => setTxnReady(true))
    if (t('quizTitle') !== 'quizTitle') setTxnReady(true)
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const P = isDark ? Q : QL

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

  const toggleBtnStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.3)',
    background: 'transparent',
    color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  }

  // Show loading until both mounted AND translations ready
  if (!mounted || !txnReady) {
    return (
      <div
        data-theme="dark"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          background: Q.BG_PAGE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            border: `3px solid ${Q.BRAND}33`,
            borderTopColor: Q.BRAND,
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </div>
    )
  }

  return (
    <div
      data-theme={isDark ? 'dark' : 'light'}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        padding: 'clamp(16px, 4vw, 32px)',
        paddingBottom: 80,
        display: 'flex',
        justifyContent: 'center',
        overflow: 'auto',
        background: P.BG_PAGE,
        color: P.TEXT_PRIMARY,
      }}
    >
      {/* Language / Theme toolbar */}
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 60,
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={handleToggleLanguage}
          style={toggleBtnStyle}
          aria-label="Toggle language"
        >
          {language === 'en' ? '\u4E2D\u6587' : 'EN'}
        </button>
        <button
          type="button"
          onClick={() => setIsDark(prev => !prev)}
          style={toggleBtnStyle}
          aria-label="Toggle theme"
        >
          {isDark
            ? <SunIcon color="rgba(255,255,255,0.6)" />
            : <MoonIcon color="rgba(0,0,0,0.6)" />}
        </button>
      </div>

      <div
        className="stagger-children"
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

        {/* Type Compatibility */}
        <div style={{ borderRadius: 16, background: P.BG_CARD, border: `1px solid ${P.BORDER}`, padding: 'clamp(20px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 4, height: 24, borderRadius: 2, background: pType.gradient }} />
            <h3 style={{ fontSize: '18px', fontWeight: 700, color: P.TEXT_PRIMARY, margin: 0 }}>
              {t('quizCompatTitle')}
            </h3>
          </div>
          <div style={{ fontSize: '13px', color: P.TEXT_SECONDARY, fontWeight: 500 }}>
            {t('quizCompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.compatibleTypes.map(id => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span key={id} style={{ padding: '6px 12px', borderRadius: 8, background: ct.color + '15', border: '1px solid ' + ct.color + '25', fontSize: '14px', color: ct.color, fontWeight: 600 }}>
                  {t(ct.nameKey)}
                </span>
              ) : null
            })}
          </div>
          <div style={{ fontSize: '13px', color: P.TEXT_SECONDARY, fontWeight: 500 }}>
            {t('quizIncompatWith')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pType.incompatibleTypes.map(id => {
              const ct = PERSONALITY_TYPE_MAP[id]
              return ct ? (
                <span key={id} style={{ padding: '6px 12px', borderRadius: 8, background: P.ERROR_BG, border: `1px solid ${P.ERROR_BORDER}`, fontSize: '14px', color: P.ERROR_COLOR, fontWeight: 600 }}>
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
            borderRadius: 16,
            background: P.BG_CARD,
            border: `1px solid ${P.BORDER}`,
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
              color: P.TEXT_PRIMARY,
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
              border: `1px solid ${P.CTA_BORDER}`,
              background: 'transparent',
              color: P.TEXT_PRIMARY,
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
              background: `linear-gradient(135deg, ${P.BRAND} 0%, ${P.BRAND_DEEP} 100%)`,
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
