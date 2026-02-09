'use client'

import { useState, useEffect, useCallback } from 'react'
import type { PipelineOverview, SourceHealth } from '@/lib/utils/pipeline-monitor'
import { tokens } from '@/lib/design-tokens'

// ============================================
// Styles
// ============================================

const styles = {
  container: {
    padding: '24px',
    maxWidth: '1200px',
    margin: '0 auto',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  } as React.CSSProperties,
  title: {
    fontSize: '20px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  overallBadge: (health: number) => ({
    padding: '6px 16px',
    borderRadius: '20px',
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--color-on-accent)',
    backgroundColor: health >= 80 ? 'var(--color-accent-success)' : health >= 50 ? 'var(--color-accent-warning)' : 'var(--color-accent-error)',
  }) as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  } as React.CSSProperties,
  card: (status: string) => ({
    backgroundColor: 'var(--color-bg-secondary)',
    border: `1px solid ${status === 'healthy' ? 'var(--color-accent-success)' : status === 'degraded' ? 'var(--color-score-below)' : 'var(--color-accent-error)'}`,
    borderRadius: tokens.radius.lg,
    padding: '16px',
  }) as React.CSSProperties,
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  } as React.CSSProperties,
  sourceName: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  dot: (status: string) => ({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: status === 'healthy' ? 'var(--color-accent-success)' : status === 'degraded' ? 'var(--color-accent-warning)' : 'var(--color-accent-error)',
    display: 'inline-block',
  }) as React.CSSProperties,
  statsRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '6px',
    fontSize: '13px',
    color: 'var(--color-text-tertiary)',
  } as React.CSSProperties,
  statValue: {
    color: 'var(--color-text-primary)',
    fontWeight: 500,
  } as React.CSSProperties,
  errorSection: {
    marginTop: '24px',
  } as React.CSSProperties,
  errorTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    marginBottom: '12px',
  } as React.CSSProperties,
  errorRow: {
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
    borderRadius: tokens.radius.md,
    padding: '10px 14px',
    marginBottom: '8px',
    fontSize: '13px',
    color: 'var(--color-text-secondary)',
  } as React.CSSProperties,
  refreshBtn: {
    padding: '6px 14px',
    borderRadius: '6px',
    border: '1px solid var(--color-border-secondary)',
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  loading: {
    textAlign: 'center' as const,
    padding: '48px',
    color: 'var(--color-text-tertiary)',
  } as React.CSSProperties,
  tabs: {
    display: 'flex',
    gap: '8px',
    marginBottom: '20px',
  } as React.CSSProperties,
  tab: (active: boolean) => ({
    padding: '6px 14px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: active ? 'var(--color-bg-tertiary)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: active ? 600 : 400,
  }) as React.CSSProperties,
}

// ============================================
// Component
// ============================================

type TabType = 'overview' | 'errors'

export default function PipelineMonitor() {
  const [data, setData] = useState<PipelineOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabType>('overview')
  const [hours, setHours] = useState(24)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const cronSecret = localStorage.getItem('admin_token') || ''
      const res = await fetch(`/api/admin/pipeline?hours=${hours}`, {
        headers: { 'x-admin-token': cronSecret },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || 'Unknown error')
      setData(json.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [hours])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading && !data) {
    return <div style={styles.loading}>Loading pipeline metrics...</div>
  }

  if (error && !data) {
    return (
      <div style={styles.loading}>
        <p style={{ color: 'var(--color-accent-error)' }}>Error: {error}</p>
        <button style={styles.refreshBtn} onClick={fetchData}>Retry</button>
      </div>
    )
  }

  if (!data) return null

  const allErrors = data.sources.flatMap(s =>
    s.recentErrors.map(e => ({ source: s.source, ...e }))
  ).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <span style={styles.title}>Pipeline Monitor</span>
          <span style={{ marginLeft: '12px', ...styles.overallBadge(data.overallHealth) }}>
            {data.overallHealth}%
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            value={hours}
            onChange={e => setHours(Number(e.target.value))}
            style={{ ...styles.refreshBtn, appearance: 'auto' as never }}
          >
            <option value={6}>6h</option>
            <option value={12}>12h</option>
            <option value={24}>24h</option>
            <option value={72}>72h</option>
          </select>
          <button style={styles.refreshBtn} onClick={fetchData}>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        <button style={styles.tab(tab === 'overview')} onClick={() => setTab('overview')}>
          Overview ({data.sources.length})
        </button>
        <button style={styles.tab(tab === 'errors')} onClick={() => setTab('errors')}>
          Errors ({allErrors.length})
        </button>
      </div>

      {/* Overview Tab */}
      {tab === 'overview' && (
        <div style={styles.grid}>
          {data.sources.map((s: SourceHealth) => (
            <SourceCard key={s.source} source={s} />
          ))}
          {data.sources.length === 0 && (
            <div style={styles.loading}>No pipeline metrics yet. Metrics will appear after cron jobs run.</div>
          )}
        </div>
      )}

      {/* Errors Tab */}
      {tab === 'errors' && (
        <div style={styles.errorSection}>
          {allErrors.length === 0 && (
            <div style={{ color: 'var(--color-accent-success)', textAlign: 'center', padding: '24px' }}>
              No errors in the selected time window.
            </div>
          )}
          {allErrors.map((e, i) => (
            <div key={i} style={styles.errorRow}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontWeight: 600, color: 'var(--color-accent-error)' }}>{e.source}</span>
                <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
              <div>{(e.metadata as Record<string, unknown>)?.error as string || 'Unknown error'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceCard({ source }: { source: SourceHealth }) {
  const timeAgo = source.lastFetchAt
    ? formatTimeAgo(new Date(source.lastFetchAt))
    : 'N/A'

  return (
    <div style={styles.card(source.status)}>
      <div style={styles.cardHeader}>
        <span style={styles.sourceName}>{source.source}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', color: 'var(--color-text-tertiary)' }}>{source.healthScore}%</span>
          <span style={styles.dot(source.status)} />
        </div>
      </div>
      <div style={styles.statsRow}>
        <span>Success Rate</span>
        <span style={styles.statValue}>{source.successRate.toFixed(1)}%</span>
      </div>
      <div style={styles.statsRow}>
        <span>Last Fetch</span>
        <span style={styles.statValue}>{timeAgo}</span>
      </div>
      <div style={styles.statsRow}>
        <span>Avg Duration</span>
        <span style={styles.statValue}>{formatDuration(source.avgDuration)}</span>
      </div>
      <div style={styles.statsRow}>
        <span>Records</span>
        <span style={styles.statValue}>{source.totalRecords.toLocaleString()}</span>
      </div>
      {source.recentErrors.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-accent-error)' }}>
          {source.recentErrors.length} recent error(s)
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
