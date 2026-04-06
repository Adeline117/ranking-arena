'use client'

/**
 * 数据健康仪表盘
 * 显示每个平台的数据状态、最后更新时间、数据量、freshness
 */

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useAdminAuth } from '../hooks/useAdminAuth'
import TopNav from '@/app/components/layout/TopNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface PlatformHealth {
  source: string
  total: number
  latest_snapshot: string | null
  oldest_snapshot: string | null
  age_hours: number | null
  status: 'healthy' | 'warning' | 'critical' | 'no_data'
  fieldCoverage?: { roi: number; winRate: number; maxDrawdown: number }
}

interface HealthData {
  platforms: PlatformHealth[]
  total_traders: number
  total_platforms: number
  timestamp: string
}

const STATUS_COLORS: Record<string, string> = {
  healthy: 'var(--color-accent-success)',
  warning: 'var(--color-score-average)',
  critical: 'var(--color-accent-error)',
  no_data: 'var(--color-score-low)',
}

export default function DataHealthPage() {
  const { t } = useLanguage()
  const { email, isAdmin, authChecking } = useAdminAuth()
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/monitoring/freshness')
      .then(res => res.json())
      .then((d) => {
        // Transform freshness API response
        const platforms: PlatformHealth[] = (d.platforms || []).map((p: Record<string, unknown>) => ({
          source: p.source as string,
          total: (p.total as number) || 0,
          latest_snapshot: (p.lastUpdate || p.latestSnapshot) as string | null,
          oldest_snapshot: null,
          age_hours: p.ageHours as number | null,
          status: p.status as string || 'no_data',
          fieldCoverage: p.fieldCoverage as { roi: number; winRate: number; maxDrawdown: number } | undefined,
        }))
        setData({
          platforms,
          total_traders: platforms.reduce((sum: number, p: PlatformHealth) => sum + p.total, 0),
          total_platforms: platforms.filter((p: PlatformHealth) => p.total > 0).length,
          timestamp: d.timestamp || new Date().toISOString(),
        })
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [isAdmin])

  if (authChecking) return <div style={{ padding: 40, color: 'var(--color-text-secondary)' }}>{t('verifyingPermission')}</div>
  if (!isAdmin) return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <div style={{ padding: 40, textAlign: 'center' }}>
        <h2>{t('noPermissionAccess')}</h2>
        <p style={{ color: 'var(--color-text-secondary)' }}>{t('noAdminPermission')}</p>
      </div>
    </div>
  )
  const retryFetch = () => {
    setLoading(true)
    setError(null)
    fetch('/api/monitoring/freshness')
      .then(res => res.json())
      .then((d) => {
        const platforms: PlatformHealth[] = (d.platforms || []).map((p: Record<string, unknown>) => ({
          source: p.source as string,
          total: (p.total as number) || 0,
          latest_snapshot: (p.lastUpdate || p.latestSnapshot) as string | null,
          oldest_snapshot: null,
          age_hours: p.ageHours as number | null,
          status: p.status as string || 'no_data',
          fieldCoverage: p.fieldCoverage as { roi: number; winRate: number; maxDrawdown: number } | undefined,
        }))
        setData({
          platforms,
          total_traders: platforms.reduce((sum: number, p: PlatformHealth) => sum + p.total, 0),
          total_platforms: platforms.filter((p: PlatformHealth) => p.total > 0).length,
          timestamp: d.timestamp || new Date().toISOString(),
        })
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }

  if (loading) return <div style={{ padding: 40, color: 'var(--color-text-secondary)' }}>{t('loading')}</div>
  if (error) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <p style={{ color: 'var(--color-accent-error)', marginBottom: 12 }}>{t('error')}: {error}</p>
      <button
        onClick={retryFetch}
        style={{
          padding: '8px 20px',
          borderRadius: 8,
          border: '1px solid var(--color-border-primary)',
          background: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        {t('retry') || 'Retry'}
      </button>
    </div>
  )
  if (!data) return null

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary, padding: '24px 32px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>{t('dataHealthTitle')}</h1>
      <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 24 }}>
        最后检查: {new Date(data.timestamp).toLocaleString('zh-CN')} · 共 {data.total_platforms} 个活跃平台 · {data.total_traders} 名交易员
      </p>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 32 }}>
        {['healthy', 'warning', 'critical', 'no_data'].map(status => {
          const count = data.platforms.filter(p => p.status === status).length
          const label = status === 'healthy' ? t('dataHealthy') : status === 'warning' ? t('dataWarning') : status === 'critical' ? t('dataCritical') : t('dataNoData')
          return (
            <div key={status} style={{
              padding: '16px 20px', borderRadius: 10,
              background: `${STATUS_COLORS[status]}12`,
              border: `1px solid ${STATUS_COLORS[status]}30`,
            }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: STATUS_COLORS[status] }}>{count}</div>
              <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{label}</div>
            </div>
          )
        })}
      </div>

      {/* Platform table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>{t('dataHealthPlatform')}</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>{t('dataHealthCount')}</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>{t('dataHealthLastUpdate')}</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>{t('dataHealthAge')}</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>ROI%</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>WR%</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>DD%</th>
              <th style={{ textAlign: 'center', padding: '8px 12px', color: tokens.colors.text.tertiary, fontWeight: 500 }}>{t('dataHealthStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {data.platforms
              .sort((a, b) => (b.total || 0) - (a.total || 0))
              .map(p => (
              <tr key={p.source} style={{ borderBottom: `1px solid ${tokens.colors.border.primary}30` }}>
                <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                  {EXCHANGE_NAMES[p.source] || p.source}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {p.total > 0 ? p.total.toLocaleString() : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: tokens.colors.text.tertiary, fontSize: 12 }}>
                  {p.latest_snapshot ? new Date(p.latest_snapshot).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {p.age_hours != null
                    ? p.age_hours < 1 ? t('dataHealthMinutes').replace('{n}', String(Math.round(p.age_hours * 60)))
                    : p.age_hours < 24 ? t('dataHealthHours').replace('{n}', String(Math.round(p.age_hours)))
                    : t('dataHealthDays').replace('{n}', String(Math.round(p.age_hours / 24)))
                    : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 12, color: (p.fieldCoverage?.roi ?? 0) >= 90 ? 'var(--color-accent-success)' : tokens.colors.text.tertiary }}>
                  {p.fieldCoverage ? `${p.fieldCoverage.roi}%` : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 12, color: (p.fieldCoverage?.winRate ?? 0) >= 50 ? 'var(--color-accent-success)' : tokens.colors.text.tertiary }}>
                  {p.fieldCoverage ? `${p.fieldCoverage.winRate}%` : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 12, color: (p.fieldCoverage?.maxDrawdown ?? 0) >= 50 ? 'var(--color-accent-success)' : tokens.colors.text.tertiary }}>
                  {p.fieldCoverage ? `${p.fieldCoverage.maxDrawdown}%` : '-'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                    backgroundColor: STATUS_COLORS[p.status] || STATUS_COLORS.no_data,
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
