'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import type { Trader } from '../ranking/RankingTableTypes'
import { useLanguage } from '../Providers/LanguageProvider'

/**
 * Site-wide search matches for a `?q=` that found nothing on the current
 * ranking page. These rows have no published rank in this cohort, so they are
 * shown as plain profile links — never as ranked table rows.
 */
export default function SearchElsewhereMatches({ traders }: { traders: readonly Trader[] }) {
  const { t } = useLanguage()
  if (traders.length === 0) return null
  return (
    <nav
      aria-label={t('rankingSearchElsewhereTitle')}
      data-testid="search-elsewhere-matches"
      style={{
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        marginBottom: tokens.spacing[2],
        borderRadius: tokens.radius.md,
        border: '1px solid var(--color-border-primary)',
        fontSize: tokens.typography.fontSize.sm,
      }}
    >
      <div style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>
        {t('rankingSearchElsewhereTitle')}
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
        }}
      >
        {traders.map((trader) => {
          const href = `/trader/${encodeURIComponent(trader.id)}${
            trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''
          }`
          const platform = trader.source ? (EXCHANGE_NAMES[trader.source] ?? trader.source) : null
          return (
            <li key={`${trader.source ?? ''}:${trader.id}`}>
              <Link href={href} style={{ color: tokens.colors.accent.primary }}>
                {trader.handle || trader.id}
                {platform ? ` · ${platform}` : ''}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
