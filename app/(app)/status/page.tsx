'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Text, Button } from '@/app/components/base'
import ErrorState from '@/app/components/ui/ErrorState'
import EmptyState from '@/app/components/ui/EmptyState'
import Metric from '@/app/components/ui/Metric'

interface HealthData {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
  uptime: number
  checks: Record<string, { status: 'pass' | 'fail' | 'skip'; message?: string; latency?: number }>
}

interface PlatformHealthData {
  platforms: Array<{ platform: string; status: string; last_check?: string }>
  freshness: Record<string, string>
}

/** Semantic health level, decoupled from the various raw status strings. */
type Level = 'operational' | 'degraded' | 'down'

const STALE_MS = 3600000 // 1h — a platform not refreshed within this is "degraded"

function levelFor(raw: string): Level {
  if (raw === 'pass' || raw === 'healthy' || raw === 'ok') return 'operational'
  if (raw === 'fail' || raw === 'unhealthy' || raw === 'down') return 'down'
  return 'degraded'
}

const LEVEL_COLOR: Record<Level, string> = {
  operational: tokens.colors.accent.success,
  degraded: tokens.colors.accent.warning,
  down: tokens.colors.accent.error,
}
const LEVEL_LABEL: Record<Level, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Status indicator with colorblind-safe redundancy: each level has a distinct
 * SHAPE (check / triangle-alert / x) in addition to color. Mirrors the arrow
 * pattern in Metric — color is reinforcement, never the only signal.
 */
function StatusIcon({ level, size = 14 }: { level: Level; size?: number }) {
  const color = LEVEL_COLOR[level]
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flexShrink: 0, marginRight: tokens.spacing[2] },
    role: 'img',
    'aria-label': LEVEL_LABEL[level],
  }
  if (level === 'operational') {
    // circle + check
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
      </svg>
    )
  }
  if (level === 'degraded') {
    // triangle + exclamation
    return (
      <svg {...common}>
        <path d="M12 4L2.5 20h19L12 4z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    )
  }
  // down: circle + x
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  )
}

interface Incident {
  key: string
  name: string
  level: Level
  message: string
}

export default function StatusPage() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [platforms, setPlatforms] = useState<PlatformHealthData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setError(null)
    try {
      const [hRes, pRes] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/platforms/health', { cache: 'no-store' }),
      ])
      // /api/health returns 503/202 on degraded/unhealthy but with a valid body —
      // only treat a truly unreadable response as a hard error.
      let parsedHealth: HealthData | null = null
      try {
        parsedHealth = (await hRes.json()) as HealthData
      } catch {
        parsedHealth = null
      }
      if (parsedHealth && parsedHealth.checks) {
        setHealth(parsedHealth)
      } else {
        throw new Error(`Health endpoint returned ${hRes.status} with no readable body`)
      }
      if (pRes.ok) {
        try {
          setPlatforms((await pRes.json()) as PlatformHealthData)
        } catch {
          /* platform data is supplementary — non-fatal */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Live "current availability": fraction of MONITORED components (health checks
  // that ran, excluding skipped/unconfigured ones, + tracked platforms) that are
  // currently operational. This is a real, live figure derived from the health
  // API — NOT a fabricated historical uptime SLA.
  const { availabilityPct, operationalCount, monitoredCount, incidents } = useMemo(() => {
    const inc: Incident[] = []
    let operational = 0
    let monitored = 0

    if (health) {
      for (const [name, check] of Object.entries(health.checks)) {
        if (check.status === 'skip') continue // not configured / not monitored
        monitored++
        const level = levelFor(check.status)
        if (level === 'operational') operational++
        else
          inc.push({
            key: `svc:${name}`,
            name: name.charAt(0).toUpperCase() + name.slice(1),
            level,
            message: check.message || (level === 'down' ? 'Check failed' : 'Degraded'),
          })
      }
    }

    if (platforms?.freshness) {
      for (const [platform, ts] of Object.entries(platforms.freshness)) {
        monitored++
        const stale = Date.now() - new Date(ts).getTime() > STALE_MS
        if (!stale) operational++
        else
          inc.push({
            key: `plat:${platform}`,
            name: platform.charAt(0).toUpperCase() + platform.slice(1),
            level: 'degraded',
            message: `Data ${formatAgo(ts)}`,
          })
      }
    }

    const pct = monitored > 0 ? (operational / monitored) * 100 : null
    // Sort worst-first so real outages surface above stale-data warnings.
    inc.sort((a, b) => (a.level === 'down' ? 0 : 1) - (b.level === 'down' ? 0 : 1))
    return {
      availabilityPct: pct,
      operationalCount: operational,
      monitoredCount: monitored,
      incidents: inc,
    }
  }, [health, platforms])

  const overallLevel: Level = health ? levelFor(health.status) : 'degraded'

  const cardStyle: React.CSSProperties = {
    background: tokens.colors.bg.secondary,
    border: `1px solid ${tokens.colors.border.primary}`,
    borderRadius: tokens.radius.lg,
    padding: tokens.spacing[6],
    marginBottom: tokens.spacing[4],
    transition: `border-color ${tokens.transition.base}`,
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${tokens.spacing[2]} 0`,
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
    gap: tokens.spacing[3],
  }

  const sectionHeadingStyle: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.semibold,
    marginBottom: tokens.spacing[4],
    color: tokens.colors.text.secondary,
  }

  // Hard failure with no data at all → real error surface, not a blank page.
  const hardError = !!error && !health

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
      }}
    >
      <div
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        <header
          style={{
            marginBottom: tokens.spacing[8],
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: tokens.spacing[3],
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Text as="h1" size="2xl" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
              System Status
            </Text>
            <Text as="p" size="sm" color="secondary">
              {loading && !health
                ? 'Checking…'
                : error
                  ? error
                  : `Last checked ${health ? formatAgo(health.timestamp) : '—'}`}
            </Text>
          </div>
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
            Refresh
          </Button>
        </header>

        {hardError && (
          <ErrorState
            title="Unable to load status"
            description={error || 'The status service is not responding right now.'}
            retry={fetchData}
          />
        )}

        {!hardError && (
          <>
            {/* Overall availability + status */}
            {health && (
              <div
                className="card-hover"
                style={{
                  ...cardStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[4],
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <StatusIcon level={overallLevel} size={18} />
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.lg,
                      fontWeight: tokens.typography.fontWeight.semibold,
                    }}
                  >
                    {overallLevel === 'operational'
                      ? 'All Systems Operational'
                      : overallLevel === 'degraded'
                        ? 'Degraded Performance'
                        : 'Service Disruption'}
                  </span>
                </div>
                {availabilityPct != null && (
                  <div style={{ textAlign: 'right' }}>
                    <Metric
                      value={availabilityPct}
                      display={`${availabilityPct.toFixed(1)}%`}
                      format="number"
                      colorBySign={false}
                      size="lg"
                      align="right"
                      label="Availability now"
                    />
                    <Text
                      as="p"
                      size="xs"
                      color="tertiary"
                      style={{ marginTop: tokens.spacing[1] }}
                    >
                      {operationalCount}/{monitoredCount} components operational
                    </Text>
                  </div>
                )}
              </div>
            )}

            {/* Active incidents / recent status */}
            {health && (
              <div className="card-hover" style={cardStyle}>
                <h2 style={sectionHeadingStyle}>Active Incidents</h2>
                {incidents.length === 0 ? (
                  <EmptyState
                    variant="compact"
                    icon={
                      <svg
                        width="26"
                        height="26"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={tokens.colors.accent.success}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
                      </svg>
                    }
                    title="No active incidents"
                    description="All monitored services and data feeds are operating normally."
                  />
                ) : (
                  incidents.map((item) => (
                    <div key={item.key} style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                        <StatusIcon level={item.level} />
                        <span style={{ textTransform: 'capitalize' as const }}>{item.name}</span>
                      </div>
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: LEVEL_COLOR[item.level],
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                          textAlign: 'right',
                        }}
                      >
                        {item.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Service checks */}
            {health && (
              <div className="card-hover" style={cardStyle}>
                <h2 style={sectionHeadingStyle}>Services</h2>
                {Object.entries(health.checks).map(([name, check]) => {
                  const level = check.status === 'skip' ? 'degraded' : levelFor(check.status)
                  return (
                    <div key={name} style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <StatusIcon level={level} />
                        <span style={{ textTransform: 'capitalize' as const }}>{name}</span>
                      </div>
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: tokens.colors.text.tertiary,
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                          textAlign: 'right',
                        }}
                      >
                        {check.latency != null
                          ? `${check.latency}ms`
                          : check.message || check.status}
                      </span>
                    </div>
                  )
                })}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: tokens.spacing[3],
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  <span>Version</span>
                  <span style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                    v{health.version}
                  </span>
                </div>
              </div>
            )}

            {/* Platform data freshness */}
            {platforms && Object.keys(platforms.freshness).length > 0 && (
              <div className="card-hover" style={cardStyle}>
                <h2 style={sectionHeadingStyle}>Data Freshness</h2>
                {Object.entries(platforms.freshness)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([platform, timestamp]) => {
                    const stale = Date.now() - new Date(timestamp).getTime() > STALE_MS
                    const level: Level = stale ? 'degraded' : 'operational'
                    return (
                      <div key={platform} style={rowStyle}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <StatusIcon level={level} />
                          <span style={{ textTransform: 'capitalize' as const }}>{platform}</span>
                        </div>
                        <span
                          style={{
                            fontSize: tokens.typography.fontSize.xs,
                            color: stale
                              ? tokens.colors.accent.warning
                              : tokens.colors.text.tertiary,
                            fontFamily: tokens.typography.fontFamily.mono.join(', '),
                          }}
                        >
                          {formatAgo(timestamp)}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )}
          </>
        )}

        <p
          style={{
            textAlign: 'center' as const,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            marginTop: tokens.spacing[8],
          }}
        >
          Auto-refreshes every 30 seconds
        </p>
      </div>
    </div>
  )
}
