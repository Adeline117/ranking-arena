'use client'

import React from 'react'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function TermsOfServicePage() {
  const { t } = useLanguage()

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] mb-8">
          {t('termsTitle')}
        </h1>

        <div className="prose prose-invert max-w-none space-y-6 text-[var(--color-text-secondary)]">
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {t('termsLastUpdated')}
          </p>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsAcceptTitle')}
            </h2>
            <p>
              {t('termsAcceptP1')}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsServiceTitle')}
            </h2>
            <p>
              {t('termsServiceP1')}
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>{t('termsService1')}</li>
              <li>{t('termsService2')}</li>
              <li>{t('termsService3')}</li>
              <li>{t('termsService4')}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsAccountTitle')}
            </h2>
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              {t('termsAccountCreateTitle')}
            </h3>
            <p>
              {t('termsAccountCreateP1')}
            </p>

            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              {t('termsAccountSecurityTitle')}
            </h3>
            <p>
              {t('termsAccountSecurityP1')}
            </p>

            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              {t('termsAccountAgeTitle')}
            </h3>
            <p>
              {t('termsAccountAgeP1')}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsUserConductTitle')}
            </h2>
            <p>
              {t('termsUserConductIntro')}
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>{t('termsUserConduct1')}</li>
              <li>{t('termsUserConduct2')}</li>
              <li>{t('termsUserConduct3')}</li>
              <li>{t('termsUserConduct4')}</li>
              <li>{t('termsUserConduct5')}</li>
              <li>{t('termsUserConduct6')}</li>
              <li>{t('termsUserConduct7')}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsContentTitle')}
            </h2>
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              {t('termsUserContentTitle')}
            </h3>
            <p>
              {t('termsUserContentP1')}
            </p>

            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              {t('termsContentModerationTitle')}
            </h3>
            <p>
              {t('termsContentModerationP1')}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsDisclaimerTitle')}
            </h2>
            <div className="bg-[var(--color-bg-secondary)] p-4 rounded-lg mt-4">
              <p className="font-medium text-[var(--color-accent-warning)]">
                {t('termsDisclaimerImportant')}
              </p>
              <ul className="list-disc pl-6 space-y-2 mt-2">
                <li>{t('termsDisclaimer1')}</li>
                <li>{t('termsDisclaimer2')}</li>
                <li>{t('termsDisclaimer3')}</li>
                <li>{t('termsDisclaimer4')}</li>
              </ul>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsLiabilityTitle')}
            </h2>
            <p>
              {t('termsLiabilityIntro')}
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>{t('termsLiability1')}</li>
              <li>{t('termsLiability2')}</li>
              <li>{t('termsLiability3')}</li>
              <li>{t('termsLiability4')}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsIpTitle')}
            </h2>
            <p>
              {t('termsIpP1')}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsChangesTitle')}
            </h2>
            <p>
              {t('termsChangesIntro')}
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>{t('termsChanges1')}</li>
              <li>{t('termsChanges2')}</li>
              <li>{t('termsChanges3')}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsGoverningLawTitle')}
            </h2>
            <p>
              {t('termsGoverningLawP1')}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              {t('termsContactTitle')}
            </h2>
            <p>
              {t('termsContactP1')}
            </p>
            <div className="mt-4">
              <ContactSupportButton size="sm" label={t('termsSendMessageToSupport')} />
            </div>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-[var(--color-border-primary)]">
          <a
            href="/"
            className="text-[var(--color-accent-primary)] hover:underline"
          >
            &larr; {t('backToHome')}
          </a>
        </div>
      </div>
    </div>
  )
}
