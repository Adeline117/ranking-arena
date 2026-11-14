'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useLanguage } from '../Providers/LanguageProvider'

interface ExchangeScopeNoticeProps {
  /** Server exchange cohort currently shown; null renders nothing. */
  exchange: string | null
  onClear: () => void
}

/**
 * "Filtered by X · Clear" — the only visible signal that the board is scoped
 * to one exchange (e.g. after a click on the exchange marquee or an `?ex=`
 * link), with a one-tap way back to the all-exchange board.
 */
export default function ExchangeScopeNotice({ exchange, onClear }: ExchangeScopeNoticeProps) {
  const { t } = useLanguage()
  if (!exchange) return null
  const label = EXCHANGE_NAMES[exchange] ?? exchange
  return (
    <div
      role="status"
      data-testid="exchange-scope-notice"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        flexWrap: 'wrap',
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        marginBottom: tokens.spacing[2],
        borderRadius: tokens.radius.md,
        background: alpha(tokens.colors.accent.primary, 6),
        border: `1px solid ${alpha(tokens.colors.accent.primary, 19)}`,
        fontSize: tokens.typography.fontSize.sm,
        color: tokens.colors.text.secondary,
      }}
    >
      <span>{t('rankingFilteredByExchange').replace('{exchange}', label)}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('rankingClearExchangeFilter')}
        className="tap-target"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: tokens.colors.accent.primary,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
        }}
      >
        {t('clear')}
      </button>
    </div>
  )
}
