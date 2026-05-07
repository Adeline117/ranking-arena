'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useQuery } from '@tanstack/react-query'
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

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`)
    return r.json()
  })

// Badge color tiers — use design tokens for medal colors
function getBadgeStyle(percentile: number): { bg: string; color: string; border: string } {
  if (percentile >= 99) {
    // Top 1% — gold
    const gold = tokens.colors.medal.gold
    return {
      bg: `color-mix(in srgb, ${gold} 12%, transparent)`,
      color: gold,
      border: `color-mix(in srgb, ${gold} 30%, transparent)`,
    }
  }
  if (percentile >= 95) {
    // Top 5% — silver
    const silver = tokens.colors.medal.silver
    return {
      bg: `color-mix(in srgb, ${silver} 12%, transparent)`,
      color: silver,
      border: `color-mix(in srgb, ${silver} 30%, transparent)`,
    }
  }
  if (percentile >= 90) {
    // Top 10% — bronze
    const bronze = tokens.colors.medal.bronze
    return {
      bg: `color-mix(in srgb, ${bronze} 12%, transparent)`,
      color: bronze,
      border: `color-mix(in srgb, ${bronze} 30%, transparent)`,
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
  const { data: statsData } = useQuery<PlatformStatsResponse>({
    queryKey: ['rankings-platform-stats'],
    queryFn: () => fetcher('/api/rankings/platform-stats'),
    refetchOnWindowFocus: false,
    staleTime: 300_000,
    retry: 1,
  })

  if (!rank || rank <= 0 || !platform) return null

  // Find total count for this platform
  const platformStat = statsData?.platforms?.find(
    (p) => p.platform.toLowerCase() === platform.toLowerCase()
  )
  if (!platformStat || platformStat.traderCount <= 0) return null

  const percentile = (1 - rank / platformStat.traderCount) * 100
  if (percentile <= 0) return null

  const displayPct =
    percentile >= 99
      ? 1
      : percentile >= 90
        ? Math.round(100 - percentile)
        : Math.round(100 - percentile)

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
      role="img"
      aria-label={label}
      title={label}
    >
      {/* Trophy icon for top tiers */}
      {percentile >= 90 && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke={style.color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
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
