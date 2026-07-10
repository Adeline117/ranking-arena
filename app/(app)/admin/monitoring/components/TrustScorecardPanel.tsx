'use client'

/**
 * TrustScorecardPanel (P6 2026-07-10) — 可信度六维进度一眼可见。
 *
 * 读 /api/admin/monitoring/trust-scorecard(→ arena_trust_scorecard RPC):
 * ① 序列覆盖(夜间快照,含日增趋势) ⑥ 链上净覆盖(实时,轮换侵蚀率)
 * ④ 认领数。此前这些要人肉盘 SQL。(bot 帖块随 owner 摘除 bot 发帖而移除)
 */

import { useCallback, useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'

interface SeriesSnap {
  taken_on: string
  payload: {
    serving_total: number
    with_series: number
    top500_total: number
    top500_with_series: number
  }
}
interface OnchainRow {
  slug: string
  serving: number
  enriched: number
  fresh7d: number
}
interface Scorecard {
  series: SeriesSnap[]
  onchain: OnchainRow[]
  claims: { total: number; verified: number; reviewing: number; active_authorizations: number }
  community: { last_bot_post_at: string | null; bot_posts_7d: number }
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—'
}

export default function TrustScorecardPanel({ accessToken }: { accessToken: string }) {
  const [card, setCard] = useState<Scorecard | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/monitoring/trust-scorecard', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        setCard(json.scorecard ?? null)
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

  if (loading) {
    return (
      <div style={{ padding: tokens.spacing[4], color: tokens.colors.text.tertiary }}>
        Loading trust scorecard…
      </div>
    )
  }
  if (!card) return null

  const latest = card.series[0] ?? null
  const prev = card.series[1] ?? null
  const dayDelta = latest && prev ? latest.payload.with_series - prev.payload.with_series : null

  const stat: React.CSSProperties = {
    padding: tokens.spacing[3],
    borderRadius: tokens.radius.md,
    border: '1px solid var(--color-border-subtle)',
    background: 'var(--color-bg-tertiary)',
    minWidth: 150,
    flex: '1 1 150px',
  }
  const statLabel: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.xs,
    color: tokens.colors.text.tertiary,
    display: 'block',
    marginBottom: 2,
  }
  const statValue: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.lg,
    fontWeight: tokens.typography.fontWeight.semibold,
    fontVariantNumeric: 'tabular-nums',
  }
  const statSub: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.xs,
    color: tokens.colors.text.tertiary,
    fontVariantNumeric: 'tabular-nums',
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
        可信度记分卡
      </h3>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        <div style={stat}>
          <span style={statLabel}>序列覆盖（serving 全集）</span>
          <span style={statValue}>
            {latest ? pct(latest.payload.with_series, latest.payload.serving_total) : '—'}
          </span>
          <div style={statSub}>
            {latest
              ? `${latest.payload.with_series.toLocaleString()} / ${latest.payload.serving_total.toLocaleString()}`
              : 'no snapshot yet'}
            {dayDelta != null && ` · 日增 ${dayDelta >= 0 ? '+' : ''}${dayDelta}`}
          </div>
        </div>

        <div style={stat}>
          <span style={statLabel}>序列覆盖（top500）</span>
          <span style={statValue}>
            {latest ? pct(latest.payload.top500_with_series, latest.payload.top500_total) : '—'}
          </span>
          <div style={statSub}>
            {latest ? `${latest.payload.top500_with_series} / ${latest.payload.top500_total}` : ''}
            {latest && ` · ${latest.taken_on}`}
          </div>
        </div>

        {card.onchain.map((o) => (
          <div key={o.slug} style={stat}>
            <span style={statLabel}>链上富化 · {o.slug.replace(/_/g, ' ')}</span>
            <span style={statValue}>{pct(o.enriched, o.serving)}</span>
            <div style={statSub}>
              {o.enriched.toLocaleString()} / {o.serving.toLocaleString()} · 7d鲜{' '}
              {pct(o.fresh7d, o.serving)}
            </div>
          </div>
        ))}

        <div style={stat}>
          <span style={statLabel}>交易员认领</span>
          <span style={statValue}>{card.claims.verified}</span>
          <div style={statSub}>
            待审 {card.claims.reviewing} · 活跃授权 {card.claims.active_authorizations}
          </div>
        </div>

        {/* bot 发帖已被 owner 摘除(2026-07-10「bot帖子删掉」)——恒为 0 的
            块是噪音,不渲染;RPC 字段保留无害。 */}
      </div>
    </section>
  )
}
