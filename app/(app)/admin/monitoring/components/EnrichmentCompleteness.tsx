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

interface DeadLetter {
  key: string
  count: number
  fail_count: number
}

interface EnrichmentData {
  enrichment_stats: PlatformStat[]
  dead_letter_queue: DeadLetter[]
  dead_letter_total: number
  pipeline_24h: {
    total: number
    success: number
    success_rate_pct: number
  }
  heartbeats: Array<{
    platform: string
    source_host: string
    status: string
    trader_count: number
    hours_since: number
    is_stale: boolean
  }>
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

  const { enrichment_stats, dead_letter_queue, dead_letter_total, pipeline_24h, heartbeats } = data

  return (
    <Card>
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          Enrichment Completeness
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
              24h Success Rate
            </Text>
            <Text
              size="xl"
              weight="black"
              style={{ color: coverageColor(pipeline_24h.success_rate_pct) }}
            >
              {pipeline_24h.success_rate_pct}%
            </Text>
            <Text size="xs" color="tertiary">
              {pipeline_24h.success}/{pipeline_24h.total} runs
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
              Dead Letter Queue
            </Text>
            <Text
              size="xl"
              weight="black"
              style={{
                color:
                  dead_letter_total > 0
                    ? tokens.colors.accent.warning
                    : tokens.colors.sentiment.bull,
              }}
            >
              {dead_letter_total}
            </Text>
            <Text size="xs" color="tertiary">
              {dead_letter_queue.length} platforms
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
              Platforms Tracked
            </Text>
            <Text size="xl" weight="black">
              {enrichment_stats.length}
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
              Heartbeats
            </Text>
            <Text
              size="xl"
              weight="black"
              style={{
                color: heartbeats.some((h) => h.is_stale)
                  ? tokens.colors.accent.warning
                  : tokens.colors.sentiment.bull,
              }}
            >
              {heartbeats.filter((h) => !h.is_stale).length}/{heartbeats.length}
            </Text>
            <Text size="xs" color="tertiary">
              fresh / total
            </Text>
          </Box>
        </Box>

        {/* Per-platform table */}
        <Box style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Platform</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Leaderboard</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Equity Curve</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Stats Detail</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>EC %</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>SD %</th>
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

        {/* Dead letter details */}
        {dead_letter_queue.length > 0 && (
          <Box style={{ marginTop: tokens.spacing[4] }}>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              Dead Letter Queue
            </Text>
            {dead_letter_queue.map((d) => (
              <Box
                key={d.key}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}
              >
                <Text size="xs" style={{ fontFamily: 'monospace' }}>
                  {d.key}
                </Text>
                <Text size="xs" color="tertiary">
                  {d.count} traders, {d.fail_count} failures
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Card>
  )
}
