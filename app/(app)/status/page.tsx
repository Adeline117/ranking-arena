'use client'

// 2026-07-12 治 SSR 裸 key:模块顶层同步注册全量 en 字典(路由级代码分割 →
// 只进本路由 chunk,不碰首页 LCP)。SSR 与客户端首绘同模块图 → t() 两端可解
// 全量 key,零键名泄漏、零水合错配,页面保持静态预渲染。
import enFull from '@/lib/i18n/en'
import { registerFullDict } from '@/lib/i18n'
registerFullDict('en', enFull)

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Text, Button } from '@/app/components/base'
import ErrorState from '@/app/components/ui/ErrorState'
import EmptyState from '@/app/components/ui/EmptyState'
import Metric from '@/app/components/ui/Metric'
import { useLanguage, type TranslationFunction } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { apiFetch } from '@/lib/utils/api-fetch'
import {
  PUBLIC_STATUS_REQUEST_TIMEOUT_MS,
  readPublicHealthSnapshot,
  readPublicPlatformHealthSnapshot,
  type PublicHealthSnapshot,
  type PublicPlatformHealthSnapshot,
} from '@/lib/status/status-client-contract'

/** Semantic health level, decoupled from the various raw status strings. */
type Level = 'operational' | 'degraded' | 'down' | 'unknown'

const STALE_MS = 3600000 // 1h — a platform not refreshed within this is "degraded"

function levelFor(raw: string): Level {
  if (raw === 'pass' || raw === 'healthy' || raw === 'ok') return 'operational'
  if (raw === 'fail' || raw === 'unhealthy' || raw === 'down') return 'down'
  return 'degraded'
}

// Component/platform names arrive as raw technical keys ("api", "vps",
// "market-data"). Render them with proper acronym casing (API/VPS, not Api/Vps)
// and kebab/underscore → spaced Title Case, so the status page reads cleanly
// regardless of UI language (technical component names stay English by design).
const COMPONENT_ACRONYMS: Record<string, string> = {
  api: 'API',
  vps: 'VPS',
  db: 'DB',
  cpu: 'CPU',
  ssl: 'SSL',
  dns: 'DNS',
  url: 'URL',
  redis: 'Redis',
}
function formatComponentName(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(
      (w) =>
        COMPONENT_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(' ')
}

const LEVEL_COLOR: Record<Level, string> = {
  operational: tokens.colors.accent.success,
  degraded: tokens.colors.accent.warning,
  down: tokens.colors.accent.error,
  unknown: tokens.colors.text.tertiary,
}
const LEVEL_LABEL_KEY: Record<Level, string> = {
  operational: 'statusLevelOperational',
  degraded: 'statusLevelDegraded',
  down: 'statusLevelDown',
  unknown: 'dataUnknown',
}

/**
 * Status indicator with colorblind-safe redundancy: each level has a distinct
 * SHAPE (check / triangle-alert / x) in addition to color. Mirrors the arrow
 * pattern in Metric — color is reinforcement, never the only signal.
 */
function StatusIcon({
  level,
  size = 14,
  t,
}: {
  level: Level
  size?: number
  t: TranslationFunction
}) {
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
    'aria-label': t(LEVEL_LABEL_KEY[level]),
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
  if (level === 'unknown') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.8 9a2.4 2.4 0 014.6.9c0 1.7-2.4 2-2.4 3.7" />
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
  const { t, language } = useLanguage()
  const [health, setHealth] = useState<PublicHealthSnapshot | null>(null)
  const [platforms, setPlatforms] = useState<PublicPlatformHealthSnapshot | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const activeRequestRef = useRef<{
    sequence: number
    controller: AbortController
    promise: Promise<void>
  } | null>(null)

  const fetchData = useCallback((): Promise<void> => {
    const current = activeRequestRef.current
    if (current) return current.promise

    const controller = new AbortController()
    const sequence = ++requestSequenceRef.current
    setLoading(true)

    const promise = (async () => {
      const [healthResult, platformsResult] = await Promise.allSettled([
        apiFetch<unknown>('/api/health', {
          acceptedStatuses: [202, 503],
          cache: 'no-store',
          signal: controller.signal,
          timeoutMs: PUBLIC_STATUS_REQUEST_TIMEOUT_MS,
        }),
        apiFetch<unknown>('/api/platforms/health', {
          cache: 'no-store',
          signal: controller.signal,
          timeoutMs: PUBLIC_STATUS_REQUEST_TIMEOUT_MS,
        }),
      ])

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        activeRequestRef.current?.sequence !== sequence
      ) {
        return
      }

      let failed = false
      if (healthResult.status === 'fulfilled') {
        const snapshot = readPublicHealthSnapshot(healthResult.value)
        if (snapshot) setHealth(snapshot)
        else failed = true
      } else {
        failed = true
      }

      if (platformsResult.status === 'fulfilled') {
        const snapshot = readPublicPlatformHealthSnapshot(platformsResult.value)
        if (snapshot) setPlatforms(snapshot)
        else failed = true
      } else {
        failed = true
      }

      setStatusError(failed)
    })().finally(() => {
      if (activeRequestRef.current?.sequence !== sequence) return
      activeRequestRef.current = null
      if (mountedRef.current) setLoading(false)
    })

    activeRequestRef.current = { sequence, controller, promise }
    return promise
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void fetchData()
    const interval = setInterval(() => void fetchData(), 30000)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
      activeRequestRef.current?.controller.abort(
        new DOMException('Status page unmounted', 'AbortError')
      )
      activeRequestRef.current = null
    }
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
            name: formatComponentName(name),
            level,
            message:
              check.message ||
              (level === 'down' ? t('statusCheckFailed') : t('statusLevelDegraded')),
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
            name: formatComponentName(platform),
            level: 'degraded',
            message: t('statusDataAgo').replace('{ago}', formatTimeAgo(ts, language)),
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
  }, [health, platforms, t, language])

  // 2026-07-04 修 U12:此前总状态只看 health.status,忽略被监控平台的陈旧/退化,
  // 导致顶部绿勾「所有系统正常」与下方 57.1%/4-of-7 组件退化自相矛盾(数据可信度打脸)。
  // 改为取 health.status 与组件实况的较差者:任一组件退化(有 incident 或可用率<100%)
  // 则总状态至少 degraded。
  const baseLevel: Level = health ? levelFor(health.status) : 'degraded'
  const componentsDegraded =
    statusError || incidents.length > 0 || (availabilityPct != null && availabilityPct < 100)
  const overallLevel: Level =
    baseLevel === 'down' ? 'down' : componentsDegraded ? 'degraded' : baseLevel

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
  const hardError = statusError && !health
  const partialError = statusError && !!health

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
              {t('statusSystemStatus')}
            </Text>
            <Text as="p" size="sm" color="secondary">
              {loading && !health
                ? t('checking')
                : t('statusLastChecked').replace(
                    '{ago}',
                    health ? formatTimeAgo(health.timestamp, language) : '—'
                  )}
            </Text>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchData()}
            disabled={loading}
            aria-busy={loading}
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {t('refresh')}
          </Button>
        </header>

        {loading && !health && !hardError && (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            style={{
              ...cardStyle,
              minHeight: 128,
              display: 'grid',
              placeItems: 'center',
              color: tokens.colors.text.secondary,
            }}
          >
            {t('checking')}
          </div>
        )}

        {hardError && (
          <ErrorState
            title={t('statusUnableToLoad')}
            description={t('statusServiceUnavailable')}
            retry={() => void fetchData()}
          />
        )}

        {!hardError && (
          <>
            {partialError && (
              <div
                role="alert"
                style={{
                  ...cardStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[4],
                  borderColor: tokens.colors.accent.warning,
                  flexWrap: 'wrap',
                }}
              >
                <Text as="p" size="sm" color="secondary">
                  {t('statusServiceUnavailable')}
                </Text>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void fetchData()}
                  disabled={loading}
                  aria-busy={loading}
                  style={{ minHeight: 44 }}
                >
                  {t('retry')}
                </Button>
              </div>
            )}

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
                  <StatusIcon level={overallLevel} size={18} t={t} />
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.lg,
                      fontWeight: tokens.typography.fontWeight.semibold,
                    }}
                  >
                    {overallLevel === 'operational'
                      ? t('statusAllOperational')
                      : overallLevel === 'degraded'
                        ? t('statusDegraded')
                        : overallLevel === 'down'
                          ? t('statusDisruption')
                          : t('dataUnknown')}
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
                      label={t('statusAvailabilityNow')}
                    />
                    <Text
                      as="p"
                      size="xs"
                      color="tertiary"
                      style={{ marginTop: tokens.spacing[1] }}
                    >
                      {t('statusComponentsOperational')
                        .replace('{n}', String(operationalCount))
                        .replace('{m}', String(monitoredCount))}
                    </Text>
                  </div>
                )}
              </div>
            )}

            {/* Active incidents / recent status */}
            {health && (
              <div className="card-hover" style={cardStyle}>
                <h2 style={sectionHeadingStyle}>{t('statusActiveIncidents')}</h2>
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
                    title={t('statusNoIncidents')}
                    description={t('statusNoIncidentsDesc')}
                  />
                ) : (
                  incidents.map((item) => (
                    <div key={item.key} style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                        <StatusIcon level={item.level} t={t} />
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
                <h2 style={sectionHeadingStyle}>{t('statusServices')}</h2>
                {Object.entries(health.checks).map(([name, check]) => {
                  const level = check.status === 'skip' ? 'unknown' : levelFor(check.status)
                  return (
                    <div key={name} style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <StatusIcon level={level} t={t} />
                        <span>{formatComponentName(name)}</span>
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
                  <span>{t('statusVersion')}</span>
                  <span style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                    v{health.version}
                  </span>
                </div>
              </div>
            )}

            {/* Platform data freshness */}
            {platforms && Object.keys(platforms.freshness).length > 0 && (
              <div className="card-hover" style={cardStyle}>
                <h2 style={sectionHeadingStyle}>{t('statusDataFreshness')}</h2>
                {Object.entries(platforms.freshness)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([platform, timestamp]) => {
                    const stale = Date.now() - new Date(timestamp).getTime() > STALE_MS
                    const level: Level = stale ? 'degraded' : 'operational'
                    return (
                      <div key={platform} style={rowStyle}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <StatusIcon level={level} t={t} />
                          <span>{formatComponentName(platform)}</span>
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
                          {formatTimeAgo(timestamp, language)}
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
          {t('statusAutoRefresh')}
        </p>
      </div>
    </div>
  )
}
