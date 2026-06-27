'use client'

import React from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function DisclaimerPageClient() {
  const { t } = useLanguage()

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <h1
          className="font-black text-[var(--color-text-primary)] mb-8"
          style={{
            fontSize: 'clamp(28px, 3.5vw, 40px)',
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
          }}
        >
          {t('disclaimerTitle')}
        </h1>

        <div className="prose prose-invert max-w-none space-y-6 text-[var(--color-text-secondary)]">
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {t('disclaimerGeneral')}
            </h2>
            <p>{t('disclaimerGeneralBody')}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {t('disclaimerRiskWarning')}
            </h2>
            <p>{t('disclaimerRiskWarningBody')}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {t('disclaimerDataAccuracy')}
            </h2>
            <p>{t('disclaimerDataAccuracyBody')}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {t('disclaimerLiability')}
            </h2>
            <p>{t('disclaimerLiabilityBody')}</p>
          </section>
        </div>
      </div>
    </div>
  )
}
