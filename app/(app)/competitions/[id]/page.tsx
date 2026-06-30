'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import EmptyState from '@/app/components/ui/EmptyState'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import Metric from '@/app/components/ui/Metric'
import CompetitionCountdown from '../CompetitionCountdown'
import CompetitionCapacityBar from '../CompetitionCapacityBar'
import Link from 'next/link'

interface Competition {
  id: string
  title: string
  description: string | null
  creator_id: string
  metric: string
  start_at: string
  end_at: string
  entry_fee_cents: number
  max_participants: number
  prize_pool_cents: number
  status: string
  rules: Record<string, unknown>
  created_at: string
}

interface CompetitionEntry {
  id: string
  competition_id: string
  user_id: string
  trader_id: string
  platform: string
  baseline_value: number | null
  current_value: number | null
  rank: number | null
  joined_at: string
}

type DetailTab = 'info' | 'standings'

function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    roi: 'ROI',
    pnl: 'PnL',
    sharpe: 'Sharpe Ratio',
    max_drawdown: 'Max Drawdown',
  }
  return labels[metric] || metric.toUpperCase()
}

function formatValue(value: number | null, metric: string): string {
  if (value == null) return '-'
  if (metric === 'roi') return `${value.toFixed(2)}%`
  if (metric === 'pnl') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (metric === 'sharpe') return value.toFixed(3)
  if (metric === 'max_drawdown') return `${value.toFixed(2)}%`
  return String(value)
}

function formatDelta(baseline: number | null, current: number | null, metric: string): string {
  if (baseline == null || current == null) return '-'
  const delta = current - baseline
  const prefix = delta >= 0 ? '+' : ''
  if (metric === 'roi' || metric === 'max_drawdown') return `${prefix}${delta.toFixed(2)}%`
  if (metric === 'pnl')
    return `${prefix}$${delta.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${prefix}${delta.toFixed(3)}`
}

function formatPrize(cents: number): string {
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toFixed(0)}`
}

// ─── Podium Component ───────────────────────────────────────────────
function Podium({
  entries,
  metric,
  prizeCents,
  t,
}: {
  entries: CompetitionEntry[]
  metric: string
  prizeCents: number
  t: (key: string) => string
}) {
  const top3 = entries
    .filter((e) => e.rank != null && e.rank <= 3)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  if (top3.length === 0) return null

  const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32'] // gold, silver, bronze
  const medalLabels = [t('compPodium1st'), t('compPodium2nd'), t('compPodium3rd')]
  const medalEmojis = ['\u{1F947}', '\u{1F948}', '\u{1F949}']
  // Prize distribution: 60/25/15 if 3+ participants, 70/30 if 2, 100% if 1
  const prizeShares = top3.length >= 3 ? [0.6, 0.25, 0.15] : top3.length === 2 ? [0.7, 0.3] : [1]
  // Podium display order: 2nd, 1st, 3rd (visual layout)
  const displayOrder =
    top3.length >= 3
      ? [top3[1], top3[0], top3[2]]
      : top3.length === 2
        ? [top3[1], top3[0]]
        : [top3[0]]
  const displayIndices = top3.length >= 3 ? [1, 0, 2] : top3.length === 2 ? [1, 0] : [0]
  const podiumHeights = ['120px', '160px', '100px']

  return (
    <Box
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        marginBottom: tokens.spacing[5],
      }}
    >
      <Text
        style={{
          fontWeight: tokens.typography.fontWeight.semibold,
          marginBottom: tokens.spacing[4],
          textAlign: 'center',
        }}
      >
        {t('compPodiumWinners')}
      </Text>
      <Box
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-end',
          gap: tokens.spacing[3],
          minHeight: 220,
        }}
      >
        {displayOrder.map((entry, i) => {
          const origIdx = displayIndices[i]
          const height = podiumHeights[top3.length >= 3 ? i : origIdx === 0 ? 1 : 0]
          return (
            <Box
              key={entry.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[2],
              }}
            >
              {/* Medal + Trader info */}
              <Text
                aria-hidden="true"
                style={{ fontSize: tokens.typography.fontSize['3xl'], lineHeight: 1 }}
              >
                {medalEmojis[origIdx]}
              </Text>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  textAlign: 'center',
                }}
              >
                {entry.trader_id}
              </Text>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.secondary,
                }}
              >
                {entry.platform}
              </Text>
              {/* Metric delta */}
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color:
                    (entry.current_value ?? 0) - (entry.baseline_value ?? 0) >= 0
                      ? '#22c55e'
                      : '#ef4444',
                }}
              >
                {formatDelta(entry.baseline_value, entry.current_value, metric)}
              </Text>
              {/* Podium block */}
              <Box
                style={{
                  width: 100,
                  height,
                  background: `linear-gradient(180deg, ${alpha(medalColors[origIdx], 20)} 0%, ${alpha(medalColors[origIdx], 7)} 100%)`,
                  borderTop: `3px solid ${medalColors[origIdx]}`,
                  borderRadius: `${tokens.radius.md} ${tokens.radius.md} 0 0`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: tokens.spacing[1],
                }}
              >
                <Text
                  style={{
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: tokens.typography.fontWeight.bold,
                    color: medalColors[origIdx],
                  }}
                >
                  {medalLabels[origIdx]}
                </Text>
                {prizeCents > 0 && (
                  <Text
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.secondary,
                    }}
                  >
                    {formatPrize(Math.round(prizeCents * prizeShares[origIdx]))}
                  </Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

// ─── Standings Table ────────────────────────────────────────────────
function StandingsTable({
  entries,
  metric,
  isLive,
  lastUpdate,
  currentUserId,
  t,
}: {
  entries: CompetitionEntry[]
  metric: string
  isLive: boolean
  lastUpdate: Date | null
  currentUserId: string | null
  t: (key: string) => string
}) {
  // Platform filter — only surfaced when >1 distinct platform is present.
  const platforms = Array.from(new Set(entries.map((e) => e.platform).filter(Boolean)))
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const visible =
    platformFilter === 'all' ? entries : entries.filter((e) => e.platform === platformFilter)
  const sorted = [...visible].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))

  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* Header with live indicator */}
      <Box
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
            {t('compStandingsLive')}
          </Text>
          {isLive && (
            <Box
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 6px rgba(34,197,94,0.6)',
              }}
            />
          )}
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          {platforms.length > 1 && (
            <select
              aria-label={t('compFilterPlatform')}
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.xs,
                cursor: 'pointer',
              }}
            >
              <option value="all">{t('compAllPlatforms')}</option>
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {lastUpdate && (
            <Text
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
              }}
            >
              {t('compStandingsLastUpdate')}: {lastUpdate.toLocaleTimeString()}
            </Text>
          )}
        </Box>
      </Box>

      {sorted.length === 0 ? (
        <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text style={{ color: tokens.colors.text.secondary }}>{t('compStandingsNoData')}</Text>
        </Box>
      ) : (
        <Box style={{ overflowX: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                {[
                  t('compStandingsRank'),
                  t('compStandingsTrader'),
                  t('compStandingsPlatform'),
                  t('compStandingsValue'),
                  t('compStandingsChange'),
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      textAlign: 'left' as const,
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                      fontWeight: tokens.typography.fontWeight.medium,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry, idx) => {
                const delta = (entry.current_value ?? 0) - (entry.baseline_value ?? 0)
                const isTop3 = (entry.rank ?? 999) <= 3
                const isCurrentUser = currentUserId != null && entry.user_id === currentUserId
                const medalColor =
                  entry.rank === 1
                    ? '#FFD700'
                    : entry.rank === 2
                      ? '#C0C0C0'
                      : entry.rank === 3
                        ? '#CD7F32'
                        : undefined
                const rowBg = isCurrentUser
                  ? alpha(tokens.colors.accent.primary, 12)
                  : isTop3 && medalColor
                    ? alpha(medalColor, 3)
                    : undefined
                return (
                  <tr
                    key={entry.id}
                    style={{
                      borderBottom:
                        idx < sorted.length - 1
                          ? `1px solid ${tokens.colors.border.primary}`
                          : undefined,
                      background: rowBg,
                      boxShadow: isCurrentUser
                        ? `inset 3px 0 0 ${tokens.colors.accent.primary}`
                        : undefined,
                    }}
                  >
                    <td
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: tokens.typography.fontWeight.bold,
                        color: medalColor || tokens.colors.text.primary,
                      }}
                    >
                      {entry.rank ?? '-'}
                    </td>
                    <td
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: isTop3 || isCurrentUser ? 600 : 400,
                        maxWidth: 200,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap' as const,
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: tokens.spacing[2],
                        }}
                      >
                        {entry.trader_id}
                        {isCurrentUser && (
                          <span
                            style={{
                              padding: `0 ${tokens.spacing[1]}`,
                              borderRadius: tokens.radius.sm,
                              background: tokens.colors.accent.primary,
                              color: '#fff',
                              fontSize: tokens.typography.fontSize.xs,
                              fontWeight: tokens.typography.fontWeight.semibold,
                            }}
                          >
                            {t('compYouTag')}
                          </span>
                        )}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        fontSize: tokens.typography.fontSize.sm,
                        color: tokens.colors.text.secondary,
                      }}
                    >
                      {entry.platform}
                    </td>
                    <td
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {formatValue(entry.current_value, metric)}
                    </td>
                    <td
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {/* Metric adds a colorblind-safe ▲/▼ shape cue alongside the
                          sign-based color (DESIGN.md "Signal Accent"). */}
                      <Metric
                        as="span"
                        size="sm"
                        value={delta}
                        colorBySign
                        showArrow
                        display={formatDelta(entry.baseline_value, entry.current_value, metric)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Box>
      )}
    </Box>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────
export default function CompetitionDetailPage() {
  const { t } = useLanguage()
  const { userId, accessToken, isLoggedIn } = useAuthSession()
  const params = useParams()
  const id = params?.id as string

  const [competition, setCompetition] = useState<Competition | null>(null)
  const [entries, setEntries] = useState<CompetitionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [showJoinForm, setShowJoinForm] = useState(false)
  const [traderId, setTraderId] = useState('')
  const [platform, setPlatform] = useState('')
  const [activeTab, setActiveTab] = useState<DetailTab>('standings')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [shareCopied, setShareCopied] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const hasJoined = entries.some((e) => e.user_id === userId)

  const fetchData = useCallback(
    async (silent = false) => {
      if (!id) return
      if (!silent) setLoading(true)
      try {
        const res = await fetch(`/api/competitions/${id}`)
        const json = await res.json()
        if (json.success) {
          setCompetition(json.data.competition)
          setEntries(json.data.entries)
          setLastUpdate(new Date())
        }
      } catch {
        // silent
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [id]
  )

  // Initial fetch
  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Poll every 60s when competition is active and user is on standings tab
  useEffect(() => {
    if (competition?.status === 'active' && activeTab === 'standings') {
      pollRef.current = setInterval(() => fetchData(true), 60_000)
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [competition?.status, activeTab, fetchData])

  const handleJoin = async () => {
    if (!traderId || !platform) {
      setJoinError(t('compJoinFillFields'))
      return
    }
    setJoining(true)
    setJoinError(null)
    try {
      const res = await fetch(`/api/competitions/${id}/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ trader_id: traderId, platform }),
      })
      const json = await res.json()
      if (!json.success) {
        setJoinError(json.error || 'Failed to join')
      } else {
        setShowJoinForm(false)
        fetchData()
      }
    } catch {
      setJoinError('Network error')
    } finally {
      setJoining(false)
    }
  }

  const handleShare = async () => {
    const url = `${window.location.origin}/competitions/${id}`
    try {
      await navigator.clipboard.writeText(url)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    }
  }

  if (loading) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box
          style={{
            maxWidth: 960,
            margin: '0 auto',
            padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
          }}
        >
          <LoadingSkeleton variant="card" count={3} />
        </Box>
      </Box>
    )
  }

  if (!competition) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[4] }}>
          <EmptyState title={t('compNotFound')} />
        </Box>
      </Box>
    )
  }

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'standings', label: t('compTabStandings') },
    { key: 'info', label: t('compTabInfo') },
  ]

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          maxWidth: 960,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        {/* Breadcrumb */}
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Link
            href="/competitions"
            style={{
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('compPageTitle')}
          </Link>
          <Text
            as="span"
            style={{ color: tokens.colors.text.tertiary, margin: `0 ${tokens.spacing[2]}` }}
          >
            /
          </Text>
          <Text as="span" style={{ fontSize: tokens.typography.fontSize.sm }}>
            {competition.title}
          </Text>
        </Box>

        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Box
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: tokens.spacing[3],
            }}
          >
            <Text
              as="h1"
              style={{
                fontSize: tokens.typography.fontSize['2xl'],
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              {competition.title}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
              {/* Share button with toast */}
              <Box style={{ position: 'relative' as const }}>
                <Button variant="ghost" size="sm" onClick={handleShare}>
                  {shareCopied ? t('compShareCopied') : t('compShare')}
                </Button>
              </Box>
              {!hasJoined &&
                (competition.status === 'upcoming' || competition.status === 'active') &&
                isLoggedIn && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setShowJoinForm(!showJoinForm)}
                  >
                    {t('compJoinBtn')}
                  </Button>
                )}
            </Box>
          </Box>
          {competition.description && (
            <Text style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[3] }}>
              {competition.description}
            </Text>
          )}

          {/* Stats row */}
          <Box style={{ display: 'flex', gap: tokens.spacing[5], flexWrap: 'wrap' as const }}>
            <Box>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                }}
              >
                {t('compMetric')}
              </Text>
              <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                {metricLabel(competition.metric)}
              </Text>
            </Box>
            <Box style={{ minWidth: 160 }}>
              <CompetitionCapacityBar current={entries.length} max={competition.max_participants} />
            </Box>
            <Box>
              <CompetitionCountdown
                startAt={competition.start_at}
                endAt={competition.end_at}
                status={competition.status}
                size="md"
              />
            </Box>
            <Box>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                }}
              >
                {t('compPrize')}
              </Text>
              <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                {formatPrize(competition.prize_pool_cents)}
              </Text>
            </Box>
            <Box>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                }}
              >
                {t('compStartDate')}
              </Text>
              <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                {new Date(competition.start_at).toLocaleDateString()}
              </Text>
            </Box>
            <Box>
              <Text
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                }}
              >
                {t('compEndDate')}
              </Text>
              <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                {new Date(competition.end_at).toLocaleDateString()}
              </Text>
            </Box>
          </Box>
        </Box>

        {/* Join Form */}
        {showJoinForm && (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              marginBottom: tokens.spacing[5],
            }}
          >
            <Text
              style={{
                fontWeight: tokens.typography.fontWeight.semibold,
                marginBottom: tokens.spacing[3],
              }}
            >
              {t('compJoinTitle')}
            </Text>
            <Box
              style={{
                display: 'flex',
                gap: tokens.spacing[3],
                flexWrap: 'wrap' as const,
                marginBottom: tokens.spacing[3],
              }}
            >
              <input
                type="text"
                aria-label={t('compTraderIdPlaceholder')}
                placeholder={t('compTraderIdPlaceholder')}
                value={traderId}
                onChange={(e) => setTraderId(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 200,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
              <input
                type="text"
                aria-label={t('compPlatformPlaceholder')}
                placeholder={t('compPlatformPlaceholder')}
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 200,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>
            {joinError && (
              <Text
                style={{
                  color: '#ef4444',
                  fontSize: tokens.typography.fontSize.sm,
                  marginBottom: tokens.spacing[2],
                }}
              >
                {joinError}
              </Text>
            )}
            <Button variant="primary" size="sm" onClick={handleJoin} loading={joining}>
              {t('compConfirmJoin')}
            </Button>
          </Box>
        )}

        {/* Podium for completed competitions */}
        {competition.status === 'completed' && entries.length > 0 && (
          <Podium
            entries={entries}
            metric={competition.metric}
            prizeCents={competition.prize_pool_cents}
            t={t}
          />
        )}

        {/* Tabs */}
        <Box
          role="tablist"
          aria-label={t('compLeaderboard')}
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            marginBottom: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            paddingBottom: tokens.spacing[1],
          }}
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.key
            return (
              <button
                key={tab.key}
                role="tab"
                id={`comp-detail-tab-${tab.key}`}
                aria-selected={selected}
                aria-controls="comp-detail-tabpanel"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: selected ? tokens.colors.bg.tertiary : 'transparent',
                  color: selected ? tokens.colors.text.primary : tokens.colors.text.secondary,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: selected
                    ? tokens.typography.fontWeight.semibold
                    : tokens.typography.fontWeight.normal,
                  transition: 'all 0.15s ease',
                }}
              >
                {tab.label}
                {tab.key === 'standings' && competition.status === 'active' && (
                  <Box
                    as="span"
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#22c55e',
                      marginLeft: tokens.spacing[1],
                      verticalAlign: 'middle',
                    }}
                  />
                )}
              </button>
            )
          })}
        </Box>

        {/* Tab Content */}
        <Box
          id="comp-detail-tabpanel"
          role="tabpanel"
          aria-labelledby={`comp-detail-tab-${activeTab}`}
        >
          {activeTab === 'standings' ? (
            <StandingsTable
              entries={entries}
              metric={competition.metric}
              isLive={competition.status === 'active'}
              lastUpdate={lastUpdate}
              currentUserId={userId ?? null}
              t={t}
            />
          ) : (
            /* Info tab - original leaderboard view with details */
            <Box
              style={{
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
                overflow: 'hidden',
              }}
            >
              <Box
                style={{
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                  {t('compLeaderboard')}
                </Text>
              </Box>

              {entries.length === 0 ? (
                <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
                  <Text style={{ color: tokens.colors.text.secondary }}>{t('compNoEntries')}</Text>
                </Box>
              ) : (
                <Box style={{ overflowX: 'auto' as const }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                        {[
                          '#',
                          t('compColTrader'),
                          t('compColPlatform'),
                          t('compColBaseline'),
                          t('compColCurrent'),
                          t('compColDelta'),
                        ].map((h) => (
                          <th
                            key={h}
                            style={{
                              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                              textAlign: 'left' as const,
                              fontSize: tokens.typography.fontSize.xs,
                              color: tokens.colors.text.tertiary,
                              fontWeight: tokens.typography.fontWeight.medium,
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => {
                        const delta = (entry.current_value ?? 0) - (entry.baseline_value ?? 0)
                        const isPositive = delta >= 0
                        return (
                          <tr
                            key={entry.id}
                            style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}
                          >
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                                fontWeight: tokens.typography.fontWeight.semibold,
                              }}
                            >
                              {entry.rank ?? '-'}
                            </td>
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                            >
                              {entry.trader_id}
                            </td>
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                                color: tokens.colors.text.secondary,
                              }}
                            >
                              {entry.platform}
                            </td>
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                            >
                              {formatValue(entry.baseline_value, competition.metric)}
                            </td>
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                            >
                              {formatValue(entry.current_value, competition.metric)}
                            </td>
                            <td
                              style={{
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                fontSize: tokens.typography.fontSize.sm,
                                fontWeight: tokens.typography.fontWeight.semibold,
                                color: isPositive ? '#22c55e' : '#ef4444',
                              }}
                            >
                              {formatDelta(
                                entry.baseline_value,
                                entry.current_value,
                                competition.metric
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}
