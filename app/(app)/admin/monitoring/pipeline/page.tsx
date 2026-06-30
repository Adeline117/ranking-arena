'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAdminAuth } from '../../hooks/useAdminAuth'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

// ============================================
// Types
// ============================================

interface JobStat {
  job_name: string
  total_runs: number
  success_count: number
  error_count: number
  success_rate: number
  avg_duration_ms: number
  last_run_at: string
}

interface PlatformHealth {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageHours: number | null
  currentCount: number
  avgCount: number | null
  countRatio: number | null
  status: 'healthy' | 'warning' | 'critical'
}

interface RecentFailure {
  job_name: string
  started_at: string
  error_message: string | null
  metadata: Record<string, unknown>
}

interface EnrichmentPlatform {
  platform: string
  totalTraders: number
  enrichedTraders: number
  coveragePct: number
  hasEnrichmentConfig: boolean
  isNoEnrichment: boolean
  lastEnrichmentAt: string | null
}

interface EnrichmentData {
  ok: boolean
  period: string
  summary: {
    totalPlatforms: number
    enrichablePlatforms: number
    noEnrichmentPlatforms: number
    totalTraders: number
    totalEnriched: number
    overallCoveragePct: number
    enrichableCoveragePct: number
  }
  platforms: EnrichmentPlatform[]
}

interface PipelineData {
  status: string
  timestamp: string
  summary: {
    totalJobs: number
    healthyJobs: number
    failedJobs: number
    staleJobs: number
    stuckJobs: number
    avgSuccessRate7d: number
    platformHealthy: number
    platformWarning: number
    platformCritical: number
    totalPlatforms: number
  }
  platformHealth: PlatformHealth[]
  stats: JobStat[]
  recentFailures: RecentFailure[]
}

type TabId = 'overview' | 'jobs' | 'freshness' | 'failures' | 'enrichment'

// ============================================
// Helpers
// ============================================

function statusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'var(--color-accent-success)'
    case 'warning':
      return 'var(--color-accent-warning)'
    case 'critical':
    case 'degraded':
      return 'var(--color-accent-error)'
    default:
      return 'var(--color-text-tertiary)'
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'healthy':
      return 'rgba(34, 197, 94, 0.08)'
    case 'warning':
      return 'rgba(250, 204, 21, 0.08)'
    case 'critical':
    case 'degraded':
      return 'rgba(239, 68, 68, 0.08)'
    default:
      return 'transparent'
  }
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'N/A'
  if (hours < 1) return `${Math.round(hours * 60)}m ago`
  if (hours < 24) return `${hours.toFixed(1)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatTime(iso: string | null): string {
  if (!iso) return 'N/A'
  return new Date(iso).toLocaleString()
}

function successRateColor(rate: number): string {
  if (rate >= 90) return 'var(--color-accent-success)'
  if (rate >= 70) return 'var(--color-accent-warning)'
  return 'var(--color-accent-error)'
}

function coverageColor(pct: number): string {
  if (pct >= 80) return 'var(--color-accent-success)'
  if (pct >= 50) return 'var(--color-accent-warning)'
  if (pct > 0) return 'var(--color-accent-error)'
  return 'var(--color-text-tertiary)'
}

// ============================================
// Styles
// ============================================

const sty = {
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
  } as React.CSSProperties,
  subtitle: {
    fontSize: '13px',
    color: 'var(--color-text-tertiary)',
    marginTop: '4px',
  } as React.CSSProperties,
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
    marginBottom: '24px',
  } as React.CSSProperties,
  card: (borderColor: string) => ({
    backgroundColor: 'var(--color-bg-secondary)',
    border: `1px solid ${borderColor}`,
    borderRadius: tokens.radius.lg,
    padding: '16px',
    textAlign: 'center' as const,
  }),
  cardValue: {
    fontSize: '28px',
    fontWeight: 700,
  } as React.CSSProperties,
  cardLabel: {
    fontSize: '11px',
    color: 'var(--color-text-tertiary)',
    marginTop: '4px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  tabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '20px',
    borderBottom: '1px solid var(--color-border-primary)',
    paddingBottom: '0',
  } as React.CSSProperties,
  tab: (active: boolean) =>
    ({
      padding: '10px 18px',
      fontSize: '13px',
      fontWeight: active ? 600 : 400,
      color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
      backgroundColor: 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
      cursor: 'pointer',
      marginBottom: '-1px',
    }) as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: tokens.radius.lg,
    overflow: 'hidden',
  } as React.CSSProperties,
  th: {
    padding: '10px 14px',
    textAlign: 'left' as const,
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    borderBottom: '1px solid var(--color-border-primary)',
  } as React.CSSProperties,
  td: {
    padding: '8px 14px',
    fontSize: '13px',
    borderBottom: '1px solid var(--color-border-primary)',
  } as React.CSSProperties,
  dot: (status: string) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: statusColor(status),
    display: 'inline-block',
    marginRight: '6px',
  }),
  badge: (color: string) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: 600,
    backgroundColor: color,
    color: tokens.colors.white,
  }),
  barContainer: {
    width: '100%',
    height: '6px',
    borderRadius: '3px',
    backgroundColor: 'var(--color-bg-tertiary)',
    overflow: 'hidden' as const,
    position: 'relative' as const,
  } as React.CSSProperties,
  barFill: (pct: number, color: string) => ({
    width: `${Math.min(100, pct)}%`,
    height: '100%',
    borderRadius: '3px',
    backgroundColor: color,
    transition: 'width 0.3s',
  }),
  btn: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-secondary)',
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  autoLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: 'var(--color-text-tertiary)',
    cursor: 'pointer',
  } as React.CSSProperties,
  loading: {
    textAlign: 'center' as const,
    padding: '48px',
    color: 'var(--color-text-tertiary)',
  } as React.CSSProperties,
  errorBox: {
    padding: '12px 16px',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    borderRadius: tokens.radius.lg,
    marginBottom: '16px',
    fontSize: '13px',
    color: 'var(--color-accent-error)',
  } as React.CSSProperties,
}

// ============================================
// Component
// ============================================

export default function PipelineMonitoringDashboard() {
  const { t } = useLanguage()
  const { email, accessToken, isAdmin, authChecking } = useAdminAuth()
  const [pipelineData, setPipelineData] = useState<PipelineData | null>(null)
  const [enrichmentData, setEnrichmentData] = useState<EnrichmentData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchData = useCallback(async () => {
    if (!accessToken) return
    try {
      setLoading(true)

      const [pipelineRes, enrichmentRes] = await Promise.all([
        fetch('/api/health/pipeline', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        fetch('/api/health/enrichment?period=90D', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ])

      if (!pipelineRes.ok) throw new Error(`Pipeline API: ${pipelineRes.status}`)

      const pData = await pipelineRes.json()
      setPipelineData(pData)

      if (enrichmentRes.ok) {
        const eData = await enrichmentRes.json()
        setEnrichmentData(eData)
      }

      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    if (isAdmin && accessToken) fetchData()
  }, [isAdmin, accessToken, fetchData])

  // Auto-refresh every 60s
  useEffect(() => {
    if (!autoRefresh || !isAdmin) return
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [autoRefresh, isAdmin, fetchData])

  if (authChecking) {
    return <div style={sty.loading}>{t('verifyingPermission')}</div>
  }

  if (!isAdmin) {
    return (
      <div style={sty.container}>
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h1>{t('noPermissionAccess')}</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{t('adminPrivilegesRequired')}</p>
        </div>
      </div>
    )
  }

  if (loading && !pipelineData) {
    return (
      <div style={sty.container}>
        <div style={sty.loading}>{t('loadingPipelineMonitoring')}</div>
      </div>
    )
  }

  const d = pipelineData

  return (
    <div style={sty.container}>
      <div style={sty.inner}>
        {/* Header */}
        <div style={sty.header}>
          <div>
            <h1 style={sty.title}>{t('pipelineHealthMonitor')}</h1>
            <div style={sty.subtitle}>
              {d
                ? t('pipelineStatusUpdated')
                    .replace('{status}', d.status.toUpperCase())
                    .replace('{time}', new Date(d.timestamp).toLocaleTimeString())
                : t('loading')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <label style={sty.autoLabel}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              {t('autoRefreshInterval').replace('{n}', '60')}
            </label>
            <button style={sty.btn} onClick={fetchData}>
              {loading ? t('refreshing') : t('refresh')}
            </button>
          </div>
        </div>

        {error && <div style={sty.errorBox}>{error}</div>}

        {/* Summary Cards */}
        {d && (
          <div style={sty.summaryGrid}>
            <div style={sty.card('var(--color-border-primary)')}>
              <div style={{ ...sty.cardValue, color: statusColor(d.status) }}>
                {d.summary.avgSuccessRate7d}%
              </div>
              <div style={sty.cardLabel}>{t('successRate7d')}</div>
            </div>
            <div style={sty.card('var(--color-accent-success)')}>
              <div style={{ ...sty.cardValue, color: 'var(--color-accent-success)' }}>
                {d.summary.healthyJobs}
              </div>
              <div style={sty.cardLabel}>{t('healthyJobs')}</div>
            </div>
            <div style={sty.card('var(--color-accent-error)')}>
              <div
                style={{
                  ...sty.cardValue,
                  color:
                    d.summary.failedJobs > 0
                      ? 'var(--color-accent-error)'
                      : 'var(--color-text-primary)',
                }}
              >
                {d.summary.failedJobs}
              </div>
              <div style={sty.cardLabel}>{t('failedJobs')}</div>
            </div>
            <div style={sty.card('var(--color-accent-warning)')}>
              <div
                style={{
                  ...sty.cardValue,
                  color:
                    d.summary.staleJobs > 0
                      ? 'var(--color-accent-warning)'
                      : 'var(--color-text-primary)',
                }}
              >
                {d.summary.staleJobs}
              </div>
              <div style={sty.cardLabel}>{t('staleJobs')}</div>
            </div>
            <div style={sty.card('var(--color-border-primary)')}>
              <div style={sty.cardValue}>{d.summary.totalPlatforms}</div>
              <div style={sty.cardLabel}>{t('platforms')}</div>
            </div>
            {enrichmentData && (
              <div style={sty.card('var(--color-border-secondary)')}>
                <div
                  style={{
                    ...sty.cardValue,
                    color: coverageColor(enrichmentData.summary.enrichableCoveragePct),
                  }}
                >
                  {enrichmentData.summary.enrichableCoveragePct}%
                </div>
                <div style={sty.cardLabel}>{t('enrichmentCoverage')}</div>
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div style={sty.tabs} role="tablist" aria-label="Pipeline monitoring sections">
          {(
            [
              ['overview', t('tabOverview')],
              ['jobs', t('tabJobStats')],
              ['freshness', t('tabDataFreshness')],
              ['failures', t('tabRecentFailures')],
              ['enrichment', t('tabEnrichment')],
            ] as [TabId, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              style={sty.tab(activeTab === id)}
              onClick={() => setActiveTab(id)}
            >
              {label}
              {id === 'failures' && d && d.recentFailures.length > 0 && (
                <span
                  style={{
                    marginLeft: '6px',
                    padding: '1px 6px',
                    borderRadius: '8px',
                    fontSize: '10px',
                    fontWeight: 600,
                    backgroundColor: 'var(--color-accent-error)',
                    color: tokens.colors.white,
                  }}
                >
                  {d.recentFailures.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'overview' && d && <OverviewTab data={d} enrichment={enrichmentData} />}
        {activeTab === 'jobs' && d && <JobStatsTab stats={d.stats} />}
        {activeTab === 'freshness' && d && <FreshnessTab platforms={d.platformHealth} />}
        {activeTab === 'failures' && d && <FailuresTab failures={d.recentFailures} />}
        {activeTab === 'enrichment' && <EnrichmentTab data={enrichmentData} />}
      </div>
    </div>
  )
}

// ============================================
// Tab: Overview
// ============================================

function OverviewTab({
  data,
  enrichment,
}: {
  data: PipelineData
  enrichment: EnrichmentData | null
}) {
  const { t } = useLanguage()
  const healthyPct =
    data.summary.totalPlatforms > 0
      ? Math.round((data.summary.platformHealthy / data.summary.totalPlatforms) * 100)
      : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Platform health breakdown */}
      <div
        style={{
          backgroundColor: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          padding: '20px',
          border: '1px solid var(--color-border-primary)',
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>
          {t('platformHealth')}
        </div>
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
          <div>
            <span
              style={{ fontSize: '24px', fontWeight: 700, color: 'var(--color-accent-success)' }}
            >
              {data.summary.platformHealthy}
            </span>
            <span
              style={{ color: 'var(--color-text-tertiary)', marginLeft: '6px', fontSize: '13px' }}
            >
              {t('statusHealthyLower')}
            </span>
          </div>
          <div>
            <span
              style={{ fontSize: '24px', fontWeight: 700, color: 'var(--color-accent-warning)' }}
            >
              {data.summary.platformWarning}
            </span>
            <span
              style={{ color: 'var(--color-text-tertiary)', marginLeft: '6px', fontSize: '13px' }}
            >
              {t('statusWarningLower')}
            </span>
          </div>
          <div>
            <span style={{ fontSize: '24px', fontWeight: 700, color: 'var(--color-accent-error)' }}>
              {data.summary.platformCritical}
            </span>
            <span
              style={{ color: 'var(--color-text-tertiary)', marginLeft: '6px', fontSize: '13px' }}
            >
              {t('statusCriticalLower')}
            </span>
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <div style={sty.barContainer}>
            <div style={sty.barFill(healthyPct, 'var(--color-accent-success)')} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
            {t('pctPlatformsHealthy').replace('{n}', String(healthyPct))}
          </div>
        </div>
      </div>

      {/* Top failing jobs */}
      {data.stats.filter((j) => j.error_count > 0).length > 0 && (
        <div
          style={{
            backgroundColor: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.lg,
            padding: '20px',
            border: '1px solid var(--color-border-primary)',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
            {t('jobsWithErrors7d')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {data.stats
              .filter((j) => j.error_count > 0)
              .sort((a, b) => b.error_count - a.error_count)
              .slice(0, 8)
              .map((j) => (
                <div
                  key={j.job_name}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 0',
                  }}
                >
                  <span style={{ fontSize: '13px', fontWeight: 500 }}>{j.job_name}</span>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--color-accent-error)' }}>
                      {t('nErrors').replace('{n}', String(j.error_count))}
                    </span>
                    <span style={{ fontSize: '12px', color: successRateColor(j.success_rate) }}>
                      {j.success_rate}%
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Enrichment summary */}
      {enrichment && (
        <div
          style={{
            backgroundColor: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.lg,
            padding: '20px',
            border: '1px solid var(--color-border-primary)',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
            {t('enrichmentCoverage90d')}
          </div>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <div>
              <span style={{ fontSize: '24px', fontWeight: 700 }}>
                {enrichment.summary.totalEnriched.toLocaleString()}
              </span>
              <span
                style={{ color: 'var(--color-text-tertiary)', marginLeft: '6px', fontSize: '13px' }}
              >
                {t('tradersEnrichedSuffix').replace(
                  '{n}',
                  enrichment.summary.totalTraders.toLocaleString()
                )}
              </span>
            </div>
            <div>
              <span
                style={{
                  fontSize: '24px',
                  fontWeight: 700,
                  color: coverageColor(enrichment.summary.enrichableCoveragePct),
                }}
              >
                {enrichment.summary.enrichableCoveragePct}%
              </span>
              <span
                style={{ color: 'var(--color-text-tertiary)', marginLeft: '6px', fontSize: '13px' }}
              >
                {t('enrichableCoverageLower')}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// Tab: Job Stats
// ============================================

function JobStatsTab({ stats }: { stats: JobStat[] }) {
  const { t } = useLanguage()
  const [sortField, setSortField] = useState<
    'job_name' | 'success_rate' | 'error_count' | 'last_run_at'
  >('success_rate')
  const [sortAsc, setSortAsc] = useState(false)

  const sorted = [...stats].sort((a, b) => {
    const av = a[sortField]
    const bv = b[sortField]
    if (typeof av === 'string' && typeof bv === 'string')
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortAsc(!sortAsc)
    else {
      setSortField(field)
      setSortAsc(false)
    }
  }

  const thSortable = (label: string, field: typeof sortField) => (
    <th
      scope="col"
      tabIndex={0}
      aria-sort={sortField === field ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      style={{ ...sty.th, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => toggleSort(field)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleSort(field)
        }
      }}
    >
      {label} {sortField === field ? (sortAsc ? '▲' : '▼') : ''}
    </th>
  )

  return (
    <div
      style={{
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
        border: '1px solid var(--color-border-primary)',
      }}
    >
      <table style={sty.table}>
        <thead>
          <tr>
            {thSortable(t('colJobName'), 'job_name')}
            <th scope="col" style={sty.th}>
              {t('colRuns7d')}
            </th>
            {thSortable(t('colSuccessRate'), 'success_rate')}
            {thSortable(t('colErrors'), 'error_count')}
            <th scope="col" style={sty.th}>
              {t('colAvgDuration')}
            </th>
            {thSortable(t('colLastRun'), 'last_run_at')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((j) => (
            <tr key={j.job_name}>
              <td style={sty.td}>
                <span style={{ fontWeight: 500 }}>{j.job_name}</span>
              </td>
              <td style={sty.td}>{j.total_runs}</td>
              <td style={sty.td}>
                <span style={{ color: successRateColor(j.success_rate), fontWeight: 600 }}>
                  {j.success_rate}%
                </span>
                <div style={sty.barContainer}>
                  <div style={sty.barFill(j.success_rate, successRateColor(j.success_rate))} />
                </div>
              </td>
              <td style={sty.td}>
                <span
                  style={{
                    color:
                      j.error_count > 0
                        ? 'var(--color-accent-error)'
                        : 'var(--color-text-tertiary)',
                    fontWeight: j.error_count > 0 ? 600 : 400,
                  }}
                >
                  {j.error_count}
                </span>
              </td>
              <td style={sty.td}>{formatDuration(j.avg_duration_ms)}</td>
              <td style={sty.td}>
                <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  {formatTime(j.last_run_at)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--color-text-tertiary)' }}>
          {t('noJobStats')}
        </div>
      )}
    </div>
  )
}

// ============================================
// Tab: Data Freshness
// ============================================

function FreshnessTab({ platforms }: { platforms: PlatformHealth[] }) {
  const { t } = useLanguage()
  const [filter, setFilter] = useState<'all' | 'warning' | 'critical'>('all')

  const filtered = platforms.filter((p) => {
    if (filter === 'all') return true
    if (filter === 'warning') return p.status === 'warning' || p.status === 'critical'
    return p.status === 'critical'
  })

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {(['all', 'warning', 'critical'] as const).map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
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
            {f === 'all'
              ? t('filterAll').replace('{n}', String(platforms.length))
              : f === 'warning'
                ? t('filterWarningPlus').replace(
                    '{n}',
                    String(platforms.filter((p) => p.status !== 'healthy').length)
                  )
                : t('filterCritical').replace(
                    '{n}',
                    String(platforms.filter((p) => p.status === 'critical').length)
                  )}
          </button>
        ))}
      </div>

      <div
        style={{
          borderRadius: tokens.radius.lg,
          overflow: 'hidden',
          border: '1px solid var(--color-border-primary)',
        }}
      >
        <table style={sty.table}>
          <thead>
            <tr>
              <th scope="col" style={sty.th}>
                {t('colPlatform')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colStatus')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colLastUpdate')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colAge')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colRecentCount')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colAvgCount')}
              </th>
              <th scope="col" style={sty.th}>
                {t('colRatio')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.platform} style={{ backgroundColor: statusBg(p.status) }}>
                <td style={sty.td}>
                  <span style={sty.dot(p.status)} aria-hidden="true" />
                  <span style={{ fontWeight: 600 }}>{p.displayName}</span>
                  <span
                    style={{
                      color: 'var(--color-text-tertiary)',
                      fontSize: '11px',
                      marginLeft: '6px',
                    }}
                  >
                    {p.platform}
                  </span>
                </td>
                <td style={sty.td}>
                  <span style={sty.badge(statusColor(p.status))}>{p.status.toUpperCase()}</span>
                </td>
                <td style={sty.td}>
                  <span style={{ fontSize: '12px' }}>{formatTime(p.lastUpdate)}</span>
                </td>
                <td style={sty.td}>
                  <span
                    style={{
                      color:
                        p.ageHours != null && p.ageHours > 6
                          ? 'var(--color-accent-warning)'
                          : 'var(--color-text-primary)',
                    }}
                  >
                    {formatAge(p.ageHours)}
                  </span>
                </td>
                <td style={sty.td}>{p.currentCount}</td>
                <td style={sty.td}>{p.avgCount ?? 'N/A'}</td>
                <td style={sty.td}>
                  <span
                    style={{
                      color:
                        p.countRatio != null && p.countRatio < 0.5
                          ? 'var(--color-accent-warning)'
                          : 'var(--color-text-primary)',
                      fontWeight: 500,
                    }}
                  >
                    {p.countRatio != null ? `${(p.countRatio * 100).toFixed(0)}%` : 'N/A'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============================================
// Tab: Recent Failures
// ============================================

function FailuresTab({ failures }: { failures: RecentFailure[] }) {
  const { t } = useLanguage()
  if (failures.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px', color: 'var(--color-text-tertiary)' }}>
        {t('noRecentFailures')}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {failures.map((f, i) => (
        <div
          key={`${f.job_name}-${f.started_at}-${i}`}
          style={{
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            borderRadius: tokens.radius.lg,
            padding: '14px 18px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '6px',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: '14px' }}>{f.job_name}</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
              {formatTime(f.started_at)}
            </span>
          </div>
          {f.error_message && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--color-accent-error)',
                fontFamily: 'monospace',
                backgroundColor: 'rgba(239, 68, 68, 0.05)',
                padding: '8px 10px',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: '120px',
                overflow: 'auto',
              }}
            >
              {f.error_message}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================
// Tab: Enrichment
// ============================================

function EnrichmentTab({ data }: { data: EnrichmentData | null }) {
  const { t } = useLanguage()
  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: '48px', color: 'var(--color-text-tertiary)' }}>
        {t('enrichmentDataUnavailable')}
      </div>
    )
  }

  // Separate enrichable from non-enrichable
  const enrichable = data.platforms.filter((p) => p.hasEnrichmentConfig && !p.isNoEnrichment)
  const noEnrich = data.platforms.filter((p) => p.isNoEnrichment)
  const noConfig = data.platforms.filter((p) => !p.hasEnrichmentConfig && !p.isNoEnrichment)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Summary */}
      <div style={sty.summaryGrid}>
        <div style={sty.card('var(--color-border-primary)')}>
          <div style={sty.cardValue}>{data.summary.totalTraders.toLocaleString()}</div>
          <div style={sty.cardLabel}>{t('totalTraders')}</div>
        </div>
        <div style={sty.card('var(--color-accent-success)')}>
          <div style={{ ...sty.cardValue, color: 'var(--color-accent-success)' }}>
            {data.summary.totalEnriched.toLocaleString()}
          </div>
          <div style={sty.cardLabel}>{t('enriched')}</div>
        </div>
        <div style={sty.card('var(--color-border-secondary)')}>
          <div style={{ ...sty.cardValue, color: coverageColor(data.summary.overallCoveragePct) }}>
            {data.summary.overallCoveragePct}%
          </div>
          <div style={sty.cardLabel}>{t('overallCoverage')}</div>
        </div>
        <div style={sty.card('var(--color-border-secondary)')}>
          <div
            style={{ ...sty.cardValue, color: coverageColor(data.summary.enrichableCoveragePct) }}
          >
            {data.summary.enrichableCoveragePct}%
          </div>
          <div style={sty.cardLabel}>{t('enrichableCoverageLabel')}</div>
        </div>
        <div style={sty.card('var(--color-border-primary)')}>
          <div style={sty.cardValue}>{data.summary.enrichablePlatforms}</div>
          <div style={sty.cardLabel}>{t('enrichablePlatformsLabel')}</div>
        </div>
        <div style={sty.card('var(--color-border-primary)')}>
          <div style={sty.cardValue}>{data.summary.noEnrichmentPlatforms}</div>
          <div style={sty.cardLabel}>{t('noEnrichmentApi')}</div>
        </div>
      </div>

      {/* Enrichable platforms table */}
      <div>
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
          {t('enrichablePlatformsCount').replace('{n}', String(enrichable.length))}
        </div>
        <div
          style={{
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
            border: '1px solid var(--color-border-primary)',
          }}
        >
          <table style={sty.table}>
            <thead>
              <tr>
                <th scope="col" style={sty.th}>
                  {t('colPlatform')}
                </th>
                <th scope="col" style={sty.th}>
                  {t('totalTraders')}
                </th>
                <th scope="col" style={sty.th}>
                  {t('enriched')}
                </th>
                <th scope="col" style={sty.th}>
                  {t('colCoverage')}
                </th>
                <th scope="col" style={sty.th}>
                  {t('colLastEnrichment')}
                </th>
              </tr>
            </thead>
            <tbody>
              {enrichable
                .sort((a, b) => a.coveragePct - b.coveragePct)
                .map((p) => (
                  <tr key={p.platform}>
                    <td style={sty.td}>
                      <span style={{ fontWeight: 600 }}>{p.platform}</span>
                    </td>
                    <td style={sty.td}>{p.totalTraders.toLocaleString()}</td>
                    <td style={sty.td}>{p.enrichedTraders.toLocaleString()}</td>
                    <td style={sty.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            color: coverageColor(p.coveragePct),
                            fontWeight: 600,
                            minWidth: '42px',
                          }}
                        >
                          {p.coveragePct}%
                        </span>
                        <div style={{ flex: 1, ...sty.barContainer }}>
                          <div style={sty.barFill(p.coveragePct, coverageColor(p.coveragePct))} />
                        </div>
                      </div>
                    </td>
                    <td style={sty.td}>
                      <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                        {formatTime(p.lastEnrichmentAt)}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Non-enrichable platforms */}
      {(noEnrich.length > 0 || noConfig.length > 0) && (
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
            {t('notEnrichableCount').replace('{n}', String(noEnrich.length + noConfig.length))}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            {[...noEnrich, ...noConfig].map((p) => (
              <span
                key={p.platform}
                style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  backgroundColor: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {p.platform}
                <span style={{ marginLeft: '4px', fontSize: '10px' }}>({p.totalTraders})</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
