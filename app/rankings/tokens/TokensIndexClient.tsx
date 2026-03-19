'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

// Well-known tokens with emoji icons for visual appeal
const TOKEN_ICONS: Record<string, string> = {
  BTC: '\u20BF',
  ETH: '\u039E',
  SOL: 'S',
  BNB: 'B',
  XRP: 'X',
  DOGE: 'D',
  ADA: 'A',
  AVAX: 'A',
  DOT: 'D',
  MATIC: 'M',
  LINK: 'L',
  UNI: 'U',
  ARB: 'A',
  OP: 'O',
  APT: 'A',
  SUI: 'S',
  FIL: 'F',
  ATOM: 'A',
  NEAR: 'N',
  INJ: 'I',
  TIA: 'T',
  SEI: 'S',
  JUP: 'J',
  WIF: 'W',
  PEPE: 'P',
  BONK: 'B',
  SHIB: 'S',
  ORDI: 'O',
  STX: 'S',
  TRX: 'T',
  AAVE: 'A',
  MKR: 'M',
  LDO: 'L',
  CRV: 'C',
}

// Featured tokens always displayed at top even if not in popular list
const FEATURED_TOKENS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ARB', 'OP', 'AVAX', 'LINK', 'UNI', 'ADA']

function getTokenColor(token: string): string {
  const colors: Record<string, string> = {
    BTC: '#F7931A',
    ETH: '#627EEA',
    SOL: '#9945FF',
    BNB: '#F3BA2F',
    XRP: '#23292F',
    DOGE: '#C2A633',
    ADA: '#0033AD',
    AVAX: '#E84142',
    DOT: '#E6007A',
    MATIC: '#8247E5',
    LINK: '#2A5ADA',
    UNI: '#FF007A',
    ARB: '#12AAFF',
    OP: '#FF0420',
  }
  return colors[token] || tokens.colors.accent.primary
}

function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

export default function TokensIndexClient() {
  const { t } = useLanguage()
  const [popularTokens, setPopularTokens] = useState<PopularToken[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/rankings/by-token?action=popular-tokens')
      .then(r => r.json())
      .then(data => {
        if (data.tokens) setPopularTokens(data.tokens)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Merge featured tokens with popular tokens
  const allTokens = useMemo(() => {
    const tokenMap = new Map(popularTokens.map(t => [t.token, t]))
    const result: PopularToken[] = []

    // Add featured tokens first (with data if available)
    for (const ft of FEATURED_TOKENS) {
      if (tokenMap.has(ft)) {
        result.push(tokenMap.get(ft)!)
        tokenMap.delete(ft)
      } else {
        result.push({ token: ft, trade_count: 0, trader_count: 0, total_pnl: 0 })
      }
    }

    // Add remaining popular tokens
    for (const [, v] of tokenMap) {
      result.push(v)
    }

    return result
  }, [popularTokens])

  const filtered = useMemo(() => {
    if (!search) return allTokens
    const q = search.toUpperCase()
    return allTokens.filter(t => t.token.includes(q))
  }, [allTokens, search])

  return (
    <Box>
      {/* Header */}
      <Box style={{ marginBottom: 24 }}>
        <Text size="2xl" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: 4 }}>
          {t('tokenRankingsTitle')}
        </Text>
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {t('tokenRankingsSubtitle')}
        </Text>
      </Box>

      {/* Search */}
      <Box style={{ marginBottom: 20 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('tokenRankingsSearchPlaceholder')}
          style={{
            width: '100%',
            maxWidth: 400,
            padding: '10px 16px',
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            fontSize: 14,
            outline: 'none',
            transition: `border-color ${tokens.transition.fast}`,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = tokens.colors.accent.primary }}
          onBlur={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary }}
        />
      </Box>

      {/* Token Grid */}
      {loading ? (
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Box
              key={i}
              style={{
                height: 120,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </Box>
      ) : (
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map((tk) => {
            const color = getTokenColor(tk.token)
            const icon = TOKEN_ICONS[tk.token] || tk.token.charAt(0)
            return (
              <Link
                key={tk.token}
                href={`/rankings/tokens/${tk.token}`}
                style={{ textDecoration: 'none' }}
              >
                <Box
                  style={{
                    padding: '20px',
                    borderRadius: tokens.radius.xl,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    transition: 'all 0.2s',
                    cursor: 'pointer',
                    minHeight: 110,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
                    e.currentTarget.style.borderColor = color + '60'
                    e.currentTarget.style.transform = 'translateY(-2px)'
                    e.currentTarget.style.boxShadow = tokens.shadow.md
                  }}
                  onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
                    e.currentTarget.style.borderColor = tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateY(0)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                >
                  {/* Token Header */}
                  <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Box
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: '50%',
                        background: `${color}20`,
                        border: `1px solid ${color}40`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 18,
                        fontWeight: 700,
                        color,
                        flexShrink: 0,
                      }}
                    >
                      {icon}
                    </Box>
                    <Box style={{ flex: 1 }}>
                      <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
                        {tk.token}
                      </Text>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                        {tk.trader_count > 0 ? `${tk.trader_count} ${t('tokenRankingsTraders')}` : t('tokenRankingsViewRankings')}
                      </Text>
                    </Box>
                  </Box>

                  {/* Stats */}
                  {tk.trade_count > 0 && (
                    <Box style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Box>
                        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>
                          {t('tokenRankingsTrades')}
                        </Text>
                        <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>
                          {tk.trade_count.toLocaleString()}
                        </Text>
                      </Box>
                      <Box>
                        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>
                          {t('tokenRankingsTotalPnl')}
                        </Text>
                        <Text
                          size="base"
                          weight="bold"
                          style={{
                            color: tk.total_pnl >= 0
                              ? tokens.colors.accent.success
                              : tokens.colors.accent.error,
                          }}
                        >
                          {formatPnl(tk.total_pnl)}
                        </Text>
                      </Box>
                    </Box>
                  )}
                </Box>
              </Link>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
