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
import Metric from '@/app/components/ui/Metric'
import { useAdminAuth } from '../hooks/useAdminAuth'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { B2C_FUNNEL_STEPS, type B2CFunnelStep } from '@/lib/analytics/b2c-metrics'

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
  newSignups: number | null
  activated7d: number | null
  activationEligible: number | null
  funnel: Partial<Record<B2CFunnelStep, number>> | null
  eventCollectionStartedAt: string | null
  measurementAvailable: boolean
  recentSignups: RecentSignup[]
  windowDays: number
  timestamp: string
  // Optional prior-period values — when the API supplies them the KPI cards
  // render a Δ vs prior period. Absent today (server response has no prior
  // snapshot yet), so the Δ stays hidden rather than fabricating a trend.
  totalPayingPrev?: number | null
  newPayingPrevWeek?: number | null
  wauPrev?: number | null
}

const FUNNEL_LABELS: Record<B2CFunnelStep, string> = {
  landing_view: 'Landing',
  ranking_visible: 'Ranking',
  view_trader: 'Trader',
  signup_start: 'Signup start',
  signup: 'Signup',
  onboarding_complete: 'Onboarded',
  view_pricing: 'Pricing',
  start_checkout: 'Checkout',
  pro_subscribe: 'Pro',
}

function MetricTile({
  label,
  value,
  sub,
  delta,
  deltaLabel,
}: {
  label: string
  value: number | null
  sub?: string
  /** Change vs prior period (current − prior). null/undefined → no Δ shown. */
  delta?: number | null
  deltaLabel?: string
}) {
  const hasDelta = delta != null && Number.isFinite(delta)
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
          fontWeight: tokens.typography.fontWeight.semibold,
          marginBottom: tokens.spacing[2],
        }}
      >
        {label}
      </div>
      <Metric value={value} format="number" size="hero" />
      {hasDelta && (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: tokens.spacing[2],
            marginTop: tokens.spacing[2],
          }}
        >
          {/* showArrow → ▲/▼ glyph is a colorblind-safe redundancy for the sign color */}
          <Metric
            value={delta}
            display={`${(delta as number) > 0 ? '+' : ''}${(delta as number).toLocaleString()}`}
            colorBySign
            showArrow
            size="sm"
          />
          {deltaLabel && (
            <span
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: 'var(--color-text-tertiary)',
              }}
            >
              {deltaLabel}
            </span>
          )}
        </div>
      )}
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
  const { isAdmin, authChecking, accessToken } = useAdminAuth()
  const [data, setData] = useState<ProMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !accessToken) return
    let cancelled = false
    setLoading(true)
    // withAdminAuth verifies the Authorization Bearer token — 401'd without it
    fetch('/api/admin/pro-metrics', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return
        if (!payload?.success) {
          setError(payload?.error || t('failedToLoadMetrics'))
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
  }, [isAdmin, accessToken, t])

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
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: tokens.spacing[6] }}>
        <header style={{ marginBottom: tokens.spacing[6] }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: tokens.typography.fontWeight.black,
              margin: 0,
            }}
          >
            {t('proMetricsTitle')}
          </h1>
          <p
            style={{
              color: 'var(--color-text-secondary)',
              marginTop: tokens.spacing[2],
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('proMetricsSubtitle')}
            {data?.timestamp && (
              <>
                {' '}
                &middot; {t('updatedAt')} {new Date(data.timestamp).toLocaleString()}
              </>
            )}
          </p>
        </header>

        {loading && (
          <div style={{ padding: 40, color: 'var(--color-text-secondary)' }}>{t('loading')}</div>
        )}
        {error && (
          <div
            style={{
              padding: tokens.spacing[4],
              background: 'color-mix(in srgb, var(--color-accent-error) 10%, transparent)',
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
                label={t('totalPaying')}
                value={data.totalPaying}
                sub={t('totalPayingSub')}
                delta={
                  data.totalPaying != null && data.totalPayingPrev != null
                    ? data.totalPaying - data.totalPayingPrev
                    : null
                }
                deltaLabel={t('vsPriorPeriod')}
              />
              <MetricTile
                label={t('newThisWeek')}
                value={data.newPayingThisWeek}
                sub={t('lastNDays').replace('{n}', String(data.windowDays))}
                delta={
                  data.newPayingThisWeek != null && data.newPayingPrevWeek != null
                    ? data.newPayingThisWeek - data.newPayingPrevWeek
                    : null
                }
                deltaLabel={t('vsPriorPeriod')}
              />
              <MetricTile
                label={t('wau7d')}
                value={data.wau}
                sub={t('wauSub')}
                delta={data.wau != null && data.wauPrev != null ? data.wau - data.wauPrev : null}
                deltaLabel={t('vsPriorPeriod')}
              />
              <MetricTile
                label={t('newSignups7d')}
                value={data.newSignups}
                sub={t('lastNDays').replace('{n}', String(data.windowDays))}
              />
              <MetricTile
                label={t('activation7d')}
                value={data.activated7d}
                sub={t('activationSub')
                  .replace('{activated}', String(data.activated7d ?? '—'))
                  .replace('{eligible}', String(data.activationEligible ?? '—'))}
              />
            </section>

            <section style={{ marginBottom: tokens.spacing[8] }}>
              <h2
                style={{
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: tokens.typography.fontWeight.bold,
                  marginBottom: tokens.spacing[3],
                }}
              >
                {t('journeyFunnel')}
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
                  gap: tokens.spacing[2],
                }}
              >
                {B2C_FUNNEL_STEPS.map((step, index) => {
                  const value = data.funnel?.[step] ?? 0
                  const previousStep = B2C_FUNNEL_STEPS[index - 1]
                  const previous = previousStep ? (data.funnel?.[previousStep] ?? 0) : null
                  const conversion =
                    previous && previous > 0 ? `${Math.round((value / previous) * 100)}%` : null
                  return (
                    <div
                      key={step}
                      style={{
                        padding: tokens.spacing[3],
                        border: '1px solid var(--color-border-primary)',
                        borderRadius: tokens.radius.md,
                        background: 'var(--color-bg-secondary)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        {FUNNEL_LABELS[step]}
                      </div>
                      <div
                        style={{
                          fontSize: tokens.typography.fontSize.xl,
                          fontWeight: tokens.typography.fontWeight.bold,
                        }}
                      >
                        {value.toLocaleString()}
                      </div>
                      {conversion && (
                        <div
                          style={{
                            fontSize: tokens.typography.fontSize.xs,
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {conversion}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <p
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {data.eventCollectionStartedAt
                  ? t('collectionSince').replace(
                      '{time}',
                      new Date(data.eventCollectionStartedAt).toLocaleString()
                    )
                  : t('collectionPending')}
              </p>
            </section>

            <section>
              <h2
                style={{
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: tokens.typography.fontWeight.bold,
                  marginBottom: tokens.spacing[4],
                }}
              >
                {t('recentPayingSignups')}
              </h2>
              {data.recentSignups.length === 0 ? (
                <div style={{ color: 'var(--color-text-tertiary)' }}>{t('noSignupsYet')}</div>
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
                        <th
                          scope="col"
                          style={{
                            padding: tokens.spacing[3],
                            fontWeight: tokens.typography.fontWeight.semibold,
                          }}
                        >
                          {t('colUser')}
                        </th>
                        <th
                          scope="col"
                          style={{
                            padding: tokens.spacing[3],
                            fontWeight: tokens.typography.fontWeight.semibold,
                          }}
                        >
                          {t('colTier')}
                        </th>
                        <th
                          scope="col"
                          style={{
                            padding: tokens.spacing[3],
                            fontWeight: tokens.typography.fontWeight.semibold,
                          }}
                        >
                          {t('colPlan')}
                        </th>
                        <th
                          scope="col"
                          style={{
                            padding: tokens.spacing[3],
                            fontWeight: tokens.typography.fontWeight.semibold,
                          }}
                        >
                          {t('colStatus')}
                        </th>
                        <th
                          scope="col"
                          style={{
                            padding: tokens.spacing[3],
                            fontWeight: tokens.typography.fontWeight.semibold,
                          }}
                        >
                          {t('colSignedUp')}
                        </th>
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
