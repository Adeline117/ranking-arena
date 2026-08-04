'use client'

import { useCallback, useEffect, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface PlatformStat {
  platform: string
  total_in_leaderboard: number
  with_equity_curve: number
  with_stats_detail: number
  ec_coverage_pct: number
  sd_coverage_pct: number
}

interface GapSummary {
  source: string
  gap_count: number
}

interface EnrichmentData {
  enrichment_stats: PlatformStat[]
  gap_summary: GapSummary[]
}

function coverageColor(pct: number): string {
  if (pct >= 80) return tokens.colors.sentiment.bull
  if (pct >= 50) return tokens.colors.accent.warning
  return tokens.colors.sentiment.bear
}

export default function EnrichmentCompleteness({ accessToken }: { accessToken: string }) {
  const [data, setData] = useState<EnrichmentData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/monitoring/enrichment-completeness', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // Silent
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <Card>
        <Box style={{ padding: tokens.spacing[4] }}>
          <Text color="tertiary">Loading enrichment data...</Text>
        </Box>
      </Card>
    )
  }

  if (!data) return null

  const { enrichment_stats, gap_summary } = data
  const averageEquityCoverage = enrichment_stats.length
    ? Math.round(
        enrichment_stats.reduce((sum, stat) => sum + stat.ec_coverage_pct, 0) /
          enrichment_stats.length
      )
    : 0
  const averageStatsCoverage = enrichment_stats.length
    ? Math.round(
        enrichment_stats.reduce((sum, stat) => sum + stat.sd_coverage_pct, 0) /
          enrichment_stats.length
      )
    : 0
  const totalGaps = gap_summary.reduce((sum, source) => sum + source.gap_count, 0)

  return (
    <Card>
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          Data Completeness
        </Text>

        {/* Summary row */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: tokens.spacing[3],
            marginBottom: tokens.spacing[4],
          }}
        >
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
            }}
          >
            <Text size="xs" color="tertiary">
              Platforms Tracked
            </Text>
            <Text size="xl" weight="black" style={{ color: tokens.colors.text.primary }}>
              {enrichment_stats.length}
            </Text>
            <Text size="xs" color="tertiary">
              ranked sources
            </Text>
          </Box>
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
            }}
          >
            <Text size="xs" color="tertiary">
              Equity Coverage
            </Text>
            <Text
              size="xl"
              weight="black"
              style={{
                color: coverageColor(averageEquityCoverage),
              }}
            >
              {averageEquityCoverage}%
            </Text>
            <Text size="xs" color="tertiary">
              average by source
            </Text>
          </Box>
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
            }}
          >
            <Text size="xs" color="tertiary">
              Stats Coverage
            </Text>
            <Text size="xl" weight="black" style={{ color: coverageColor(averageStatsCoverage) }}>
              {averageStatsCoverage}%
            </Text>
            <Text size="xs" color="tertiary">
              average by source
            </Text>
          </Box>
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
            }}
          >
            <Text size="xs" color="tertiary">
              Data Gaps
            </Text>
            <Text
              size="xl"
              weight="black"
              style={{
                color: totalGaps > 0 ? tokens.colors.accent.warning : tokens.colors.sentiment.bull,
              }}
            >
              {totalGaps}
            </Text>
            <Text size="xs" color="tertiary">
              older than 48h
            </Text>
          </Box>
        </Box>

        {/* Per-platform table */}
        <Box style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                <th scope="col" style={{ textAlign: 'left', padding: '6px 8px' }}>
                  Platform
                </th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>
                  Leaderboard
                </th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>
                  Equity Curve
                </th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>
                  Stats Detail
                </th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>
                  EC %
                </th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>
                  SD %
                </th>
              </tr>
            </thead>
            <tbody>
              {enrichment_stats.map((s) => (
                <tr
                  key={s.platform}
                  style={{ borderBottom: `1px solid ${alpha(tokens.colors.border.primary, 13)}` }}
                >
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>{s.platform}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    {s.total_in_leaderboard}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{s.with_equity_curve}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{s.with_stats_detail}</td>
                  <td
                    style={{
                      padding: '4px 8px',
                      textAlign: 'right',
                      color: coverageColor(s.ec_coverage_pct),
                      fontWeight: 600,
                    }}
                  >
                    {s.ec_coverage_pct}%
                  </td>
                  <td
                    style={{
                      padding: '4px 8px',
                      textAlign: 'right',
                      color: coverageColor(s.sd_coverage_pct),
                      fontWeight: 600,
                    }}
                  >
                    {s.sd_coverage_pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      </Box>
    </Card>
  )
}
