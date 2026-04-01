'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import useSWR from 'swr'
import { Box, Text } from '../base'

interface PlatformStat {
  platform: string
  traderCount: number
}

interface PlatformStatsResponse {
  platforms: PlatformStat[]
}

interface RankPercentileBadgeProps {
  rank: number | null | undefined
  platform: string | undefined
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

// Badge color tiers
function getBadgeStyle(percentile: number): { bg: string; color: string; border: string } {
  if (percentile >= 99) {
    // Top 1% — gold
    return {
      bg: 'rgba(255, 215, 0, 0.12)',
      color: '#FFD700',
      border: 'rgba(255, 215, 0, 0.3)',
    }
  }
  if (percentile >= 95) {
    // Top 5% — silver
    return {
      bg: 'rgba(192, 192, 192, 0.12)',
      color: '#C0C0C0',
      border: 'rgba(192, 192, 192, 0.3)',
    }
  }
  if (percentile >= 90) {
    // Top 10% — bronze
    return {
      bg: 'rgba(205, 127, 50, 0.12)',
      color: '#CD7F32',
      border: 'rgba(205, 127, 50, 0.3)',
    }
  }
  // Default
  return {
    bg: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-secondary)',
    border: 'var(--color-border-primary)',
  }
}

export default function RankPercentileBadge({ rank, platform }: RankPercentileBadgeProps) {
  const { t } = useLanguage()

  // Fetch platform stats to get total trader count
  const { data: statsData } = useSWR<PlatformStatsResponse>(
    '/api/rankings/platform-stats',
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 300_000, errorRetryCount: 1 }
  )

  if (!rank || rank <= 0 || !platform) return null

  // Find total count for this platform
  const platformStat = statsData?.platforms?.find(
    (p) => p.platform.toLowerCase() === platform.toLowerCase()
  )
  if (!platformStat || platformStat.traderCount <= 0) return null

  const percentile = ((1 - rank / platformStat.traderCount) * 100)
  if (percentile <= 0) return null

  const displayPct = percentile >= 99 ? 1 : percentile >= 90 ? Math.round(100 - percentile) : Math.round(100 - percentile)

  // Only show if top 50% or better
  if (displayPct > 50) return null

  const style = getBadgeStyle(percentile)
  const platformName = EXCHANGE_NAMES[platform.toLowerCase()] || platform

  const label = t('topPercentOn')
    .replace('{pct}', String(displayPct))
    .replace('{platform}', platformName)

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: tokens.radius.full,
        background: style.bg,
        border: `1px solid ${style.border}`,
        flexShrink: 0,
      }}
      title={label}
    >
      {/* Trophy icon for top tiers */}
      {percentile >= 90 && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={style.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
        </svg>
      )}
      <Text
        size="xs"
        weight="bold"
        style={{
          color: style.color,
          fontSize: 11,
          letterSpacing: '0.3px',
          whiteSpace: 'nowrap',
        }}
      >
        {t('topPercent').replace('{pct}', String(displayPct))}
      </Text>
    </Box>
  )
}
