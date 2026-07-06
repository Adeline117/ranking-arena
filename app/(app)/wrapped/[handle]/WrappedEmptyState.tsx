'use client'

/**
 * WrappedEmptyState — friendly empty state for /wrapped/[handle]
 *
 * Shown when resolveTrader finds no leaderboard snapshot for the handle
 * (reason: 'not_found'). Previously this path hard-404'd — which was
 * indistinguishable from a genuinely unknown URL and dead-ended logged-in
 * users viewing their OWN handle before their card had data. Rendering a
 * dedicated "no rank card yet" empty state (i18n'd) instead of the generic
 * site 404 makes it clear the account is valid but has no snapshot yet.
 */

import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

export default function WrappedEmptyState({ handle }: { handle: string }) {
  const { t } = useLanguage()

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        textAlign: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 480, width: '100%' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 18px',
            borderRadius: 999,
            background: 'rgba(212,175,55,0.15)',
            border: '1px solid rgba(212,175,55,0.35)',
            marginBottom: 24,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#F0D060', letterSpacing: '2px' }}>
            ARENA RANK CARD
          </span>
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 900,
            color: '#FFFFFF',
            letterSpacing: '-0.5px',
          }}
        >
          {t('wrappedEmptyTitle')}
        </h1>

        <p
          style={{
            margin: '14px 0 4px',
            fontSize: 15,
            lineHeight: 1.6,
            color: 'rgba(255,255,255,0.55)',
          }}
        >
          {t('wrappedEmptyDesc')}
        </p>

        <p
          style={{
            margin: '4px 0 32px',
            fontSize: 13,
            color: 'rgba(255,255,255,0.35)',
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
          <Link
            href="/"
            style={{
              padding: '13px 26px',
              borderRadius: tokens.radius.lg,
              background: 'linear-gradient(135deg, #8B5CF6 0%, #D4AF37 100%)',
              color: '#FFFFFF',
              fontSize: 15,
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {t('wrappedEmptyHome')}
          </Link>
          <Link
            href="/rankings"
            style={{
              padding: '13px 26px',
              borderRadius: tokens.radius.lg,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.7)',
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {t('wrappedEmptyRankings')}
          </Link>
        </div>
      </div>
    </div>
  )
}
