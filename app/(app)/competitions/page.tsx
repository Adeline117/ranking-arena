'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'

interface Competition {
  id: string
  title: string
  description: string | null
  metric: string
  start_at: string
  end_at: string
  entry_fee_cents: number
  max_participants: number
  prize_pool_cents: number
  status: string
  participant_count: number
  created_at: string
}

type TabStatus = 'upcoming' | 'active' | 'completed'

function formatTimeRemaining(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff <= 0) return 'Ended'
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  if (days > 0) return `${days}d ${hours}h`
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  return `${hours}h ${mins}m`
}

function formatPrize(cents: number): string {
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toFixed(0)}`
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

export default function CompetitionsPage() {
  const { t } = useLanguage()
  const [tab, setTab] = useState<TabStatus>('active')
  const [competitions, setCompetitions] = useState<Competition[]>([])
  const [loading, setLoading] = useState(true)
  // Per-tab cache to avoid refetch on tab switch
  const tabCacheRef = useRef<Record<string, { data: Competition[]; ts: number }>>({})

  const fetchCompetitions = useCallback(async (status: TabStatus) => {
    // Serve from cache if fresh (<5 min)
    const cached = tabCacheRef.current[status]
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      setCompetitions(cached.data)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/competitions?status=${status}&limit=20`)
      const json = await res.json()
      if (json.success) {
        const data = json.data.competitions
        tabCacheRef.current[status] = { data, ts: Date.now() }
        setCompetitions(data)
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCompetitions(tab)
  }, [tab, fetchCompetitions])

  const tabs: { key: TabStatus; label: string }[] = [
    { key: 'active', label: t('compTabActive') },
    { key: 'upcoming', label: t('compTabUpcoming') },
    { key: 'completed', label: t('compTabCompleted') },
  ]

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 960, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {/* Header */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Text as="h1" style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 700 }}>
            {t('compPageTitle')}
          </Text>
          <Link href="/competitions/create" style={{ textDecoration: 'none' }}>
            <Button variant="primary" size="sm">
              {t('compCreateBtn')}
            </Button>
          </Link>
        </Box>

        {/* Tabs */}
        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginBottom: tokens.spacing[5], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[1] }}>
          {tabs.map((t_) => (
            <button
              key={t_.key}
              onClick={() => setTab(t_.key)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                background: tab === t_.key ? tokens.colors.bg.tertiary : 'transparent',
                color: tab === t_.key ? tokens.colors.text.primary : tokens.colors.text.secondary,
                border: 'none',
                borderRadius: tokens.radius.md,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tab === t_.key ? 600 : 400,
                transition: 'all 0.15s ease',
              }}
            >
              {t_.label}
            </button>
          ))}
        </Box>

        {/* List */}
        {loading ? (
          <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
            <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
          </Box>
        ) : competitions.length === 0 ? (
          <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
            <Text style={{ color: tokens.colors.text.secondary }}>{t('compNoCompetitions')}</Text>
          </Box>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {competitions.map((comp) => (
              <Link key={comp.id} href={`/competitions/${comp.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <Box
                  style={{
                    padding: tokens.spacing[4],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                    <Text style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 600 }}>{comp.title}</Text>
                    <Box
                      style={{
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        background: comp.status === 'active' ? 'rgba(34,197,94,0.15)' : comp.status === 'upcoming' ? 'rgba(59,130,246,0.15)' : 'rgba(156,163,175,0.15)',
                        color: comp.status === 'active' ? '#22c55e' : comp.status === 'upcoming' ? '#3b82f6' : tokens.colors.text.secondary,
                        borderRadius: tokens.radius.sm,
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: 500,
                        textTransform: 'uppercase' as const,
                      }}
                    >
                      {comp.status}
                    </Box>
                  </Box>
                  {comp.description && (
                    <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[3] }}>
                      {comp.description}
                    </Text>
                  )}
                  <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' as const }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compMetric')}:</Text>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 500 }}>{metricLabel(comp.metric)}</Text>
                    </Box>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compParticipants')}:</Text>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 500 }}>{comp.participant_count}/{comp.max_participants}</Text>
                    </Box>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>{t('compPrize')}:</Text>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 500 }}>{formatPrize(comp.prize_pool_cents)}</Text>
                    </Box>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                        {comp.status === 'completed' ? t('compEnded') : t('compTimeLeft')}:
                      </Text>
                      <Text style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 500 }}>
                        {comp.status === 'completed'
                          ? new Date(comp.end_at).toLocaleDateString()
                          : formatTimeRemaining(comp.end_at)}
                      </Text>
                    </Box>
                  </Box>
                </Box>
              </Link>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}
