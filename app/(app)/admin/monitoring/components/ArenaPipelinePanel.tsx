'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface PipelineRow {
  slug: string
  serving_mode: 'legacy' | 'shadow' | 'serving'
  status: string
  phase: number
  timeframe: number
  last_passed_at: string | null
  actual_count: number | null
  rejects_24h: number
  compat_platform: string | null
  compat_rows: number
}

interface GroupedSource {
  slug: string
  serving_mode: PipelineRow['serving_mode']
  phase: number
  rejects_24h: number
  byTf: Map<number, PipelineRow>
}

function formatAge(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '0m'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

function ageColor(iso: string | null): string {
  if (!iso) return tokens.colors.sentiment.bear
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000
  if (hours <= 12) return tokens.colors.sentiment.bull
  if (hours <= 24) return tokens.colors.accent.warning
  return tokens.colors.sentiment.bear
}

function modeColor(mode: PipelineRow['serving_mode']): string {
  if (mode === 'serving') return tokens.colors.sentiment.bull
  if (mode === 'shadow') return tokens.colors.accent.warning
  return tokens.colors.text.tertiary
}

const TF_LABEL: Record<number, string> = { 0: 'INC', 7: '7D', 30: '30D', 90: '90D' }

export default function ArenaPipelinePanel({ accessToken }: { accessToken: string }) {
  const [rows, setRows] = useState<PipelineRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/monitoring/arena-pipeline', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        setRows(json.rows ?? [])
      }
    } catch {
      // Silent — panel stays in its last state
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    load()
  }, [load])

  const { sources, timeframes } = useMemo(() => {
    const bySlug = new Map<string, GroupedSource>()
    const tfSet = new Set<number>()
    for (const row of rows ?? []) {
      tfSet.add(row.timeframe)
      let g = bySlug.get(row.slug)
      if (!g) {
        g = {
          slug: row.slug,
          serving_mode: row.serving_mode,
          phase: row.phase,
          rejects_24h: row.rejects_24h,
          byTf: new Map(),
        }
        bySlug.set(row.slug, g)
      }
      g.byTf.set(row.timeframe, row)
    }
    return {
      sources: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      timeframes: [...tfSet].sort((a, b) => a - b),
    }
  }, [rows])

  if (loading) {
    return (
      <Card>
        <Box style={{ padding: tokens.spacing[4] }}>
          <Text color="tertiary">Loading arena pipeline data...</Text>
        </Box>
      </Card>
    )
  }

  if (!rows || rows.length === 0) return null

  const cellStyle: React.CSSProperties = {
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    textAlign: 'left',
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
    whiteSpace: 'nowrap',
  }

  return (
    <Card>
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
          Arena Ingest Pipeline
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          Per active source: latest passed snapshot age per timeframe, 24h staging rejects, cutover
          mode, compat trader_latest rows
        </Text>

        <Box style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={cellStyle}>
                  <Text size="xs" color="tertiary" weight="bold">
                    Source
                  </Text>
                </th>
                <th style={cellStyle}>
                  <Text size="xs" color="tertiary" weight="bold">
                    Mode
                  </Text>
                </th>
                {timeframes.map((tf) => (
                  <th key={tf} style={cellStyle}>
                    <Text size="xs" color="tertiary" weight="bold">
                      {TF_LABEL[tf] ?? `${tf}D`}
                    </Text>
                  </th>
                ))}
                <th style={cellStyle}>
                  <Text size="xs" color="tertiary" weight="bold">
                    Rejects 24h
                  </Text>
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.map((src) => (
                <tr key={src.slug}>
                  <td style={cellStyle}>
                    <Text size="sm" weight="medium">
                      {src.slug}
                    </Text>
                    <Text size="xs" color="tertiary">
                      phase {src.phase}
                    </Text>
                  </td>
                  <td style={cellStyle}>
                    <Text size="sm" weight="bold" style={{ color: modeColor(src.serving_mode) }}>
                      {src.serving_mode}
                    </Text>
                  </td>
                  {timeframes.map((tf) => {
                    const cell = src.byTf.get(tf)
                    if (!cell) {
                      return (
                        <td key={tf} style={cellStyle}>
                          <Text size="sm" color="tertiary">
                            —
                          </Text>
                        </td>
                      )
                    }
                    return (
                      <td key={tf} style={cellStyle}>
                        <Text
                          size="sm"
                          weight="bold"
                          style={{ color: ageColor(cell.last_passed_at) }}
                        >
                          {formatAge(cell.last_passed_at)}
                        </Text>
                        <Text size="xs" color="tertiary">
                          {cell.actual_count !== null
                            ? `${cell.actual_count.toLocaleString()} rows`
                            : 'no passed snapshot'}
                          {' · compat '}
                          {cell.compat_rows.toLocaleString()}
                        </Text>
                      </td>
                    )
                  })}
                  <td style={cellStyle}>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{
                        color:
                          src.rejects_24h > 0
                            ? tokens.colors.accent.warning
                            : tokens.colors.sentiment.bull,
                      }}
                    >
                      {src.rejects_24h.toLocaleString()}
                    </Text>
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
