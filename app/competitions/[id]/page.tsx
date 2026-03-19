'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
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
  if (metric === 'pnl') return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (metric === 'sharpe') return value.toFixed(3)
  if (metric === 'max_drawdown') return `${value.toFixed(2)}%`
  return String(value)
}

function formatDelta(baseline: number | null, current: number | null, metric: string): string {
  if (baseline == null || current == null) return '-'
  const delta = current - baseline
  const prefix = delta >= 0 ? '+' : ''
  if (metric === 'roi' || metric === 'max_drawdown') return `${prefix}${delta.toFixed(2)}%`
  if (metric === 'pnl') return `${prefix}$${delta.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `${prefix}${delta.toFixed(3)}`
}

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

  const hasJoined = entries.some((e) => e.user_id === userId)

  const fetchData = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const res = await fetch(`/api/competitions/${id}`)
      const json = await res.json()
      if (json.success) {
        setCompetition(json.data.competition)
        setEntries(json.data.entries)
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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

  const handleShare = () => {
    const url = `${window.location.origin}/competitions/${id}`
    navigator.clipboard.writeText(url)
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  if (!competition) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text>{t('compNotFound')}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 960, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {/* Breadcrumb */}
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Link href="/competitions" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontSize: tokens.typography.fontSize.sm }}>
            {t('compPageTitle')}
          </Link>
          <Text as="span" style={{ color: tokens.colors.text.tertiary, margin: `0 ${tokens.spacing[2]}` }}>/</Text>
          <Text as="span" style={{ fontSize: tokens.typography.fontSize.sm }}>{competition.title}</Text>
        </Box>

        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
            <Text as="h1" style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 700 }}>
              {competition.title}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <Button variant="ghost" size="sm" onClick={handleShare}>
                {t('compShare')}
              </Button>
              {!hasJoined && (competition.status === 'upcoming' || competition.status === 'active') && isLoggedIn && (
                <Button variant="primary" size="sm" onClick={() => setShowJoinForm(!showJoinForm)}>
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
              <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compMetric')}</Text>
              <Text style={{ fontWeight: 600 }}>{metricLabel(competition.metric)}</Text>
            </Box>
            <Box>
              <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compParticipants')}</Text>
              <Text style={{ fontWeight: 600 }}>{entries.length}/{competition.max_participants}</Text>
            </Box>
            <Box>
              <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compPrize')}</Text>
              <Text style={{ fontWeight: 600 }}>{competition.prize_pool_cents > 0 ? `$${(competition.prize_pool_cents / 100).toFixed(0)}` : 'Free'}</Text>
            </Box>
            <Box>
              <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compStartDate')}</Text>
              <Text style={{ fontWeight: 600 }}>{new Date(competition.start_at).toLocaleDateString()}</Text>
            </Box>
            <Box>
              <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compEndDate')}</Text>
              <Text style={{ fontWeight: 600 }}>{new Date(competition.end_at).toLocaleDateString()}</Text>
            </Box>
          </Box>
        </Box>

        {/* Join Form */}
        {showJoinForm && (
          <Box style={{
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            marginBottom: tokens.spacing[5],
          }}>
            <Text style={{ fontWeight: 600, marginBottom: tokens.spacing[3] }}>{t('compJoinTitle')}</Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[3], flexWrap: 'wrap' as const, marginBottom: tokens.spacing[3] }}>
              <input
                type="text"
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
              <Text style={{ color: '#ef4444', fontSize: tokens.typography.fontSize.sm, marginBottom: tokens.spacing[2] }}>{joinError}</Text>
            )}
            <Button variant="primary" size="sm" onClick={handleJoin} loading={joining}>
              {t('compConfirmJoin')}
            </Button>
          </Box>
        )}

        {/* Leaderboard */}
        <Box style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflow: 'hidden',
        }}>
          <Box style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}>
            <Text style={{ fontWeight: 600 }}>{t('compLeaderboard')}</Text>
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
                    {['#', t('compColTrader'), t('compColPlatform'), t('compColBaseline'), t('compColCurrent'), t('compColDelta')].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                          textAlign: 'left' as const,
                          fontSize: tokens.typography.fontSize.xs,
                          color: tokens.colors.text.tertiary,
                          fontWeight: 500,
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
                      <tr key={entry.id} style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                        <td style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, fontSize: tokens.typography.fontSize.sm, fontWeight: 600 }}>
                          {entry.rank ?? '-'}
                        </td>
                        <td style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, fontSize: tokens.typography.fontSize.sm }}>
                          {entry.trader_id}
                        </td>
                        <td style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary }}>
                          {entry.platform}
                        </td>
                        <td style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, fontSize: tokens.typography.fontSize.sm }}>
                          {formatValue(entry.baseline_value, competition.metric)}
                        </td>
                        <td style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, fontSize: tokens.typography.fontSize.sm }}>
                          {formatValue(entry.current_value, competition.metric)}
                        </td>
                        <td style={{
                          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: 600,
                          color: isPositive ? '#22c55e' : '#ef4444',
                        }}>
                          {formatDelta(entry.baseline_value, entry.current_value, competition.metric)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}
