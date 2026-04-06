'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

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

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
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

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'pass' || status === 'healthy' || status === 'ok'
      ? "var(--color-accent-success)"
      : status === 'degraded' || status === 'skip'
        ? "var(--color-score-average)"
        : "var(--color-accent-error)"
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        marginRight: tokens.spacing[2],
        flexShrink: 0,
      }}
    />
  )
}

export default function StatusPage() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [platforms, setPlatforms] = useState<PlatformHealthData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const [hRes, pRes] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/platforms/health', { cache: 'no-store' }),
      ])
      if (hRes.ok) setHealth(await hRes.json())
      else setError('Health endpoint returned ' + hRes.status)
      if (pRes.ok) setPlatforms(await pRes.json())
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

  const cardStyle: React.CSSProperties = {
    background: tokens.colors.bg.secondary,
    border: `1px solid ${tokens.colors.border.primary}`,
    borderRadius: tokens.radius.lg,
    padding: tokens.spacing[5],
    marginBottom: tokens.spacing[4],
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
        padding: tokens.spacing[6],
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <header style={{ marginBottom: tokens.spacing[8] }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: tokens.typography.fontWeight.bold,
              marginBottom: tokens.spacing[1],
            }}
          >
            System Status
          </h1>
          <p style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.sm }}>
            {loading
              ? 'Checking...'
              : error
                ? error
                : `Last checked ${health ? formatAgo(health.timestamp) : '—'}`}
          </p>
        </header>

        {/* Overall Status */}
        {health && (
          <div
            style={{
              ...cardStyle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <StatusDot status={health.status} />
              <span
                style={{
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  textTransform: 'capitalize' as const,
                }}
              >
                {health.status === 'healthy'
                  ? 'All Systems Operational'
                  : health.status === 'degraded'
                    ? 'Degraded Performance'
                    : 'Service Disruption'}
              </span>
            </div>
            <span
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}
            >
              v{health.version}
            </span>
          </div>
        )}

        {/* Service Checks */}
        {health && (
          <div style={cardStyle}>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                marginBottom: tokens.spacing[4],
                color: tokens.colors.text.secondary,
              }}
            >
              Services
            </h2>
            {Object.entries(health.checks).map(([name, check]) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `${tokens.spacing[2]} 0`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <StatusDot status={check.status} />
                  <span style={{ textTransform: 'capitalize' as const }}>{name}</span>
                </div>
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                    fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  }}
                >
                  {check.latency != null ? `${check.latency}ms` : check.message || check.status}
                </span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
              }}
            >
              <span>Uptime: {formatUptime(health.uptime)}</span>
              <span>{health.checks.memory?.message || health.checks.redis?.message || '—'}</span>
            </div>
          </div>
        )}

        {/* Platform Freshness */}
        {platforms && Object.keys(platforms.freshness).length > 0 && (
          <div style={cardStyle}>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                marginBottom: tokens.spacing[4],
                color: tokens.colors.text.secondary,
              }}
            >
              Data Freshness
            </h2>
            {Object.entries(platforms.freshness)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([platform, timestamp]) => {
                const diffMs = Date.now() - new Date(timestamp).getTime()
                const isStale = diffMs > 3600000 // > 1 hour
                return (
                  <div
                    key={platform}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: `${tokens.spacing[2]} 0`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <StatusDot status={isStale ? 'degraded' : 'pass'} />
                      <span style={{ textTransform: 'capitalize' as const }}>{platform}</span>
                    </div>
                    <span
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: isStale ? "var(--color-score-average)" : tokens.colors.text.tertiary,
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

        {/* Footer */}
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
