'use client'

import React, { useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/* ---------- shared section model (stable, language-independent ids) ---------- */

const SECTIONS: { id: string; titleKey: string }[] = [
  { id: 'data-sources', titleKey: 'methodologySec1Title' },
  { id: 'update-frequency', titleKey: 'methodologySec2Title' },
  { id: 'arena-score', titleKey: 'methodologySec3Title' },
  { id: 'time-windows', titleKey: 'methodologySec4Title' },
  { id: 'normalization', titleKey: 'methodologySec5Title' },
  { id: 'anti-gaming', titleKey: 'methodologySec6Title' },
  { id: 'limitations', titleKey: 'methodologySec7Title' },
  { id: 'faq', titleKey: 'methodologySec8Title' },
]

const KEY_POINT_KEYS = [
  'methodologyKeyPoint1',
  'methodologyKeyPoint2',
  'methodologyKeyPoint3',
  'methodologyKeyPoint4',
]

const FAQ_KEYS = [
  { q: 'methodologyFaqQ1', a: 'methodologyFaqA1' },
  { q: 'methodologyFaqQ2', a: 'methodologyFaqA2' },
  { q: 'methodologyFaqQ3', a: 'methodologyFaqA3' },
  { q: 'methodologyFaqQ4', a: 'methodologyFaqA4' },
  { q: 'methodologyFaqQ5', a: 'methodologyFaqA5' },
  { q: 'methodologyFaqQ6', a: 'methodologyFaqA6' },
]

/* ---------- styles ---------- */

const containerStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: '64px 24px 96px',
  color: 'var(--color-text-primary)',
  lineHeight: tokens.typography.lineHeight.relaxed,
}

const subtitleStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.md,
  color: 'var(--color-text-secondary)',
  marginTop: tokens.spacing[2],
  marginBottom: tokens.spacing[8],
}

const sectionStyle: React.CSSProperties = { marginBottom: tokens.spacing[12] }

const headingStyle: React.CSSProperties = {
  marginBottom: tokens.spacing[4],
  scrollMarginTop: tokens.spacing[20],
}

const bodyStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.base,
  color: 'var(--color-text-secondary)',
}

const listStyle: React.CSSProperties = { paddingLeft: 20, marginTop: tokens.spacing[3] }
const liStyle: React.CSSProperties = { marginBottom: tokens.spacing[2] }

const calloutStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: tokens.radius.md,
  border: '1px solid var(--color-border-primary)',
  marginTop: tokens.spacing[4],
}

const formulaBoxStyle: React.CSSProperties = {
  padding: '20px 24px',
  background: 'var(--color-bg-secondary)',
  borderRadius: tokens.radius.md,
  border: '1px solid var(--color-border-primary)',
  fontFamily: tokens.typography.fontFamily.mono.join(', '),
  fontSize: tokens.typography.fontSize.sm,
  lineHeight: 2,
  marginTop: tokens.spacing[4],
  overflow: 'auto',
}

const badgeRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: tokens.spacing[4],
  marginTop: tokens.spacing[4],
  flexWrap: 'wrap',
}

const faqStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: tokens.radius.md,
  marginBottom: tokens.spacing[4],
}

const keyPointsBoxStyle: React.CSSProperties = {
  padding: '20px 24px',
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
  borderRadius: tokens.radius.lg,
  marginBottom: tokens.spacing[10],
}

const tocBoxStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
  borderRadius: tokens.radius.lg,
  marginBottom: tokens.spacing[12],
}

const anchorClass =
  'rounded-md outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-primary)]'

/* ---------- helpers ---------- */

function renderParagraphs(block: string): React.ReactNode {
  return block.split('\n\n').map((p, i) => (
    <p key={i} style={i > 0 ? { marginTop: tokens.spacing[3] } : undefined}>
      {p}
    </p>
  ))
}

function renderList(block: string, style?: React.CSSProperties): React.ReactNode {
  return (
    <ul style={{ ...listStyle, ...style }}>
      {block
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item, i) => (
          <li key={i} style={liStyle}>
            {item}
          </li>
        ))}
    </ul>
  )
}

function WeightBadge({ period, weight }: { period: string; weight: string }) {
  return (
    <div
      style={{
        padding: '8px 16px',
        borderRadius: tokens.radius.sm,
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-border-primary)',
        fontSize: tokens.typography.fontSize.base,
        fontWeight: tokens.typography.fontWeight.medium,
        color: 'var(--color-text-primary)',
      }}
    >
      {period} <span style={{ color: 'var(--color-accent-primary)' }}>{weight}</span>
    </div>
  )
}

/* ---------- page ---------- */

export default function MethodologyPageClient() {
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
      <Text
        as="h1"
        size="4xl"
        weight="black"
        style={{ letterSpacing: '-0.02em', lineHeight: 1.15 }}
      >
        {t('methodologyTitle')}
      </Text>
      <p style={subtitleStyle}>{t('methodologySubtitle')}</p>

      {/* Key Points summary */}
      <div style={keyPointsBoxStyle}>
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
      <nav aria-label={t('legalOnThisPage')} style={tocBoxStyle}>
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

      {/* Data Sources */}
      <section style={sectionStyle}>
        <Text as="h2" id="data-sources" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec1Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('methodologySec1Intro')}</p>
          {renderList(t('methodologySec1List'))}
          <p style={{ marginTop: tokens.spacing[3] }}>{t('methodologySec1Outro')}</p>
        </div>
      </section>

      {/* Update Frequency */}
      <section style={sectionStyle}>
        <Text as="h2" id="update-frequency" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec2Title')}
        </Text>
        <div style={bodyStyle}>
          <div style={calloutStyle}>{renderList(t('methodologySec2List'), { marginTop: 0 })}</div>
        </div>
      </section>

      {/* Arena Score Algorithm */}
      <section style={sectionStyle}>
        <Text as="h2" id="arena-score" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec3Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('scoreV4Intro')}</p>

          <div style={formulaBoxStyle}>
            <div>
              <strong>{t('scoreV4Formula')}</strong>
            </div>
          </div>

          <p style={{ marginTop: tokens.spacing[4] }}>
            <strong>{t('scoreV4QualityTitle')}</strong>
          </p>
          <p style={{ marginTop: tokens.spacing[2] }}>{t('scoreV4QualityDesc')}</p>
          {renderList(
            [
              `${t('scoreV4DimPnl')} — 0.30`,
              `${t('scoreV4DimRoi')} — 0.20`,
              `${t('scoreV4DimDrawdown')} — 0.20`,
              `${t('scoreV4DimSharpe')} — 0.20`,
              `${t('scoreV4DimConsistency')} — 0.10`,
            ].join('\n')
          )}

          <p style={{ marginTop: tokens.spacing[4] }}>
            <strong>{t('scoreV4ConfidenceTitle')}</strong>
          </p>
          <p style={{ marginTop: tokens.spacing[2] }}>{t('scoreV4ConfidenceDesc')}</p>

          <p style={{ marginTop: tokens.spacing[4] }}>
            <strong>{t('scoreV4DisplayTitle')}</strong>
          </p>
          <p style={{ marginTop: tokens.spacing[2] }}>{t('scoreV4DisplayDesc')}</p>
        </div>
      </section>

      {/* Time Windows */}
      <section style={sectionStyle}>
        <Text as="h2" id="time-windows" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec4Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('methodologySec4Intro')}</p>
          <div style={badgeRowStyle}>
            <WeightBadge period="90D" weight="70%" />
            <WeightBadge period="30D" weight="25%" />
            <WeightBadge period="7D" weight="5%" />
          </div>
          <p style={{ marginTop: tokens.spacing[4] }}>{t('methodologySec4Outro')}</p>
        </div>
      </section>

      {/* Cross-Exchange Normalization */}
      <section style={sectionStyle}>
        <Text as="h2" id="normalization" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec5Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('methodologySec5Intro')}</p>
          {renderList(t('methodologySec5List'))}
          <p style={{ marginTop: tokens.spacing[3] }}>{t('methodologySec5Outro')}</p>
        </div>
      </section>

      {/* Anti-Gaming */}
      <section style={sectionStyle}>
        <Text as="h2" id="anti-gaming" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec6Title')}
        </Text>
        <div style={bodyStyle}>{renderList(t('methodologySec6List'))}</div>
      </section>

      {/* Data Limitations */}
      <section style={sectionStyle}>
        <Text as="h2" id="limitations" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec7Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('methodologySec7Intro')}</p>
          {renderList(t('methodologySec7List'))}
        </div>
      </section>

      {/* FAQ */}
      <section style={sectionStyle}>
        <Text as="h2" id="faq" size="2xl" weight="semibold" style={headingStyle}>
          {t('methodologySec8Title')}
        </Text>
        <div style={bodyStyle}>
          {FAQ_KEYS.map((f) => (
            <div key={f.q} style={faqStyle}>
              <p
                style={{
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: 'var(--color-text-primary)',
                  marginBottom: tokens.spacing[2],
                }}
              >
                {t(f.q)}
              </p>
              <p style={{ margin: 0 }}>{t(f.a)}</p>
            </div>
          ))}
        </div>
      </section>

      <div
        style={{
          marginTop: tokens.spacing[16],
          paddingTop: tokens.spacing[6],
          borderTop: '1px solid var(--color-border-primary)',
        }}
      >
        <Link
          href="/rankings"
          className={anchorClass}
          style={{
            color: 'var(--color-accent-primary)',
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.base,
            fontWeight: tokens.typography.fontWeight.medium,
          }}
        >
          &larr; {t('methodologyBackRankings')}
        </Link>
      </div>
    </div>
  )
}
