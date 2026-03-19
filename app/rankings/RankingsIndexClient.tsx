'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_CONFIG, SOURCES_WITH_DATA, EXCHANGE_SLUG_ALIASES } from '@/lib/constants/exchanges'

interface PlatformStat {
  platform: string
  traderCount: number
  avgScore: number
  avgRoi: number
  medianScore: number
  avgWinRate: number | null
}

type TabType = 'all' | 'cex' | 'dex'

function toSlug(source: string): string {
  for (const [alias, canonical] of Object.entries(EXCHANGE_SLUG_ALIASES)) {
    if (canonical === source && !alias.includes('.')) return alias
  }
  return source
}

function isCex(source: string): boolean {
  const config = EXCHANGE_CONFIG[source as keyof typeof EXCHANGE_CONFIG]
  if (!config) return false
  return config.sourceType === 'futures' || config.sourceType === 'spot'
}

export default function RankingsIndexClient() {
  const { t } = useLanguage()
  const [platforms, setPlatforms] = useState<PlatformStat[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabType>('all')

  useEffect(() => {
    fetch('/api/rankings/platform-stats')
      .then(r => r.json())
      .then(data => { if (data.platforms) setPlatforms(data.platforms) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const allPlatforms = useMemo(() => {
    const statsMap = new Map(platforms.map(p => [p.platform, p]))
    const activeSet = new Set(SOURCES_WITH_DATA as string[])
    const merged: PlatformStat[] = [...platforms]
    for (const source of SOURCES_WITH_DATA) {
      if (!statsMap.has(source)) {
        merged.push({ platform: source, traderCount: 0, avgScore: 0, avgRoi: 0, medianScore: 0, avgWinRate: null })
      }
    }
    return merged.filter(p => activeSet.has(p.platform))
  }, [platforms])

  const filtered = useMemo(() => {
    if (tab === 'all') return allPlatforms
    if (tab === 'cex') return allPlatforms.filter(p => isCex(p.platform))
    return allPlatforms.filter(p => !isCex(p.platform))
  }, [allPlatforms, tab])

  const totalTraders = useMemo(() => allPlatforms.reduce((s, p) => s + p.traderCount, 0), [allPlatforms])
  const cexCount = useMemo(() => allPlatforms.filter(p => isCex(p.platform)).length, [allPlatforms])
  const dexCount = useMemo(() => allPlatforms.filter(p => !isCex(p.platform)).length, [allPlatforms])

  const tabs: { key: TabType; label: string; count: number }[] = [
    { key: 'all', label: t('allExchanges') || 'All', count: allPlatforms.length },
    { key: 'cex', label: 'CEX', count: cexCount },
    { key: 'dex', label: 'DEX', count: dexCount },
  ]

  return (
    <Box>
      <Box style={{ marginBottom: 24 }}>
        <Text size="2xl" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: 4 }}>
          {t('rankings') || 'Rankings'}
        </Text>
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {totalTraders.toLocaleString()} traders across {allPlatforms.length} exchanges
        </Text>
      </Box>
      {/* Token Rankings CTA */}
      <Link href="/rankings/tokens" style={{ textDecoration: 'none', display: 'block', marginBottom: 20 }}>
        <Box
          style={{
            padding: '16px 20px',
            borderRadius: tokens.radius.xl,
            background: `linear-gradient(135deg, ${tokens.colors.accent.primary}10, ${tokens.colors.accent.primary}05)`,
            border: `1px solid ${tokens.colors.accent.primary}30`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            transition: 'all 0.2s',
            cursor: 'pointer',
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
            e.currentTarget.style.borderColor = tokens.colors.accent.primary + '60'
            e.currentTarget.style.transform = 'translateY(-1px)'
          }}
          onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
            e.currentTarget.style.borderColor = tokens.colors.accent.primary + '30'
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          <Box>
            <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: 2 }}>
              {t('tokenRankingsTitle')}
            </Text>
            <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
              {t('tokenRankingsSubtitle')}
            </Text>
          </Box>
          <Text size="lg" style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>
            &rarr;
          </Text>
        </Box>
      </Link>
      <Box style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {tabs.map(({ key, label, count }) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '8px 16px', borderRadius: tokens.radius.lg,
            border: `1px solid ${tab === key ? tokens.colors.accent.primary + '80' : tokens.colors.border.primary}`,
            background: tab === key ? tokens.colors.accent.primary + '15' : tokens.colors.bg.secondary,
            color: tab === key ? tokens.colors.accent.primary : tokens.colors.text.secondary,
            fontWeight: tab === key ? 600 : 400, fontSize: 14, cursor: 'pointer',
            transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{ fontSize: 12, opacity: 0.7,
              background: tab === key ? tokens.colors.accent.primary + '20' : tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.full, padding: '2px 8px',
            }}>{count}</span>
          </button>
        ))}
      </Box>
      {loading ? (
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Box key={i} style={{ height: 140, borderRadius: tokens.radius.xl, background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`, animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </Box>
      ) : (
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {filtered.map(p => {
            const config = EXCHANGE_CONFIG[p.platform as keyof typeof EXCHANGE_CONFIG]
            const name = config?.name || p.platform
            const slug = toSlug(p.platform)
            const sourceType = config?.sourceType || 'futures'
            const typeLabel = sourceType === 'futures' ? 'Futures' : sourceType === 'spot' ? 'Spot' : 'On-Chain'
            return (
              <Link key={p.platform} href={`/rankings/${slug}`} style={{ textDecoration: 'none' }}>
                <Box style={{ padding: '20px', borderRadius: tokens.radius.xl, background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`, transition: 'all 0.2s', cursor: 'pointer', minHeight: 130, display: 'flex', flexDirection: 'column', gap: 14 }}
                  onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.borderColor = tokens.colors.accent.primary + '60'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = tokens.shadow.md }}
                  onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.borderColor = tokens.colors.border.primary; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <ExchangeLogo exchange={p.platform} size={36} />
                    <Box style={{ flex: 1 }}>
                      <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>{name}</Text>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>{typeLabel}</Text>
                    </Box>
                    <Box style={{ padding: '3px 10px', borderRadius: tokens.radius.full, background: isCex(p.platform) ? tokens.colors.accent.primary + '15' : tokens.colors.accent.success + '15', border: `1px solid ${isCex(p.platform) ? tokens.colors.accent.primary + '30' : tokens.colors.accent.success + '30'}` }}>
                      <Text size="xs" weight="semibold" style={{ color: isCex(p.platform) ? tokens.colors.accent.primary : tokens.colors.accent.success }}>{isCex(p.platform) ? 'CEX' : 'DEX'}</Text>
                    </Box>
                  </Box>
                  <Box style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <Box>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>Traders</Text>
                      <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>{p.traderCount > 0 ? p.traderCount.toLocaleString() : '-'}</Text>
                    </Box>
                    <Box>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>Avg Score</Text>
                      <Text size="base" weight="bold" style={{ color: tokens.colors.accent.primary }}>{p.avgScore > 0 ? p.avgScore.toFixed(1) : '-'}</Text>
                    </Box>
                    <Box>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>Avg ROI</Text>
                      <Text size="base" weight="bold" style={{ color: p.avgRoi > 0 ? tokens.colors.sentiment.bull : p.avgRoi < 0 ? tokens.colors.sentiment.bear : tokens.colors.text.secondary }}>
                        {p.avgRoi !== 0 ? `${p.avgRoi > 0 ? '+' : ''}${p.avgRoi.toFixed(1)}%` : '-'}
                      </Text>
                    </Box>
                    {p.avgWinRate != null && p.avgWinRate > 0 && (
                      <Box>
                        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}>Avg Win Rate</Text>
                        <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>{p.avgWinRate.toFixed(1)}%</Text>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Link>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
