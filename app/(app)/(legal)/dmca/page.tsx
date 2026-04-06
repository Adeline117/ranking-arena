'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'


export default function DmcaPage() {
  const { t } = useLanguage()

  const sectionStyle: React.CSSProperties = {
    marginBottom: tokens.spacing[8],
  }

  const headingStyle: React.CSSProperties = {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    marginBottom: tokens.spacing[4],
    paddingBottom: tokens.spacing[2],
    borderBottom: '1px solid var(--color-border-primary)',
  }

  const listStyle: React.CSSProperties = {
    paddingLeft: tokens.spacing[6],
    marginTop: tokens.spacing[3],
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacing[2],
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--color-bg-primary)',
      padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
    }}>
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{
          marginBottom: tokens.spacing[8],
          paddingBottom: tokens.spacing[6],
          borderBottom: '2px solid var(--color-accent-primary)',
        }}>
          <h1 style={{
            fontSize: tokens.typography.fontSize['2xl'],
            fontWeight: tokens.typography.fontWeight.black,
            color: 'var(--color-text-primary)',
            marginBottom: tokens.spacing[2],
          }}>
            {t('dmcaTitle')}
          </h1>
          <p style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
          }}>
            {t('dmcaLastUpdated')}
          </p>
        </div>

        {/* Overview */}
        <div style={sectionStyle}>
          <h2 style={headingStyle}>{t('dmcaOverviewTitle')}</h2>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
          }}>
            {t('dmcaOverviewDesc')}
          </p>
        </div>

        {/* Notice Process */}
        <div style={sectionStyle}>
          <h2 style={headingStyle}>{t('dmcaNoticeTitle')}</h2>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
          }}>
            {t('dmcaNoticeDesc')}
          </p>
          <ul style={listStyle}>
            {[
              t('dmcaNotice1'),
              t('dmcaNotice2'),
              t('dmcaNotice3'),
              t('dmcaNotice4'),
              t('dmcaNotice5'),
              t('dmcaNotice6'),
            ].map((item, i) => (
              <li key={i} style={{
                color: 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.sm,
                lineHeight: 1.7,
              }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Counter-Notice */}
        <div style={sectionStyle}>
          <h2 style={headingStyle}>{t('dmcaCounterTitle')}</h2>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
          }}>
            {t('dmcaCounterDesc')}
          </p>
          <ul style={listStyle}>
            {[
              t('dmcaCounter1'),
              t('dmcaCounter2'),
              t('dmcaCounter3'),
              t('dmcaCounter4'),
              t('dmcaCounter5'),
            ].map((item, i) => (
              <li key={i} style={{
                color: 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.sm,
                lineHeight: 1.7,
              }}>
                {item}
              </li>
            ))}
          </ul>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
            marginTop: tokens.spacing[3],
          }}>
            {t('dmcaCounterProcess')}
          </p>
        </div>

        {/* Contact */}
        <div style={sectionStyle}>
          <h2 style={headingStyle}>{t('dmcaContactTitle')}</h2>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
          }}>
            {t('dmcaContactDesc')}
          </p>
          <p style={{
            color: 'var(--color-text-secondary)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
            marginTop: tokens.spacing[2],
          }}>
            {t('dmcaContactEmail')}
          </p>
        </div>

        <ContactSupportButton />
      </div>
    </div>
  )
}
