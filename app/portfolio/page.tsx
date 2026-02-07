'use client'

import { useState, useEffect, Suspense, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import RadarChart from '@/app/components/premium/RadarChart'

// ── Types ──────────────────────────────────────────────────

interface PortfolioTrader {
  trader_id: string
  source: string
  handle: string
  allocation_pct: number
  reason: string
  risk_level: 'low' | 'medium' | 'high'
  expected_contribution: { roi: number; drawdown: number }
}

interface PortfolioSuggestion {
  id: string
  name: string
  description: string
  risk_level: 'conservative' | 'balanced' | 'aggressive'
  traders: PortfolioTrader[]
  expected_metrics: { roi: number; max_drawdown: number; sharpe_ratio: number }
  diversification_score: number
  created_at: string
}

type RiskTab = 'conservative' | 'balanced' | 'aggressive'

// ── Helpers ────────────────────────────────────────────────

const RISK_COLORS: Record<string, string> = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#ef4444',
}

const CHART_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981']

function RiskBadge({ level, t }: { level: string; t: (k: string) => string }) {
  const labelMap: Record<string, string> = {
    low: t('portfolioLow'),
    medium: t('portfolioMedium'),
    high: t('portfolioHigh'),
  }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: tokens.radius.full,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        background: RISK_COLORS[level] ?? tokens.colors.text.tertiary,
      }}
    >
      {labelMap[level] ?? level}
    </span>
  )
}

// ── Main Content ───────────────────────────────────────────

function PortfolioContent() {
  const router = useRouter()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, email } = useAuthSession()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<PortfolioSuggestion[]>([])
  const [activeTab, setActiveTab] = useState<RiskTab>('balanced')
  const [poolSize, setPoolSize] = useState(0)

  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login?redirect=/portfolio')
    }
  }, [authChecked, accessToken, router])

  const fetchSuggestions = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/portfolio/suggestions', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!res.ok) {
        const data = await res.json()
        if (res.status === 403) {
          setError(t('portfolioProRequired'))
        } else {
          setError(data.message || t('errorOccurred'))
        }
        return
      }

      const data = await res.json()
      setSuggestions(data.data?.suggestions ?? data.suggestions ?? [])
      setPoolSize(data.data?.trader_pool_size ?? data.trader_pool_size ?? 0)
    } catch {
      setError(t('errorOccurred'))
    } finally {
      setLoading(false)
    }
  }, [accessToken, t])

  useEffect(() => {
    if (accessToken) fetchSuggestions()
  }, [accessToken, fetchSuggestions])

  const activeSuggestion = suggestions.find(s => s.risk_level === activeTab) ?? null

  // Build radar data from the active suggestion's traders
  const radarData = activeSuggestion
    ? [
        { label: 'ROI', values: activeSuggestion.traders.map(tr => Math.min(Math.max(tr.expected_contribution.roi, 0), 100)) },
        { label: t('compareMDD'), values: activeSuggestion.traders.map(tr => Math.max(100 - tr.expected_contribution.drawdown * 5, 0)) },
        { label: t('portfolioAllocation'), values: activeSuggestion.traders.map(tr => tr.allocation_pct) },
      ]
    : []

  const tabs: { key: RiskTab; label: string; desc: string; icon: string }[] = [
    { key: 'conservative', label: t('portfolioConservative'), desc: t('portfolioConservativeDesc'), icon: 'S' },
    { key: 'balanced', label: t('portfolioBalanced'), desc: t('portfolioBalancedDesc'), icon: 'B' },
    { key: 'aggressive', label: t('portfolioAggressive'), desc: t('portfolioAggressiveDesc'), icon: 'A' },
  ]

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1000, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="lg" color="tertiary">{t('portfolioLoading')}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* Background */}
      <Box
        style={{
          position: 'fixed', inset: 0,
          background: `radial-gradient(ellipse at 30% 30%, ${tokens.colors.accent.primary}08 0%, transparent 50%),
                       radial-gradient(ellipse at 70% 70%, ${tokens.colors.accent.brand}06 0%, transparent 50%)`,
          pointerEvents: 'none', zIndex: 0,
        }}
      />

      <TopNav email={email} />

      <Box style={{ maxWidth: 1000, margin: '0 auto', padding: tokens.spacing[6], position: 'relative', zIndex: 1 }}>
        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[6], display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
          <Box>
            <Text size="2xl" weight="black" className="gradient-text">
              {t('portfolioSuggestions')}
            </Text>
            <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {t('portfolioDesc')}
              {poolSize > 0 && (
                <span style={{ marginLeft: 8, opacity: 0.6 }}>({poolSize} traders)</span>
              )}
            </Text>
          </Box>
          <Button variant="secondary" size="sm" onClick={fetchSuggestions}>
            {t('portfolioRefresh')}
          </Button>
        </Box>

        {/* Error */}
        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: `${tokens.colors.accent.error}15`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.accent.error}30`,
              marginBottom: tokens.spacing[4],
              textAlign: 'center',
            }}
          >
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>{error}</Text>
            {error === t('portfolioProRequired') && (
              <Button variant="primary" size="sm" onClick={() => router.push('/pricing')} style={{ marginTop: 12 }}>
                {t('upgradeToPro')}
              </Button>
            )}
          </Box>
        )}

        {/* Risk tabs */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[3],
            marginBottom: tokens.spacing[6],
          }}
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.xl,
                  border: isActive
                    ? `2px solid ${tokens.colors.accent.primary}`
                    : `1px solid ${tokens.colors.border.primary}`,
                  background: isActive ? `${tokens.colors.accent.primary}12` : tokens.colors.bg.secondary,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s',
                }}
              >
                <Text size="lg" style={{ marginBottom: 4 }}>{tab.icon}</Text>
                <Text size="sm" weight="bold" style={{ color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary }}>
                  {tab.label}
                </Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4, lineHeight: '1.4' }}>
                  {tab.desc}
                </Text>
              </button>
            )
          })}
        </Box>

        {/* Active suggestion content */}
        {!activeSuggestion ? (
          <Box
            style={{
              padding: tokens.spacing[8],
              textAlign: 'center',
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="lg" color="tertiary">{t('portfolioNoData')}</Text>
          </Box>
        ) : (
          <>
            {/* Expected metrics cards */}
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[6],
              }}
            >
              {[
                {
                  label: t('portfolioExpectedROI'),
                  value: `${activeSuggestion.expected_metrics.roi >= 0 ? '+' : ''}${activeSuggestion.expected_metrics.roi.toFixed(1)}%`,
                  color: activeSuggestion.expected_metrics.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                },
                {
                  label: t('portfolioExpectedMDD'),
                  value: `-${activeSuggestion.expected_metrics.max_drawdown.toFixed(1)}%`,
                  color: tokens.colors.accent.error,
                },
                {
                  label: t('portfolioSharpeRatio'),
                  value: activeSuggestion.expected_metrics.sharpe_ratio.toFixed(2),
                  color: activeSuggestion.expected_metrics.sharpe_ratio >= 1 ? tokens.colors.accent.success : tokens.colors.text.primary,
                },
                {
                  label: t('portfolioDiversification'),
                  value: `${activeSuggestion.diversification_score}/100`,
                  color: activeSuggestion.diversification_score >= 60 ? tokens.colors.accent.success : tokens.colors.accent.warning,
                },
              ].map((card) => (
                <Box
                  key={card.label}
                  style={{
                    padding: tokens.spacing[4],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                  }}
                >
                  <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>
                    {card.label}
                  </Text>
                  <Text size="lg" weight="black" style={{ color: card.color }}>
                    {card.value}
                  </Text>
                </Box>
              ))}
            </Box>

            {/* Traders list */}
            <Box
              style={{
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
                overflow: 'hidden',
                marginBottom: tokens.spacing[6],
              }}
            >
              {/* Table header */}
              <Box
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 80px 80px 90px 2fr 60px',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: tokens.colors.bg.tertiary,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {[t('trader'), t('portfolioAllocation'), t('portfolioRiskLevel'), t('portfolioExpectedContrib'), t('portfolioReason'), ''].map((h, i) => (
                  <Text key={i} size="xs" weight="bold" color="tertiary">{h}</Text>
                ))}
              </Box>

              {/* Rows */}
              {activeSuggestion.traders.map((trader, idx) => (
                <Box
                  key={trader.trader_id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 80px 80px 90px 2fr 60px',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: idx < activeSuggestion.traders.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                    alignItems: 'center',
                    background: idx % 2 === 0 ? 'transparent' : `${tokens.colors.bg.tertiary}50`,
                  }}
                >
                  {/* Trader name */}
                  <Box>
                    <Text size="sm" weight="bold" style={{ marginBottom: 2 }}>
                      {trader.handle.length > 18 ? `${trader.handle.slice(0, 8)}...${trader.handle.slice(-6)}` : trader.handle}
                    </Text>
                    <Text size="xs" color="tertiary">{trader.source}</Text>
                  </Box>

                  {/* Allocation bar */}
                  <Box>
                    <Text size="sm" weight="black" style={{ color: CHART_COLORS[idx % CHART_COLORS.length] }}>
                      {trader.allocation_pct}%
                    </Text>
                    <Box
                      style={{
                        height: 4,
                        borderRadius: 2,
                        background: tokens.colors.bg.tertiary,
                        marginTop: 4,
                        overflow: 'hidden',
                      }}
                    >
                      <Box
                        style={{
                          width: `${trader.allocation_pct}%`,
                          height: '100%',
                          background: CHART_COLORS[idx % CHART_COLORS.length],
                          borderRadius: 2,
                        }}
                      />
                    </Box>
                  </Box>

                  {/* Risk level */}
                  <Box>
                    <RiskBadge level={trader.risk_level} t={t} />
                  </Box>

                  {/* Expected contribution */}
                  <Box>
                    <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                      +{trader.expected_contribution.roi.toFixed(1)}% ROI
                    </Text>
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      -{trader.expected_contribution.drawdown.toFixed(1)}% DD
                    </Text>
                  </Box>

                  {/* Reason */}
                  <Text size="xs" color="secondary" style={{ lineHeight: '1.4' }}>
                    {trader.reason}
                  </Text>

                  {/* Link */}
                  <Link
                    href={`/trader/${encodeURIComponent(trader.trader_id)}`}
                    style={{
                      fontSize: 12,
                      color: tokens.colors.accent.primary,
                      textDecoration: 'none',
                    }}
                  >
                    {t('portfolioViewTrader')}
                  </Link>
                </Box>
              ))}
            </Box>

            {/* Radar chart for the portfolio */}
            {radarData.length > 0 && activeSuggestion.traders.length >= 2 && (
              <Box
                style={{
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.xl,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  padding: tokens.spacing[6],
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <RadarChart
                  data={radarData}
                  traderNames={activeSuggestion.traders.map(tr => tr.handle.slice(0, 10))}
                  colors={CHART_COLORS}
                  size={300}
                />
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}

// ── Page Export ─────────────────────────────────────────────

export default function PortfolioPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#888' }}>Loading...</Text>
      </Box>
    }>
      <PortfolioContent />
    </Suspense>
  )
}
