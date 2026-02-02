'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import TraderComparison from '@/app/components/premium/TraderComparison'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

function CompareContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, email } = useAuthSession()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [traders, setTraders] = useState<TraderCompareData[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{
    source_trader_id: string
    source: string
    roi: number | null
    arena_score: number | null
    avatar_url: string | null
  }>>([])
  const [searching, setSearching] = useState(false)
  const [isPro, setIsPro] = useState(false)

  // Check auth
  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login?redirect=/compare')
    }
  }, [authChecked, accessToken, router])

  // Init
  useEffect(() => {
    if (!accessToken) return

    const init = async () => {
      try {
        const subRes = await fetch('/api/subscription', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (subRes.ok) {
          const subData = await subRes.json()
          const tier = subData.subscription?.tier || 'free'
          setIsPro(tier === 'pro')
        }

        const ids = searchParams.get('ids')
        if (ids) {
          await loadTraders(ids.split(','))
        }
      } catch (err) {
        console.error('Init failed:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, searchParams])

  // Load traders with equity curve data
  const loadTraders = async (traderIds: string[]) => {
    if (!accessToken || traderIds.length === 0) return

    try {
      const res = await fetch(`/api/compare?ids=${traderIds.join(',')}&include_equity=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!res.ok) {
        const data = await res.json()
        if (res.status === 403) {
          setError(t('portfolioProRequired'))
        } else {
          setError(data.error || t('errorOccurred'))
        }
        return
      }

      const data = await res.json()
      setTraders(data.traders || [])
      setError(null)
    } catch (err) {
      console.error('Load traders failed:', err)
      setError(t('errorOccurred'))
    }
  }

  // Search
  const handleSearch = async () => {
    if (!searchInput.trim()) return

    const sanitizedInput = searchInput.trim()
      .slice(0, 100)
      .replace(/[\\%_]/g, c => `\\${c}`)

    if (!sanitizedInput) return

    setSearching(true)
    try {
      const { data, error } = await supabase
        .from('trader_sources')
        .select('source_trader_id, source, roi, arena_score, avatar_url')
        .or(`source_trader_id.ilike.%${sanitizedInput}%`)
        .order('arena_score', { ascending: false, nullsFirst: false })
        .limit(10)

      if (error) throw error
      setSearchResults(data || [])
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setSearching(false)
    }
  }

  // Add trader
  const handleAddTrader = async (traderId: string) => {
    if (traders.length >= 5) {
      showToast(t('compareMax5'), 'warning')
      return
    }
    if (traders.some(t => t.id === traderId)) {
      showToast(t('compareAlreadyAdded'), 'warning')
      return
    }

    const newIds = [...traders.map(t => t.id), traderId]
    await loadTraders(newIds)
    router.replace(`/compare?ids=${newIds.join(',')}`, { scroll: false })
    setSearchInput('')
    setSearchResults([])
  }

  // Remove trader
  const handleRemoveTrader = (traderId: string) => {
    const newTraders = traders.filter(t => t.id !== traderId)
    setTraders(newTraders)
    if (newTraders.length > 0) {
      router.replace(`/compare?ids=${newTraders.map(t => t.id).join(',')}`, { scroll: false })
    } else {
      router.replace('/compare', { scroll: false })
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="lg" color="tertiary">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at 20% 20%, ${tokens.colors.accent.primary}08 0%, transparent 50%),
                       radial-gradient(ellipse at 80% 80%, ${tokens.colors.accent.brand}06 0%, transparent 50%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], position: 'relative', zIndex: 1 }}>
        {/* Title */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" className="gradient-text">
            {t('compareTraders')}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            {t('compareDesc')}
          </Text>
        </Box>

        {/* Pro gate */}
        {!isPro && (
          <Box
            style={{
              padding: tokens.spacing[6],
              background: 'var(--color-pro-glow)',
              borderRadius: tokens.radius.xl,
              border: '1px solid var(--color-pro-gradient-start)',
              marginBottom: tokens.spacing[6],
              textAlign: 'center',
            }}
          >
            <Box
              style={{
                width: 48, height: 48, borderRadius: tokens.radius.lg,
                background: 'var(--color-blur-overlay)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto', marginBottom: tokens.spacing[3],
              }}
            >
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="var(--color-pro-gradient-start)" strokeWidth="2">
                <path d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z" />
                <path d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11" strokeLinecap="round" />
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('proRequired')}
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('featureTraderCompareDesc')}
            </Text>
            <Button
              variant="primary"
              onClick={() => router.push('/pricing')}
              style={{
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
              }}
            >
              {t('upgradeToPro')}
            </Button>
          </Box>
        )}

        {/* Error */}
        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: `${tokens.colors.accent.error}15`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.accent.error}30`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>{error}</Text>
          </Box>
        )}

        {/* Search bar */}
        {isPro && (
          <Box
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('compareAddTrader')} ({traders.length}/5)
            </Text>

            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={t('compareSearchPlaceholder')}
                style={{
                  flex: 1,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
              <Button
                variant="secondary"
                onClick={handleSearch}
                disabled={searching || !searchInput.trim()}
              >
                {searching ? t('compareSearching') : t('compareSearchBtn')}
              </Button>
            </Box>

            {/* Search results */}
            {searchResults.length > 0 && (
              <Box
                style={{
                  marginTop: tokens.spacing[3],
                  maxHeight: 300,
                  overflowY: 'auto',
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {searchResults.map((result) => (
                  <Box
                    key={`${result.source_trader_id}-${result.source}`}
                    onClick={() => handleAddTrader(result.source_trader_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: tokens.spacing[3],
                      cursor: 'pointer',
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      transition: 'background 0.2s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = tokens.colors.bg.secondary}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <Box>
                      <Text size="sm" weight="semibold">
                        {result.source_trader_id.length > 20
                          ? `${result.source_trader_id.slice(0, 8)}...${result.source_trader_id.slice(-6)}`
                          : result.source_trader_id}
                      </Text>
                      <Text size="xs" color="tertiary">{result.source}</Text>
                    </Box>
                    <Box style={{ textAlign: 'right' }}>
                      <Text
                        size="sm"
                        weight="bold"
                        style={{
                          color: (result.roi ?? 0) >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                        }}
                      >
                        {(result.roi ?? 0) >= 0 ? '+' : ''}{(result.roi ?? 0).toFixed(2)}%
                      </Text>
                      {result.arena_score != null && (
                        <Text size="xs" color="secondary">
                          Score: {result.arena_score.toFixed(1)}
                        </Text>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {/* Comparison component */}
        {isPro && (
          <TraderComparison
            traders={traders}
            onRemove={handleRemoveTrader}
            showRemoveButton={true}
          />
        )}
      </Box>
    </Box>
  )
}

export default function ComparePage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#888' }}>Loading...</Text>
      </Box>
    }>
      <CompareContent />
    </Suspense>
  )
}
