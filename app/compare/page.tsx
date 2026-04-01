'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import TraderComparison from '@/app/components/premium/TraderComparison'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'
import ExportButton from '@/app/components/common/ExportButton'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { logger } from '@/lib/logger'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'

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
  const { tryUnlock } = useAchievements()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [traders, setTraders] = useState<TraderCompareData[]>([])
  // Search state removed - traders added from followed list only
  const [isPro, setIsPro] = useState(BETA_PRO_FEATURES_FREE)
  const [followedTraders, setFollowedTraders] = useState<Array<{
    id: string
    handle: string
    type: string
    avatar_url?: string
    roi?: number
    source?: string
    arena_score?: number
  }>>([])
  const [followedLoading, setFollowedLoading] = useState(false)

  // Check auth
  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login?redirect=/compare')
    }
  }, [authChecked, accessToken, router])

  // Init — stop loading once auth check completes (even if not logged in)
  useEffect(() => {
    if (!authChecked) return

    if (!accessToken) {
      setLoading(false)
      return
    }

    const init = async () => {
      try {
        const subRes = await fetch('/api/subscription', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (subRes.ok) {
          const subData = await subRes.json()
          const tier = subData.subscription?.tier || 'free'
          setIsPro(BETA_PRO_FEATURES_FREE || tier === 'pro')
        }

        const ids = searchParams.get('ids')
        if (ids) {
          await loadTraders(ids.split(','))
        }
      } catch (err) {
        logger.error('Init failed:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTraders is stable; including it would cause refetch loops
  }, [authChecked, accessToken, searchParams])

  // Fallback: if Privy SDK hasn't loaded after 3s, stop loading anyway
  useEffect(() => {
    const timer = setTimeout(() => {
      if (loading) setLoading(false)
    }, 3000)
    return () => clearTimeout(timer)
  }, [loading])

  // Fetch followed traders
  useEffect(() => {
    if (!accessToken) return

    const fetchFollowed = async () => {
      setFollowedLoading(true)
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return

        const res = await fetch(`/api/following?userId=${user.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (res.ok) {
          const data = await res.json()
          const traders = (data.items || []).filter((item: { type: string }) => item.type === 'trader')
          setFollowedTraders(traders)
        }
      } catch (err) {
        logger.error('Fetch followed traders failed:', err)
      } finally {
        setFollowedLoading(false)
      }
    }

    fetchFollowed()
  }, [accessToken])

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
      if ((data.traders || []).length >= 2) {
        tryUnlock('first_comparison')
      }
    } catch (err) {
      logger.error('Load traders failed:', err)
      setError(t('errorOccurred'))
    }
  }

  // Add trader
  const handleAddTrader = async (traderId: string) => {
    if (traders.length >= 10) {
      showToast(t('compareMax10'), 'warning')
      return
    }
    if (traders.some(t => t.id === traderId)) {
      showToast(t('compareAlreadyAdded'), 'warning')
      return
    }

    const newIds = [...traders.map(t => t.id), traderId]
    await loadTraders(newIds)
    router.replace(`/compare?ids=${newIds.join(',')}`, { scroll: false })
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
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <LoadingSkeleton variant="detail" count={2} />
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

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100, position: 'relative', zIndex: 1 }}>
        {/* Title */}
        <Box style={{ marginBottom: tokens.spacing[6], display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box>
            <Text size="2xl" weight="black" className="gradient-text">
              {t('compareTraders')}
            </Text>
            <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              {t('compareDesc')}
            </Text>
          </Box>
          {traders.length > 0 && isPro && (
            <ExportButton
              onExport={async (format) => {
                const { exportToCSV, exportToJSON, exportToPDF } = await import('@/lib/utils/export')
                const rows = traders.map(t => ({
                  handle: t.handle || t.id,
                  source: t.source,
                  roi: t.roi,
                  roi_7d: t.roi_7d ?? '',
                  roi_30d: t.roi_30d ?? '',
                  pnl: t.pnl ?? '',
                  win_rate: t.win_rate ?? '',
                  max_drawdown: t.max_drawdown ?? '',
                  arena_score: t.arena_score ?? '',
                  trades_count: t.trades_count ?? '',
                }))
                const filename = `compare-${traders.map(t => t.handle || t.id).join('-')}`
                if (format === 'json') exportToJSON(rows, filename)
                else if (format === 'pdf') exportToPDF(rows as unknown as Record<string, unknown>[], filename)
                else exportToCSV(rows as unknown as Record<string, unknown>[], filename)
              }}
            />
          )}
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

        {/* Followed traders */}
        {isPro && (
          <Box
            style={{
              marginBottom: tokens.spacing[4],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('compareFromFollowing')}
            </Text>

            {!accessToken ? (
              <Text size="sm" color="tertiary">
                {t('compareLoginToSelect')}
              </Text>
            ) : followedLoading ? (
              <Text size="sm" color="tertiary">{t('loading')}</Text>
            ) : followedTraders.length === 0 ? (
              <Text size="sm" color="tertiary">
                {t('compareNoFollowed')}
              </Text>
            ) : (
              <Box
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: tokens.spacing[2],
                }}
              >
                {followedTraders.map((ft) => {
                  const isAdded = traders.some(t => t.id === ft.id)
                  return (
                    <Box
                      key={ft.id}
                      onClick={() => !isAdded && handleAddTrader(ft.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.lg,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: isAdded ? `${tokens.colors.bg.tertiary}` : tokens.colors.bg.primary,
                        cursor: isAdded ? 'not-allowed' : 'pointer',
                        opacity: isAdded ? 0.45 : 1,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={e => {
                        if (!isAdded) e.currentTarget.style.borderColor = tokens.colors.accent.primary
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                      }}
                    >
                      {ft.avatar_url ? (
                        <img
                          src={ft.avatar_url.startsWith('data:') ? ft.avatar_url : '/api/avatar?url=' + encodeURIComponent(ft.avatar_url)}
                          alt={ft.handle || 'Trader avatar'}
                          width={32}
                          height={32}
                          loading="lazy"
                          style={{
                            width: 32, height: 32,
                            borderRadius: tokens.radius.full,
                            objectFit: 'cover',
                            flexShrink: 0,
                          }}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <Box
                          style={{
                            width: 32, height: 32,
                            borderRadius: tokens.radius.full,
                            background: `linear-gradient(135deg, hsl(${Math.abs(ft.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360}, 75%, 45%), hsl(${Math.abs(ft.id.split('').reverse().reduce((a, c) => a + c.charCodeAt(0), 0)) % 360}, 75%, 55%))`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <Text size="xs" style={{ color: 'var(--foreground)', fontWeight: 700 }}>
                            {(ft.handle || '?')[0].toUpperCase()}
                          </Text>
                        </Box>
                      )}
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Text size="xs" weight="semibold" style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {ft.handle || ft.id.slice(0, 8)}
                        </Text>
                        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                          <Text size="xs" color="tertiary">{ft.source || ''}</Text>
                          <Text
                            size="xs"
                            weight="bold"
                            style={{
                              color: (ft.roi ?? 0) >= 0
                                ? tokens.colors.accent.success
                                : tokens.colors.accent.error,
                            }}
                          >
                            {(ft.roi ?? 0) >= 0 ? '+' : ''}{(ft.roi ?? 0).toFixed(1)}%
                          </Text>
                        </Box>
                      </Box>
                      {isAdded && (
                        <Text size="xs" color="tertiary" style={{ flexShrink: 0 }}>
                          {t('compareAdded')}
                        </Text>
                      )}
                    </Box>
                  )
                })}
              </Box>
            )}
          </Box>
        )}

        {/* Search bar removed - traders can only be added from followed list above */}

        {/* Comparison component */}
        {isPro && (
          <TraderComparison
            traders={traders}
            onRemove={handleRemoveTrader}
            showRemoveButton={true}
          />
        )}
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}


export default function ComparePage() {
  const { t } = useLanguage()
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: 'var(--color-text-secondary)' }}>{t('loading')}</Text>
      </Box>
    }>
      <CompareContent />
    </Suspense>
  )
}
