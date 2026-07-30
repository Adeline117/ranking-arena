'use client'

import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

/**
 * Offline page
 * Shown when user is offline and no cached page is available
 *
 * Service worker v5 intentionally caches only this fallback document. Do not
 * read legacy ranking caches here: they have no current freshness, units, or
 * published-rank contract and are deleted during service-worker activation.
 */
export default function OfflinePage() {
  const { t } = useLanguage()

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--spacing-4, 1rem)',
        backgroundColor: 'var(--color-bg-primary, #0B0A10)',
        color: 'var(--color-text-primary, #EDEDED)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center',
          padding: 'var(--spacing-8, 2rem)',
        }}
      >
        {/* Offline icon */}
        <div
          aria-hidden="true"
          style={{
            width: '64px',
            height: '64px',
            margin: '0 auto 1.5rem',
            borderRadius: '50%',
            backgroundColor: 'var(--color-bg-tertiary, #1C1926)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-text-tertiary, #8E8E9E)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginBottom: '0.75rem',
            color: 'var(--color-text-primary, #EDEDED)',
          }}
        >
          {t('youAreOffline')}
        </h1>

        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-secondary, #A8A8B3)',
            marginBottom: '2rem',
            lineHeight: 1.6,
          }}
        >
          {t('checkNetworkAndRetryOffline')}
        </p>

        {/* Native form submission still works when offline JS cannot hydrate. */}
        <form action="" method="get">
          <button
            type="submit"
            style={{
              display: 'block',
              padding: '0.75rem 2rem',
              fontSize: '0.875rem',
              fontWeight: '500',
              color: 'var(--color-on-accent)',
              backgroundColor: 'var(--color-brand, #8b6fa8)',
              border: 'none',
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            {t('retryConnection')}
          </button>
        </form>

        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-text-tertiary, #6B6B7B)',
            marginTop: '2rem',
          }}
        >
          {t('arenaTagline')}
        </p>
      </div>
    </main>
  )
}
