'use client'

import React, { useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/* ---------- shared section model (stable, language-independent ids) ---------- */

const SECTIONS: { id: string; titleKey: string }[] = [
  { id: 'overview', titleKey: 'privacySec1Title' },
  { id: 'info-we-collect', titleKey: 'privacySec2Title' },
  { id: 'how-we-use', titleKey: 'privacySec3Title' },
  { id: 'third-party', titleKey: 'privacySec4Title' },
  { id: 'cookies', titleKey: 'privacySec5Title' },
  { id: 'your-rights', titleKey: 'privacySec6Title' },
  { id: 'gdpr-ccpa', titleKey: 'privacySec7Title' },
  { id: 'security-retention', titleKey: 'privacySec8Title' },
  { id: 'changes', titleKey: 'privacySec9Title' },
  { id: 'contact', titleKey: 'privacySec10Title' },
]

const KEY_POINT_KEYS = [
  'privacyKeyPoint1',
  'privacyKeyPoint2',
  'privacyKeyPoint3',
  'privacyKeyPoint4',
]

const PROFILE_HANDLE = '@adelinewen1107'
const PROFILE_HREF = '/u/adelinewen1107'

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

const calloutStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: tokens.radius.md,
  border: '1px solid var(--color-border-primary)',
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

export default function PrivacyPolicyPage() {
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
        {t('privacyTitle')}
      </Text>
      <p style={subtitleStyle}>{t('privacyLastUpdated')}</p>

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
        <Text as="h2" id="overview" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec1Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('privacySec1Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="info-we-collect" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec2Title')}
        </Text>
        <div style={bodyStyle}>
          <p style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
            {t('privacySec2ProvidedLabel')}
          </p>
          {renderList(t('privacySec2ProvidedList'))}
          <p
            style={{
              marginTop: tokens.spacing[4],
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            {t('privacySec2AutoLabel')}
          </p>
          {renderList(t('privacySec2AutoList'))}
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="how-we-use" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec3Title')}
        </Text>
        <div style={bodyStyle}>{renderList(t('privacySec3List'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="third-party" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec4Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('privacySec4Intro')}</p>
          {renderList(t('privacySec4List'))}
          <p style={{ marginTop: tokens.spacing[3] }}>{t('privacySec4Outro')}</p>
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="cookies" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec5Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('privacySec5Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="your-rights" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec6Title')}
        </Text>
        <div style={bodyStyle}>
          <p>{t('privacySec6Intro')}</p>
          {renderList(t('privacySec6List'))}
          <div style={calloutStyle}>
            <p style={{ margin: 0 }}>
              {t('privacySec6Contact')}{' '}
              <Link
                href={PROFILE_HREF}
                className={anchorClass}
                style={{ color: 'var(--color-accent-primary)' }}
              >
                {PROFILE_HANDLE}
              </Link>
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="gdpr-ccpa" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec7Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('privacySec7Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="security-retention" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec8Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('privacySec8Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="changes" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec9Title')}
        </Text>
        <div style={bodyStyle}>{renderParagraphs(t('privacySec9Body'))}</div>
      </section>

      <section style={sectionStyle}>
        <Text as="h2" id="contact" size="xl" weight="semibold" style={headingStyle}>
          {t('privacySec10Title')}
        </Text>
        <div style={bodyStyle}>
          <p>
            {t('privacySec10Body')}{' '}
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
