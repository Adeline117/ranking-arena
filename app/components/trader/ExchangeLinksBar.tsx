'use client'

import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCopyTradeUrl, getDexUrl } from '@/lib/utils/copy-trade'

/** Referral config per exchange */
const REFERRAL_LINKS: Record<string, { url: string; code: string; color: string }> = {
  binance: { url: 'https://www.bsmkweb.cc/register?ref=ARENA', code: 'ARENA', color: '#F0B90B' },
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

export default function ExchangeLinksBar({ primary, linkedAccounts, activeAccount, isOwnProfile }: ExchangeLinksBarProps) {
  const { t } = useLanguage()

  // Dedupe: primary + linked, unique by platform+traderKey
  const allAccounts: ExchangeLink[] = [primary]
  if (linkedAccounts) {
    for (const acc of linkedAccounts) {
      if (!allAccounts.some(a => a.platform === acc.platform && a.traderKey === acc.traderKey)) {
        allAccounts.push(acc)
      }
    }
  }

  // Build link entries
  const entries = allAccounts.map(acc => {
    const copyUrl = getCopyTradeUrl(acc.platform, acc.traderKey, acc.handle ?? undefined)
    const dexUrl = getDexUrl(acc.platform, acc.traderKey)
    const url = copyUrl || dexUrl
    if (!url) return null

    const name = EXCHANGE_NAMES[acc.platform.toLowerCase()] || acc.platform
    const isCopyTrade = !!copyUrl
    const referralKey = getReferralKey(acc.platform)
    const referral = referralKey ? REFERRAL_LINKS[referralKey] : null

    // Highlight when this account is the active tab
    const isActive = activeAccount && activeAccount !== 'all'
      ? activeAccount === `${acc.platform}:${acc.traderKey}`
      : acc.platform === primary.platform && acc.traderKey === primary.traderKey

    return { acc, url, name, isCopyTrade, referral, isActive }
  }).filter(Boolean) as Array<{
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
        const activeBorder = isActive ? tokens.colors.accent.primary + '80' : tokens.colors.border.primary
        const activeBg = isActive ? tokens.colors.accent.primary + '10' : tokens.colors.bg.secondary

        return (
          <Box key={`${acc.platform}:${acc.traderKey}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
                // #33: Fire-and-forget click tracking for exchange link analytics
                fetch('/api/interactions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ type: 'exchange_link_click', platform: acc.platform, traderKey: acc.traderKey }),
                }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget: analytics is non-critical
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = tokens.colors.accent.primary + '80'
                e.currentTarget.style.background = tokens.colors.accent.primary + '10'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = activeBorder
                e.currentTarget.style.background = activeBg
              }}
            >
              <ExchangeLogo exchange={acc.platform} size={18} />
              <Text size="sm" weight="bold" style={{ color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary, whiteSpace: 'nowrap' }}>
                {isOwnProfile
                  ? t('dexViewOn').replace('{platform}', name)
                  : isCopyTrade
                    ? t('copyTradeOn').replace('{exchange}', name)
                    : t('dexViewOn').replace('{platform}', name)}
              </Text>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                  background: `${referral.color}15`,
                  border: `1px solid ${referral.color}35`,
                  fontSize: 12,
                  fontWeight: 700,
                  color: referral.color,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s',
                }}
                title={`Invite code: ${referral.code}`}
              >
                <span style={{ fontSize: 11 }}>🎁</span>
                {referral.code}
              </a>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
