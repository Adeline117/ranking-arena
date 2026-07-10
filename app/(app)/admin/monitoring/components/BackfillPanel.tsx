'use client'

/**
 * BackfillPanel (P1线 2026-07-09) — series-backfill 进度一眼可见。
 *
 * 此前游标进度只能手查 SQL(当天实操痛点)。读 /api/admin/monitoring/backfill
 * (→ arena_backfill_panel RPC):每源游标/带宽进度条 + 最新填充率快照里
 * 覆盖率最低的指标(找缺口用)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'

interface CursorRow {
  slug: string
  cursor: number | null
  topn: number | null
  updated_at: string | null
}
interface FillRow {
  slug: string
  metric: string
  filled: number
  total: number
  taken_on: string
}

function agoLabel(iso: string | null): string {
  if (!iso) return '—'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export default function BackfillPanel({ accessToken }: { accessToken: string }) {
  const [cursors, setCursors] = useState<CursorRow[] | null>(null)
  const [fill, setFill] = useState<FillRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/monitoring/backfill', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        setCursors(json.cursors ?? [])
        setFill(json.fill ?? [])
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

  // Lowest-coverage metrics first — that's what the operator hunts for.
  const worstFill = useMemo(
    () =>
      [...fill]
        .filter((f) => f.total > 50)
        .sort((a, b) => a.filled / a.total - b.filled / b.total)
        .slice(0, 12),
    [fill]
  )

  if (loading) {
    return (
      <div style={{ padding: tokens.spacing[4], color: tokens.colors.text.tertiary }}>
        Loading backfill…
      </div>
    )
  }
  if (!cursors?.length && worstFill.length === 0) return null

  const cell: React.CSSProperties = {
    padding: `${tokens.spacing[1]}px ${tokens.spacing[2]}px`,
    fontSize: tokens.typography.fontSize.sm,
    textAlign: 'left',
  }

  return (
    <section
      style={{
        marginTop: tokens.spacing[5],
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-bg-secondary)',
      }}
    >
      <h3
        style={{
          fontSize: tokens.typography.fontSize.md,
          fontWeight: tokens.typography.fontWeight.semibold,
          marginBottom: tokens.spacing[3],
        }}
      >
        Series Backfill 进度
      </h3>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: tokens.colors.text.tertiary }}>
              <th style={cell}>source</th>
              <th style={cell}>cursor / band</th>
              <th style={cell}>进度</th>
              <th style={cell}>最近推进</th>
            </tr>
          </thead>
          <tbody>
            {(cursors ?? []).map((c) => {
              const pct =
                c.cursor != null && c.topn ? Math.min(100, (c.cursor / c.topn) * 100) : null
              return (
                <tr key={c.slug} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                  <td style={cell}>{c.slug}</td>
                  <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
                    {c.cursor ?? '—'} / {c.topn ?? '—'}
                  </td>
                  <td style={{ ...cell, minWidth: 120 }}>
                    {pct !== null && (
                      <div
                        style={{
                          height: 6,
                          borderRadius: tokens.radius.full,
                          background: 'var(--color-bg-tertiary)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${pct.toFixed(0)}%`,
                            height: '100%',
                            background: tokens.colors.accent.success,
                          }}
                        />
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, color: tokens.colors.text.tertiary }}>
                    {agoLabel(c.updated_at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {worstFill.length > 0 && (
        <>
          <h4
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              margin: `${tokens.spacing[4]}px 0 ${tokens.spacing[2]}px`,
              color: tokens.colors.text.secondary,
            }}
          >
            覆盖率最低指标（最新快照）
          </h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
            {worstFill.map((f) => (
              <span
                key={`${f.slug}:${f.metric}`}
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  padding: `2px ${tokens.spacing[2]}px`,
                  borderRadius: tokens.radius.full,
                  border: '1px solid var(--color-border-subtle)',
                  color: tokens.colors.text.secondary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {f.slug}·{f.metric} {((f.filled / f.total) * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
