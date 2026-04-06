'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAdminAuth } from '../hooks/useAdminAuth'
import TopNav from '@/app/components/layout/TopNav'
import { tokens } from '@/lib/design-tokens'

// ============================================
// Types
// ============================================

interface PlatformStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageHours: number | null
  recentCount: number
  consecutiveFailures: number
  status: 'healthy' | 'warning' | 'critical'
  routes: {
    configured: string[]
    preferred: string
    default: string
    switched: boolean
    failures: Record<string, number>
  }
}

interface SelfHealData {
  summary: {
    total: number
    healthy: number
    warning: number
    critical: number
    routeSwitches: number
  }
  platforms: PlatformStatus[]
  timestamp: string
}

// ============================================
// Status helpers
// ============================================

function statusColor(status: string): string {
  switch (status) {
    case 'healthy': return 'var(--color-accent-success)'
    case 'warning': return 'var(--color-accent-warning)'
    case 'critical': return 'var(--color-accent-error)'
    default: return 'var(--color-text-tertiary)'
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'healthy': return 'rgba(34, 197, 94, 0.08)'
    case 'warning': return 'rgba(250, 204, 21, 0.08)'
    case 'critical': return 'rgba(239, 68, 68, 0.08)'
    default: return 'transparent'
  }
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'N/A'
  if (hours < 1) return `${Math.round(hours * 60)}m ago`
  if (hours < 24) return `${hours.toFixed(1)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// ============================================
// Styles
// ============================================

const styles = {
  container: {
    minHeight: '100vh',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  inner: {
    padding: '24px',
    maxWidth: '1400px',
    margin: '0 auto',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  } as React.CSSProperties,
  title: {
    fontSize: '22px',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '12px',
    marginBottom: '24px',
  } as React.CSSProperties,
  summaryCard: (color: string) => ({
    backgroundColor: 'var(--color-bg-secondary)',
    border: `1px solid ${color}`,
    borderRadius: tokens.radius.lg,
    padding: '16px',
    textAlign: 'center' as const,
  }),
  summaryValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  summaryLabel: {
    fontSize: '12px',
    color: 'var(--color-text-tertiary)',
    marginTop: '4px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: tokens.radius.lg,
    overflow: 'hidden',
  } as React.CSSProperties,
  th: {
    padding: '12px 16px',
    textAlign: 'left' as const,
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    borderBottom: '1px solid var(--color-border-primary)',
  } as React.CSSProperties,
  td: {
    padding: '10px 16px',
    fontSize: '13px',
    borderBottom: '1px solid var(--color-border-primary)',
  } as React.CSSProperties,
  dot: (status: string) => ({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: statusColor(status),
    display: 'inline-block',
    marginRight: '8px',
  }),
  badge: (color: string) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: 600,
    backgroundColor: color,
    color: '#fff',
  }),
  routeBadge: (switched: boolean) => ({
    display: 'inline-block',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 500,
    backgroundColor: switched ? 'rgba(250, 204, 21, 0.15)' : 'rgba(148, 163, 184, 0.1)',
    color: switched ? 'var(--color-accent-warning)' : 'var(--color-text-tertiary)',
    marginRight: '4px',
  }),
  refreshBtn: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-secondary)',
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  loading: {
    textAlign: 'center' as const,
    padding: '48px',
    color: 'var(--color-text-tertiary)',
  } as React.CSSProperties,
}

// ============================================
// Component
// ============================================

export default function PipelineDashboard() {
  const { email, isAdmin, authChecking } = useAdminAuth()
  const [data, setData] = useState<SelfHealData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'warning' | 'critical'>('all')

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const cronSecret = process.env.NEXT_PUBLIC_CRON_SECRET || ''
      const res = await fetch('/api/admin/pipeline/self-heal', {
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
  }, [])

  useEffect(() => {
    if (isAdmin) {
      fetchData()
      const interval = setInterval(fetchData, 60_000)
      return () => clearInterval(interval)
    }
  }, [isAdmin, fetchData])

  if (authChecking) {
    return <div style={styles.loading}>Verifying permissions...</div>
  }

  if (!isAdmin) {
    return (
      <div style={styles.container}>
        <TopNav email={email} />
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2>Access Denied</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Admin privileges required.</p>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div style={styles.container}>
        <TopNav email={email} />
        <div style={styles.loading}>Loading pipeline dashboard...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={styles.container}>
        <TopNav email={email} />
        <div style={styles.loading}>
          <p style={{ color: 'var(--color-accent-error)' }}>Error: {error}</p>
          <button style={styles.refreshBtn} onClick={fetchData}>Retry</button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const filteredPlatforms = data.platforms.filter(p => {
    if (filter === 'all') return true
    if (filter === 'warning') return p.status === 'warning' || p.status === 'critical'
    return p.status === 'critical'
  })

  return (
    <div style={styles.container}>
      <TopNav email={email} />
      <div style={styles.inner}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <span style={styles.title}>Pipeline Self-Heal Dashboard</span>
            <span style={{ marginLeft: '12px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
              Updated: {new Date(data.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <button style={styles.refreshBtn} onClick={fetchData}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {/* Summary Cards */}
        <div style={styles.summaryGrid}>
          <div style={styles.summaryCard('var(--color-border-primary)')}>
            <div style={styles.summaryValue}>{data.summary.total}</div>
            <div style={styles.summaryLabel}>Total Platforms</div>
          </div>
          <div style={styles.summaryCard('var(--color-accent-success)')}>
            <div style={{ ...styles.summaryValue, color: 'var(--color-accent-success)' }}>{data.summary.healthy}</div>
            <div style={styles.summaryLabel}>Healthy</div>
          </div>
          <div style={styles.summaryCard('var(--color-accent-warning)')}>
            <div style={{ ...styles.summaryValue, color: 'var(--color-accent-warning)' }}>{data.summary.warning}</div>
            <div style={styles.summaryLabel}>Warning</div>
          </div>
          <div style={styles.summaryCard('var(--color-accent-error)')}>
            <div style={{ ...styles.summaryValue, color: 'var(--color-accent-error)' }}>{data.summary.critical}</div>
            <div style={styles.summaryLabel}>Critical</div>
          </div>
          <div style={styles.summaryCard('var(--color-border-secondary)')}>
            <div style={styles.summaryValue}>{data.summary.routeSwitches}</div>
            <div style={styles.summaryLabel}>Route Switches</div>
          </div>
        </div>

        {/* Filter */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {(['all', 'warning', 'critical'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: filter === f ? 'var(--color-bg-tertiary)' : 'transparent',
                color: filter === f ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f === 'all' ? 'All' : f === 'warning' ? 'Warning+' : 'Critical Only'}
            </button>
          ))}
        </div>

        {/* Platform Table */}
        <div style={{ borderRadius: tokens.radius.lg, overflow: 'hidden', border: '1px solid var(--color-border-primary)' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Platform</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Last Update</th>
                <th style={styles.th}>6h Records</th>
                <th style={styles.th}>Failures</th>
                <th style={styles.th}>Route</th>
              </tr>
            </thead>
            <tbody>
              {filteredPlatforms.map((p) => (
                <tr key={p.platform} style={{ backgroundColor: statusBg(p.status) }}>
                  <td style={styles.td}>
                    <span style={styles.dot(p.status)} />
                    <span style={{ fontWeight: 600 }}>{p.displayName}</span>
                    <span style={{ color: 'var(--color-text-tertiary)', fontSize: '11px', marginLeft: '6px' }}>
                      {p.platform}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.badge(statusColor(p.status))}>
                      {p.status.toUpperCase()}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{ color: p.ageHours != null && p.ageHours > 6 ? 'var(--color-accent-warning)' : 'var(--color-text-primary)' }}>
                      {formatAge(p.ageHours)}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontWeight: 500 }}>{p.recentCount}</span>
                  </td>
                  <td style={styles.td}>
                    {p.consecutiveFailures > 0 ? (
                      <span style={{ color: 'var(--color-accent-error)', fontWeight: 600 }}>
                        {p.consecutiveFailures}x
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-text-tertiary)' }}>0</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={styles.routeBadge(p.routes.switched)}>
                      {p.routes.preferred}
                    </span>
                    {p.routes.switched && (
                      <span style={{ fontSize: '10px', color: 'var(--color-accent-warning)' }}>
                        (was: {p.routes.default})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredPlatforms.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--color-text-tertiary)' }}>
            No platforms match the current filter.
          </div>
        )}
      </div>
    </div>
  )
}
