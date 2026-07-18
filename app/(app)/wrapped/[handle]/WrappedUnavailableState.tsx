'use client'

/**
 * A transient, retryable state for a rank card whose public snapshot could not
 * be loaded. This is intentionally separate from WrappedEmptyState: an
 * unavailable backend is not evidence that the trader or card is missing.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

interface WrappedUnavailableStateProps {
  handle: string
  reason: 'timeout' | 'error'
}

export default function WrappedUnavailableState({ handle, reason }: WrappedUnavailableStateProps) {
  const router = useRouter()
  const { t } = useLanguage()

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        background:
          'linear-gradient(180deg, var(--color-bg-primary) 0%, var(--color-bg-secondary) 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`,
        textAlign: 'center',
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
      }}
    >
      <div style={{ maxWidth: 480, width: '100%' }}>
        <div
          aria-hidden="true"
          style={{
            width: 64,
            height: 64,
            margin: '0 auto 24px',
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: tokens.colors.accent.warning,
            background: 'color-mix(in srgb, var(--color-accent-warning) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent-warning) 28%, transparent)',
          }}
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 16.5A4.5 4.5 0 0 0 17.5 8a6 6 0 0 0-11.7 1.5A3.5 3.5 0 0 0 6.5 16.5" />
            <path d="M12 12v4" />
            <path d="M12 19h.01" />
          </svg>
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: tokens.typography.fontSize.hero,
            fontWeight: tokens.typography.fontWeight.black,
            color: tokens.colors.text.primary,
            letterSpacing: '-0.5px',
          }}
        >
          {t('serviceTemporarilyUnavailable')}
        </h1>

        <p
          style={{
            margin: '14px 0 4px',
            fontSize: tokens.typography.fontSize.base,
            lineHeight: tokens.typography.lineHeight.normal,
            color: tokens.colors.text.secondary,
          }}
        >
          {reason === 'timeout' ? t('requestTimeoutRetry') : t('serverUnavailable')}
        </p>

        <p
          style={{
            margin: '4px 0 32px',
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.tertiary,
            wordBreak: 'break-all',
          }}
        >
          @{handle}
        </p>

        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={() => router.refresh()}
            style={{
              padding: '13px 26px',
              borderRadius: tokens.radius.lg,
              border: 'none',
              background:
                'linear-gradient(135deg, var(--color-brand) 0%, var(--color-accent-warning) 100%)',
              color: tokens.colors.white,
              fontSize: tokens.typography.fontSize.base,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
            }}
          >
            {t('retryButton')}
          </button>
          <Link
            href="/rankings"
            style={{
              padding: '13px 26px',
              borderRadius: tokens.radius.lg,
              background: 'color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.base,
              fontWeight: tokens.typography.fontWeight.semibold,
              textDecoration: 'none',
            }}
          >
            {t('rankings')}
          </Link>
        </div>
      </div>
    </div>
  )
}
