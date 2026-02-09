'use client'

import React from 'react'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

export default function TermsOfServicePage() {
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
            {t('termsTitle')}
          </h1>
          <p style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-tertiary)',
          }}>
            {t('termsLastUpdated')}
          </p>
          <p style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-tertiary)',
            marginTop: tokens.spacing[1],
          }}>
            ArenaFi (arenafi.org)
          </p>
        </div>

        {/* Content */}
        <div style={{
          color: 'var(--color-text-secondary)',
          lineHeight: 1.8,
          fontSize: '0.9375rem',
        }}>
          {/* 1. Accept */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsAcceptTitle')}</h2>
            <p>{t('termsAcceptP1')}</p>
          </section>

          {/* 2. Service */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsServiceTitle')}</h2>
            <p>{t('termsServiceP1')}</p>
            <ul style={listStyle}>
              <li>{t('termsService1')}</li>
              <li>{t('termsService2')}</li>
              <li>{t('termsService3')}</li>
              <li>{t('termsService4')}</li>
            </ul>
          </section>

          {/* 3. Account */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsAccountTitle')}</h2>
            
            <div style={{
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[5],
              marginBottom: tokens.spacing[4],
            }}>
              <h3 style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                marginBottom: tokens.spacing[2],
              }}>
                {t('termsAccountCreateTitle')}
              </h3>
              <p>{t('termsAccountCreateP1')}</p>
            </div>

            <div style={{
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[5],
              marginBottom: tokens.spacing[4],
            }}>
              <h3 style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                marginBottom: tokens.spacing[2],
              }}>
                {t('termsAccountSecurityTitle')}
              </h3>
              <p>{t('termsAccountSecurityP1')}</p>
            </div>

            <div style={{
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[5],
            }}>
              <h3 style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                marginBottom: tokens.spacing[2],
              }}>
                {t('termsAccountAgeTitle')}
              </h3>
              <p>{t('termsAccountAgeP1')}</p>
            </div>
          </section>

          {/* 4. User Conduct */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsUserConductTitle')}</h2>
            <p>{t('termsUserConductIntro')}</p>
            <ul style={listStyle}>
              <li>{t('termsUserConduct1')}</li>
              <li>{t('termsUserConduct2')}</li>
              <li>{t('termsUserConduct3')}</li>
              <li>{t('termsUserConduct4')}</li>
              <li>{t('termsUserConduct5')}</li>
              <li>{t('termsUserConduct6')}</li>
              <li>{t('termsUserConduct7')}</li>
            </ul>
          </section>

          {/* 5. Content */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsContentTitle')}</h2>
            <h3 style={{
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginTop: tokens.spacing[4],
              marginBottom: tokens.spacing[2],
            }}>
              {t('termsUserContentTitle')}
            </h3>
            <p>{t('termsUserContentP1')}</p>

            <h3 style={{
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginTop: tokens.spacing[4],
              marginBottom: tokens.spacing[2],
            }}>
              {t('termsContentModerationTitle')}
            </h3>
            <p>{t('termsContentModerationP1')}</p>
          </section>

          {/* 6. Disclaimer - Important highlight */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsDisclaimerTitle')}</h2>
            <div style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-accent-warning)',
              borderLeft: '4px solid var(--color-accent-warning)',
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[5],
            }}>
              <p style={{
                fontWeight: 600,
                color: 'var(--color-accent-warning)',
                marginBottom: tokens.spacing[3],
              }}>
                {t('termsDisclaimerImportant')}
              </p>
              <ul style={{ ...listStyle, marginTop: 0 }}>
                <li>{t('termsDisclaimer1')}</li>
                <li>{t('termsDisclaimer2')}</li>
                <li>{t('termsDisclaimer3')}</li>
                <li>{t('termsDisclaimer4')}</li>
              </ul>
            </div>
          </section>

          {/* 7. Liability */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsLiabilityTitle')}</h2>
            <p>{t('termsLiabilityIntro')}</p>
            <ul style={listStyle}>
              <li>{t('termsLiability1')}</li>
              <li>{t('termsLiability2')}</li>
              <li>{t('termsLiability3')}</li>
              <li>{t('termsLiability4')}</li>
            </ul>
          </section>

          {/* 8. IP */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsIpTitle')}</h2>
            <p>{t('termsIpP1')}</p>
          </section>

          {/* 9. Changes */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsChangesTitle')}</h2>
            <p>{t('termsChangesIntro')}</p>
            <ul style={listStyle}>
              <li>{t('termsChanges1')}</li>
              <li>{t('termsChanges2')}</li>
              <li>{t('termsChanges3')}</li>
            </ul>
          </section>

          {/* 10. Governing Law */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsGoverningLawTitle')}</h2>
            <p>{t('termsGoverningLawP1')}</p>
          </section>

          {/* 11. Contact */}
          <section style={sectionStyle}>
            <h2 style={headingStyle}>{t('termsContactTitle')}</h2>
            <p>{t('termsContactP1')}</p>
            <div style={{ marginTop: tokens.spacing[4] }}>
              <ContactSupportButton size="sm" label={t('termsSendMessageToSupport')} />
            </div>
          </section>
        </div>

        {/* Footer */}
        <div style={{
          marginTop: tokens.spacing[8],
          paddingTop: tokens.spacing[6],
          borderTop: '1px solid var(--color-border-primary)',
        }}>
          <a
            href="/"
            style={{
              color: 'var(--color-accent-primary)',
              textDecoration: 'none',
              fontSize: '0.875rem',
            }}
          >
            ← {t('backToHome')}
          </a>
        </div>
      </div>
    </div>
  )
}
