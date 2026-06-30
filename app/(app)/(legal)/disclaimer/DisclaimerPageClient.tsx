'use client'

import React, { useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/* ---------- shared section model (stable, language-independent ids) ---------- */

const SECTIONS: { id: string; titleKey: string }[] = [
  { id: 'general', titleKey: 'disclaimerGeneral' },
  { id: 'risk-warning', titleKey: 'disclaimerRiskWarning' },
  { id: 'data-accuracy', titleKey: 'disclaimerDataAccuracy' },
  { id: 'liability', titleKey: 'disclaimerLiability' },
]

const SECTION_BODY: Record<string, string> = {
  general: 'disclaimerGeneralBody',
  'risk-warning': 'disclaimerRiskWarningBody',
  'data-accuracy': 'disclaimerDataAccuracyBody',
  liability: 'disclaimerLiabilityBody',
}

const KEY_POINT_KEYS = ['disclaimerKeyPoint1', 'disclaimerKeyPoint2', 'disclaimerKeyPoint3']

/* ---------- styles ---------- */

const containerStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'var(--color-bg-primary)',
  padding: '64px 16px 96px',
}

const innerStyle: React.CSSProperties = { maxWidth: 768, margin: '0 auto' }

const sectionStyle: React.CSSProperties = { marginBottom: tokens.spacing[8] }

const headingStyle: React.CSSProperties = {
  marginBottom: tokens.spacing[3],
  scrollMarginTop: tokens.spacing[20],
}

const bodyStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.base,
  color: 'var(--color-text-secondary)',
  lineHeight: tokens.typography.lineHeight.relaxed,
}

const listStyle: React.CSSProperties = { paddingLeft: 20, marginTop: tokens.spacing[3] }
const liStyle: React.CSSProperties = { marginBottom: tokens.spacing[2] }

const boxStyle: React.CSSProperties = {
  padding: '20px 24px',
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
  borderRadius: tokens.radius.lg,
  marginBottom: tokens.spacing[8],
}

const anchorClass =
  'rounded-md outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-primary)]'

/* ---------- page ---------- */

export default function DisclaimerPageClient() {
  const { t } = useLanguage()

  const jumpTo = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (typeof history !== 'undefined') history.replaceState(null, '', `#${id}`)
    }
  }, [])

  return (
    <div style={containerStyle}>
      <div style={innerStyle}>
        <Text
          as="h1"
          size="4xl"
          weight="black"
          style={{ letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: tokens.spacing[8] }}
        >
          {t('disclaimerTitle')}
        </Text>

        {/* Key Points summary */}
        <div style={boxStyle}>
          <Text as="h2" size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            {t('legalKeyPoints')}
          </Text>
          <ul style={{ ...listStyle, marginTop: 0, ...bodyStyle }}>
            {KEY_POINT_KEYS.map((k) => (
              <li key={k} style={liStyle}>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>

        {/* Table of contents */}
        <nav
          aria-label={t('legalOnThisPage')}
          style={{ ...boxStyle, marginBottom: tokens.spacing[10] }}
        >
          <Text
            as="h2"
            size="base"
            weight="semibold"
            color="tertiary"
            style={{ marginBottom: tokens.spacing[3] }}
          >
            {t('legalOnThisPage')}
          </Text>
          <ol style={{ ...listStyle, marginTop: 0, ...bodyStyle }}>
            {SECTIONS.map((s) => (
              <li key={s.id} style={liStyle}>
                <a
                  href={`#${s.id}`}
                  onClick={(e) => jumpTo(e, s.id)}
                  className={anchorClass}
                  style={{ color: 'var(--color-accent-primary)', textDecoration: 'none' }}
                >
                  {t(s.titleKey)}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {SECTIONS.map((s) => (
          <section key={s.id} style={sectionStyle}>
            <Text as="h2" id={s.id} size="xl" weight="semibold" style={headingStyle}>
              {t(s.titleKey)}
            </Text>
            <p style={bodyStyle}>{t(SECTION_BODY[s.id])}</p>
          </section>
        ))}
      </div>
    </div>
  )
}
