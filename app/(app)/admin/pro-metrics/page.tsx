'use client'

/**
 * Admin Pro Metrics Dashboard
 *
 * Live view of the three numbers CEO review 2026-04-09 flagged as the
 * post-paywall success metrics:
 *   1. Total paying subscribers
 *   2. New paying signups this week
 *   3. WAU
 *   + recent signup list for at-a-glance "is the funnel working"
 *
 * Powers /admin/pro-metrics. Matches the /api/admin/pro-metrics response
 * shape. For the Telegram push equivalent, see scripts/openclaw/weekly-metrics.mjs.
 */

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useAdminAuth } from '../hooks/useAdminAuth'
import TopNav from '@/app/components/layout/TopNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface RecentSignup {
  id: string
  user_id: string
  tier: string
  plan: string | null
  status: string
  created_at: string
}

interface ProMetricsData {
  totalPaying: number | null
  newPayingThisWeek: number | null
  wau: number | null
  recentSignups: RecentSignup[]
  windowDays: number
  timestamp: string
}

function MetricTile({
  label,
  value,
  sub,
}: {
  label: string
  value: number | null | string
  sub?: string
}) {
  return (
    <div
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-primary)',
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[5],
        minWidth: 180,
      }}
    >
      <div
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          marginBottom: tokens.spacing[2],
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: tokens.typography.fontSize['3xl'],
          fontWeight: 800,
          color: value == null ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
        }}
      >
        {value == null ? '—' : value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-text-secondary)',
            marginTop: tokens.spacing[2],
          }}
        >
          {sub}
        </div>
      )}
    </div>
  )
}

export default function ProMetricsPage() {
  const { t } = useLanguage()
  const { email, isAdmin, authChecking } = useAdminAuth()
  const [data, setData] = useState<ProMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    setLoading(true)
    fetch('/api/admin/pro-metrics')
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return
        if (!payload?.success) {
          setError(payload?.error || 'Failed to load metrics')
          setLoading(false)
          return
        }
        setData(payload.data as ProMetricsData)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  if (authChecking) {
    return (
      <div style={{ padding: 40, color: 'var(--color-text-secondary)' }}>
        {t('verifyingPermission')}
      </div>
    )
  }
  if (!isAdmin) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <TopNav email={email} />
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2>{t('noPermissionAccess')}</h2>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      <TopNav email={email} />
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: tokens.spacing[6] }}>
        <header style={{ marginBottom: tokens.spacing[6] }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: 800,
              margin: 0,
            }}
          >
            Pro Metrics
          </h1>
          <p
            style={{
              color: 'var(--color-text-secondary)',
              marginTop: tokens.spacing[2],
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            The three numbers that answer &ldquo;is the paywall working?&rdquo;
            {data?.timestamp && (
              <>
                {' '}
                &middot; updated {new Date(data.timestamp).toLocaleString()}
              </>
            )}
          </p>
        </header>

        {loading && (
          <div style={{ padding: 40, color: 'var(--color-text-secondary)' }}>
            Loading&hellip;
          </div>
        )}
        {error && (
          <div
            style={{
              padding: tokens.spacing[4],
              background: 'var(--color-accent-error-10, rgba(255,80,80,0.1))',
              border: '1px solid var(--color-accent-error)',
              borderRadius: tokens.radius.lg,
              color: 'var(--color-accent-error)',
              marginBottom: tokens.spacing[4],
            }}
          >
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            <section
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: tokens.spacing[4],
                marginBottom: tokens.spacing[8],
              }}
            >
              <MetricTile
                label="Total paying"
                value={data.totalPaying}
                sub="active + trialing × pro|lifetime"
              />
              <MetricTile
                label="New this week"
                value={data.newPayingThisWeek}
                sub={`last ${data.windowDays} days`}
              />
              <MetricTile
                label="WAU (7d)"
                value={data.wau}
                sub="distinct user_activity rows"
              />
            </section>

            <section>
              <h2
                style={{
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: 700,
                  marginBottom: tokens.spacing[4],
                }}
              >
                Recent paying signups
              </h2>
              {data.recentSignups.length === 0 ? (
                <div style={{ color: 'var(--color-text-tertiary)' }}>No signups yet.</div>
              ) : (
                <div
                  style={{
                    border: '1px solid var(--color-border-primary)',
                    borderRadius: tokens.radius.lg,
                    overflow: 'hidden',
                  }}
                >
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: tokens.typography.fontSize.sm,
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: 'var(--color-bg-secondary)',
                          textAlign: 'left',
                        }}
                      >
                        <th style={{ padding: tokens.spacing[3], fontWeight: 600 }}>User</th>
                        <th style={{ padding: tokens.spacing[3], fontWeight: 600 }}>Tier</th>
                        <th style={{ padding: tokens.spacing[3], fontWeight: 600 }}>Plan</th>
                        <th style={{ padding: tokens.spacing[3], fontWeight: 600 }}>Status</th>
                        <th style={{ padding: tokens.spacing[3], fontWeight: 600 }}>Signed up</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentSignups.map((s) => (
                        <tr
                          key={s.id}
                          style={{ borderTop: '1px solid var(--color-border-primary)' }}
                        >
                          <td
                            style={{
                              padding: tokens.spacing[3],
                              fontFamily: 'var(--font-mono, monospace)',
                              fontSize: tokens.typography.fontSize.xs,
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            {s.user_id.slice(0, 8)}&hellip;
                          </td>
                          <td style={{ padding: tokens.spacing[3] }}>{s.tier}</td>
                          <td style={{ padding: tokens.spacing[3] }}>{s.plan || '—'}</td>
                          <td style={{ padding: tokens.spacing[3] }}>{s.status}</td>
                          <td
                            style={{
                              padding: tokens.spacing[3],
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            {new Date(s.created_at).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
