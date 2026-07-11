'use client'

import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCopyTradeUrl, getDexUrl } from '@/lib/utils/copy-trade'
import { sendTrackingEvent } from '@/lib/tracking'

/** Referral config per exchange */
const REFERRAL_LINKS: Record<string, { url: string; code: string; color: string }> = {
  binance: {
    url: 'https://www.binance.com/en/register?ref=ARENA',
    code: 'ARENA',
    color: '#F0B90B',
  },
}

function getReferralKey(source: string): string | null {
  const s = source.toLowerCase()
  if (s.startsWith('binance')) return 'binance'
  return null
}

export interface ExchangeLink {
  platform: string
  traderKey: string
  handle?: string | null
}

interface ExchangeLinksBarProps {
  primary: ExchangeLink
  linkedAccounts?: ExchangeLink[]
  /** Active account tab: 'all' or 'platform:traderKey' */
  activeAccount?: string
  /** Hide copy-trade links when viewing own profile */
  isOwnProfile?: boolean
}

export default function ExchangeLinksBar({
  primary,
  linkedAccounts,
  activeAccount,
  isOwnProfile,
}: ExchangeLinksBarProps) {
  const { t } = useLanguage()

  // Dedupe: primary + linked, unique by platform+traderKey
  const allAccounts: ExchangeLink[] = [primary]
  if (linkedAccounts) {
    for (const acc of linkedAccounts) {
      if (!allAccounts.some((a) => a.platform === acc.platform && a.traderKey === acc.traderKey)) {
        allAccounts.push(acc)
      }
    }
  }

  // Build link entries
  const entries = allAccounts
    .map((acc) => {
      const copyUrl = getCopyTradeUrl(acc.platform, acc.traderKey, acc.handle ?? undefined)
      const dexUrl = getDexUrl(acc.platform, acc.traderKey)
      const url = copyUrl || dexUrl
      if (!url) return null

      const name = EXCHANGE_NAMES[acc.platform.toLowerCase()] || acc.platform
      const isCopyTrade = !!copyUrl
      const referralKey = getReferralKey(acc.platform)
      const referral = referralKey ? REFERRAL_LINKS[referralKey] : null

      // Highlight when this account is the active tab
      const isActive =
        activeAccount && activeAccount !== 'all'
          ? activeAccount === `${acc.platform}:${acc.traderKey}`
          : acc.platform === primary.platform && acc.traderKey === primary.traderKey

      return { acc, url, name, isCopyTrade, referral, isActive }
    })
    .filter(Boolean) as Array<{
    acc: ExchangeLink
    url: string
    name: string
    isCopyTrade: boolean
    referral: { url: string; code: string; color: string } | null
    isActive: boolean
  }>

  if (entries.length === 0) return null

  return (
    <Box
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
        padding: `${tokens.spacing[3]} 0`,
      }}
    >
      {entries.map(({ acc, url, name, isCopyTrade, referral, isActive }) => {
        const activeBorder = isActive
          ? colorAlpha(tokens.colors.accent.primary, 50)
          : tokens.colors.border.primary
        const activeBg = isActive
          ? colorAlpha(tokens.colors.accent.primary, 6)
          : tokens.colors.bg.secondary

        return (
          <Box
            key={`${acc.platform}:${acc.traderKey}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                background: activeBg,
                border: `1px solid ${activeBorder}`,
                textDecoration: 'none',
                transition: 'all 0.2s',
                cursor: 'pointer',
              }}
              onClick={() => {
                // #33: Fire-and-forget click tracking for exchange link analytics.
                // sendTrackingEvent attaches Authorization + CSRF headers (the
                // endpoint authenticates via Bearer token, not cookies) and
                // silently no-ops for anonymous visitors.
                sendTrackingEvent('/api/interactions', {
                  type: 'exchange_link_click',
                  platform: acc.platform,
                  traderKey: acc.traderKey,
                })
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = colorAlpha(tokens.colors.accent.primary, 50)
                e.currentTarget.style.background = colorAlpha(tokens.colors.accent.primary, 6)
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = activeBorder
                e.currentTarget.style.background = activeBg
              }}
            >
              <ExchangeLogo exchange={acc.platform} size={18} />
              <Text
                size="sm"
                weight="bold"
                style={{
                  color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary,
                  whiteSpace: 'nowrap',
                }}
              >
                {isOwnProfile
                  ? t('dexViewOn').replace('{platform}', name)
                  : isCopyTrade
                    ? t('copyTradeOn').replace('{exchange}', name)
                    : t('dexViewOn').replace('{platform}', name)}
              </Text>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>

            {referral && !isOwnProfile && (
              <a
                href={referral.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 10px',
                  borderRadius: tokens.radius.md,
                  background: `${alpha(referral.color, 8)}`,
                  border: `1px solid ${alpha(referral.color, 21)}`,
                  fontSize: 12,
                  fontWeight: 700,
                  color: referral.color,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s',
                }}
                title={`Invite code: ${referral.code}`}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                  aria-hidden="true"
                >
                  <rect x="3" y="8" width="18" height="4" rx="1" />
                  <path d="M12 8v13M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
                </svg>
                {referral.code}
              </a>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
