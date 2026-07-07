'use client'

import React, { useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/* ---------- shared section model (stable, language-independent ids) ---------- */

const SECTIONS: { id: string; titleKey: string }[] = [
  { id: 'service-description', titleKey: 'termsSec1Title' },
  { id: 'disclaimer', titleKey: 'termsSec2Title' },
  { id: 'user-responsibilities', titleKey: 'termsSec3Title' },
  { id: 'intellectual-property', titleKey: 'termsSec4Title' },
  { id: 'account-termination', titleKey: 'termsSec5Title' },
  { id: 'limitation-of-liability', titleKey: 'termsSec6Title' },
  { id: 'pro-subscription', titleKey: 'termsSec7Title' },
  { id: 'governing-law', titleKey: 'termsSec8Title' },
  { id: 'changes', titleKey: 'termsSec9Title' },
  { id: 'contact', titleKey: 'termsSec10Title' },
]

const KEY_POINT_KEYS = ['termsKeyPoint1', 'termsKeyPoint2', 'termsKeyPoint3', 'termsKeyPoint4']

const PROFILE_HANDLE = 'ywen8@uw.edu'
const PROFILE_HREF = 'mailto:ywen8@uw.edu'

/* ---------- styles ---------- */

const containerStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: '64px 24px 96px',
  color: 'var(--color-text-primary)',
  lineHeight: tokens.typography.lineHeight.relaxed,
}

const subtitleStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.base,
  color: 'var(--color-text-tertiary)',
  marginTop: tokens.spacing[2],
  marginBottom: tokens.spacing[8],
}

const sectionStyle: React.CSSProperties = { marginBottom: tokens.spacing[10] }

const headingStyle: React.CSSProperties = {
  marginBottom: tokens.spacing[3],
  scrollMarginTop: tokens.spacing[20],
}

const bodyStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.base,
  color: 'var(--color-text-secondary)',
}

const listStyle: React.CSSProperties = { paddingLeft: 20, marginTop: tokens.spacing[3] }
const liStyle: React.CSSProperties = { marginBottom: tokens.spacing[2] }

const warningBoxStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderLeft: '4px solid var(--color-accent-warning)',
  borderRadius: tokens.radius.md,
  marginTop: tokens.spacing[3],
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

function renderList(block: string): React.ReactNode {
  return (
    <ul style={listStyle}>
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

/* ---------- page ---------- */

export default function TermsOfServicePage() {
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
        {t('termsTitle')}
      </Text>
      <p style={subtitleStyle}>{t('termsLastUpdated')}</p>

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

      <section style={sectionStyle}>
        <Text as="h2" id="service-description" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec1Title')}
        </Text>
        <div style={bodyStyle}>
          {renderParagraphs(t('termsSec1Body'))}
          <div style={warningBoxStyle}>
            <p
              style={{
                margin: 0,
                fontWeight: tokens.typography.fontWeight.semibold,
                color: 'var(--color-accent-warning)',
              }}
            >
              {t('termsSec1Warning')}
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="disclaimer" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec2Title')}
        </Text>
        <div style={bodyStyle}>{renderList(t('termsSec2List'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="user-responsibilities" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec3Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('termsSec3Intro')}</p>
          {renderList(t('termsSec3List'))}
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="intellectual-property" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec4Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('termsSec4Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="account-termination" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec5Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('termsSec5Intro')}</p>
          {renderList(t('termsSec5List'))}
          <p style={{ marginTop: tokens.spacing[3] }}>
            {t('termsSec5Contact')}{' '}
            <Link
              href={PROFILE_HREF}
              className={anchorClass}
              style={{ color: 'var(--color-accent-primary)' }}
            >
              {PROFILE_HANDLE}
            </Link>
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="limitation-of-liability" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec6Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('termsSec6Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="pro-subscription" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec7Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('termsSec7Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="governing-law" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec8Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('termsSec8Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="changes" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec9Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('termsSec9Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="contact" size="xl" weight="semibold" style={headingStyle}>
          {t('termsSec10Title')}
        </Text>
        <div style={bodyStyle}>
          <p>
            {t('termsSec10Body')}{' '}
            <Link
              href={PROFILE_HREF}
              className={anchorClass}
              style={{ color: 'var(--color-accent-primary)' }}
            >
              {PROFILE_HANDLE}
            </Link>
          </p>
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
          href="/"
          className={anchorClass}
          style={{
            color: 'var(--color-accent-primary)',
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.base,
            fontWeight: tokens.typography.fontWeight.medium,
          }}
        >
          &larr; {t('legalBackHome')}
        </Link>
      </div>
    </div>
  )
}
