'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { logger } from '@/lib/logger'

interface LinkedTraderStats {
  arena_score: number | null
  roi: number | null
  pnl: number | null
  rank: number | null
  handle: string | null
  avatar_url: string | null
}

interface LinkedTrader {
  id: string
  user_id: string
  trader_id: string
  source: string
  market_type: string
  label: string | null
  is_primary: boolean
  display_order: number
  verified_at: string
  verification_method: string
  created_at: string
  updated_at: string
  stats: LinkedTraderStats | null
}

function getPlatformName(source: string): string {
  const map: Record<string, string> = {
    binance_futures: 'Binance Futures',
    binance_spot: 'Binance Spot',
    binance_web3: 'Binance Web3',
    bybit: 'Bybit',
    bitget_futures: 'Bitget Futures',
    bitget_spot: 'Bitget Spot',
    okx_futures: 'OKX Futures',
    okx_web3: 'OKX Web3',
    mexc: 'MEXC',
    htx_futures: 'HTX',
    coinex: 'CoinEx',
    kucoin: 'KuCoin',
    gate: 'Gate.io',
    gateio: 'Gate.io',
    bingx: 'BingX',
    phemex: 'Phemex',
    hyperliquid: 'Hyperliquid',
    gmx: 'GMX',
    dydx: 'dYdX',
    jupiter_perps: 'Jupiter Perps',
    drift: 'Drift',
    aevo: 'Aevo',
    vertex: 'Vertex',
    kwenta: 'Kwenta',
    gains: 'Gains Network',
    btcc: 'BTCC',
    bitunix: 'Bitunix',
    bitfinex: 'Bitfinex',
    blofin: 'BloFin',
    etoro: 'eToro',
  }
  return map[source] || source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function getExchangeKey(source: string): string {
  // Extract base exchange name for logo lookup
  const base = source.split('_')[0]
  return base
}

function formatVerificationMethod(method: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    api_key: t('verificationMethodApiKey'),
    signature: t('verificationMethodSignature'),
    video: t('verificationMethodVideo'),
    social: t('verificationMethodSocial'),
  }
  return map[method] || method
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatPnl(pnl: number | null): string {
  if (pnl == null) return '-'
  const abs = Math.abs(pnl)
  const prefix = pnl >= 0 ? '+$' : '-$'
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(1)}K`
  return `${prefix}${abs.toFixed(0)}`
}

function formatRoi(roi: number | null): string {
  if (roi == null) return '-'
  const prefix = roi >= 0 ? '+' : ''
  return `${prefix}${roi.toFixed(1)}%`
}

export function TraderLinksSection({ userId }: { userId: string }) {
  const [traders, setTraders] = useState<LinkedTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editLabelValue, setEditLabelValue] = useState('')
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()

  const getAuthHeaders = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return null
    return { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
  }, [])

  const loadLinkedTraders = useCallback(async () => {
    try {
      const headers = await getAuthHeaders()
      if (!headers) return

      const res = await fetch('/api/traders/linked', { headers })
      if (res.ok) {
        const data = await res.json()
        setTraders(data.data?.linked_traders || [])
      } else {
        showToast(t('loadLinkedTradersFailed') || 'Failed to load linked accounts', 'error')
      }
    } catch (error) {
      logger.error('[TraderLinks] Load error:', error)
      showToast(t('loadLinkedTradersFailed') || 'Failed to load linked accounts', 'error')
    } finally {
      setLoading(false)
    }
  }, [getAuthHeaders, showToast, t])

  useEffect(() => {
    if (userId) loadLinkedTraders()
  }, [userId, loadLinkedTraders])

  // Focus label input when editing
  useEffect(() => {
    if (editingLabelId && labelInputRef.current) {
      labelInputRef.current.focus()
    }
  }, [editingLabelId])

  const handleUpdateLabel = async (id: string) => {
    setUpdatingId(id)
    try {
      const headers = await getAuthHeaders()
      if (!headers) return

      const res = await fetch('/api/traders/linked', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id, label: editLabelValue.trim() || null }),
      })
      if (res.ok) {
        setTraders(prev => prev.map(t => t.id === id ? { ...t, label: editLabelValue.trim() || null } : t))
        showToast(t('labelSaved'), 'success')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    } finally {
      setUpdatingId(null)
      setEditingLabelId(null)
    }
  }

  const handleSetPrimary = async (id: string) => {
    setUpdatingId(id)
    try {
      const headers = await getAuthHeaders()
      if (!headers) return

      const res = await fetch('/api/traders/linked', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id, is_primary: true }),
      })
      if (res.ok) {
        setTraders(prev => prev.map(t => ({
          ...t,
          is_primary: t.id === id,
        })))
        showToast(t('primarySet'), 'success')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    } finally {
      setUpdatingId(null)
    }
  }

  const handleUnlink = async (trader: LinkedTrader) => {
    // Determine the appropriate warning
    let warningMsg = t('unlinkWarning')
    if (trader.is_primary && traders.length > 1) {
      warningMsg = t('unlinkPrimaryWarning')
    } else if (traders.length === 1) {
      warningMsg = t('unlinkLastWarning')
    }

    const confirmed = await showConfirm(t('confirmUnlink'), warningMsg)
    if (!confirmed) return

    setDeletingId(trader.id)
    try {
      const headers = await getAuthHeaders()
      if (!headers) return

      const res = await fetch('/api/traders/linked', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ id: trader.id }),
      })
      if (res.ok) {
        const data = await res.json()
        setTraders(prev => {
          const remaining = prev.filter(t => t.id !== trader.id)
          // If the primary was deleted and there are remaining, the API auto-promotes
          if (trader.is_primary && remaining.length > 0) {
            remaining[0] = { ...remaining[0], is_primary: true }
          }
          return remaining
        })
        showToast(t('traderUnlinked'), 'success')

        // If no remaining accounts, could refresh to reflect verified status change
        if (data.data?.remaining_count === 0) {
          router.refresh()
        }
      } else {
        const errData = await res.json().catch(() => ({}))
        showToast(errData.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('loadingText')}</Text>
      </Box>
    )
  }

  // Empty state
  if (traders.length === 0) {
    return (
      <Box style={{
        padding: tokens.spacing[8],
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
      }}>
        <Box style={{
          width: 56, height: 56, borderRadius: tokens.radius.full,
          background: `${tokens.colors.accent.primary}10`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        </Box>
        <Text size="sm" weight="medium">{t('noLinkedAccounts')}</Text>
        <Text size="xs" color="tertiary" style={{ maxWidth: 300, lineHeight: 1.6 }}>
          {t('linkAccountDescription')}
        </Text>
        <Button
          variant="primary"
          size="sm"
          onClick={() => router.push('/claim')}
          style={{ marginTop: tokens.spacing[2] }}
        >
          {t('linkNewAccount')}
        </Button>
      </Box>
    )
  }

  // Aggregated stats
  const totalPnl = traders.reduce((sum, t) => sum + (t.stats?.pnl ?? 0), 0)
  const bestRoi = Math.max(...traders.map(t => t.stats?.roi ?? -Infinity))
  const avgScore = traders.filter(t => t.stats?.arena_score != null).length > 0
    ? traders.reduce((sum, t) => sum + (t.stats?.arena_score ?? 0), 0) / traders.filter(t => t.stats?.arena_score != null).length
    : null

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* Aggregated stats bar */}
      {traders.length > 1 && (
        <Box style={{
          display: 'flex', gap: tokens.spacing[4], padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg, background: `${tokens.colors.accent.primary}08`,
          border: `1px solid ${tokens.colors.accent.primary}15`,
          flexWrap: 'wrap',
        }}>
          <Box style={{ flex: 1, minWidth: 80 }}>
            <Text size="xs" color="tertiary">{t('combinedPnl')}</Text>
            <Text size="sm" weight="bold" style={{ color: totalPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
              {formatPnl(totalPnl)}
            </Text>
          </Box>
          <Box style={{ flex: 1, minWidth: 80 }}>
            <Text size="xs" color="tertiary">{t('bestRoi')}</Text>
            <Text size="sm" weight="bold" style={{ color: bestRoi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
              {bestRoi > -Infinity ? formatRoi(bestRoi) : '-'}
            </Text>
          </Box>
          {avgScore != null && (
            <Box style={{ flex: 1, minWidth: 80 }}>
              <Text size="xs" color="tertiary">{t('weightedScore')}</Text>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                {avgScore.toFixed(1)}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Linked trader cards */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {traders.map((trader) => (
          <Box
            key={trader.id}
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.primary,
              border: `1px solid ${trader.is_primary ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}`,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {/* Header row: logo + name + badges */}
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
              <ExchangeLogo exchange={getExchangeKey(trader.source)} size={32} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  <Text size="sm" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {trader.label || trader.stats?.handle || trader.trader_id.slice(0, 12)}
                  </Text>
                  {trader.is_primary && (
                    <span style={{
                      padding: `1px ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.sm,
                      background: `${tokens.colors.accent.primary}20`,
                      color: tokens.colors.accent.primary,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.5px',
                      textTransform: 'uppercase',
                    }}>
                      {t('primaryAccount')}
                    </span>
                  )}
                </Box>
                <Text size="xs" color="tertiary">
                  {getPlatformName(trader.source)} &middot; {formatVerificationMethod(trader.verification_method, t)} &middot; {t('verifiedOn')} {formatDate(trader.verified_at)}
                </Text>
              </Box>
            </Box>

            {/* Label edit */}
            {editingLabelId === trader.id ? (
              <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                <input
                  ref={labelInputRef}
                  value={editLabelValue}
                  onChange={(e) => setEditLabelValue(e.target.value)}
                  placeholder={t('labelPlaceholder')}
                  maxLength={50}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUpdateLabel(trader.id)
                    if (e.key === 'Escape') setEditingLabelId(null)
                  }}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    outline: 'none',
                    minHeight: 36,
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleUpdateLabel(trader.id)}
                  disabled={updatingId === trader.id}
                  style={{ minHeight: 36 }}
                >
                  {updatingId === trader.id ? '...' : t('save')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingLabelId(null)}
                  style={{ minHeight: 36 }}
                >
                  {t('cancel')}
                </Button>
              </Box>
            ) : null}

            {/* Stats row */}
            {trader.stats && (
              <Box style={{
                display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[3],
                padding: tokens.spacing[2], borderRadius: tokens.radius.md,
                background: tokens.colors.bg.secondary,
                flexWrap: 'wrap',
              }}>
                {trader.stats.roi != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">ROI</Text>
                    <Text size="sm" weight="bold" style={{ color: trader.stats.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
                      {formatRoi(trader.stats.roi)}
                    </Text>
                  </Box>
                )}
                {trader.stats.pnl != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">PnL</Text>
                    <Text size="sm" weight="bold" style={{ color: trader.stats.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
                      {formatPnl(trader.stats.pnl)}
                    </Text>
                  </Box>
                )}
                {trader.stats.arena_score != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">Score</Text>
                    <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                      {trader.stats.arena_score.toFixed(1)}
                    </Text>
                  </Box>
                )}
                {trader.stats.rank != null && (
                  <Box style={{ minWidth: 40 }}>
                    <Text size="xs" color="tertiary">Rank</Text>
                    <Text size="sm" weight="bold">#{trader.stats.rank}</Text>
                  </Box>
                )}
              </Box>
            )}

            {/* Action buttons */}
            <Box className="trader-link-actions" style={{
              display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap',
            }}>
              {!trader.is_primary && (
                <button
                  onClick={() => handleSetPrimary(trader.id)}
                  disabled={!!updatingId}
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.xs,
                    cursor: 'pointer',
                    minHeight: 32,
                    transition: `all ${tokens.transition.base}`,
                    opacity: updatingId ? 0.5 : 1,
                  }}
                >
                  {updatingId === trader.id ? '...' : t('setAsPrimary')}
                </button>
              )}
              <button
                onClick={() => {
                  setEditingLabelId(trader.id)
                  setEditLabelValue(trader.label || '')
                }}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  minHeight: 32,
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {t('editLabel')}
              </button>
              <button
                onClick={() => handleUnlink(trader)}
                disabled={!!deletingId}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.accent.error}30`,
                  background: 'transparent',
                  color: tokens.colors.accent.error,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  minHeight: 32,
                  transition: `all ${tokens.transition.base}`,
                  opacity: deletingId ? 0.5 : 1,
                }}
              >
                {deletingId === trader.id ? '...' : t('unlinkAccount')}
              </button>
            </Box>
          </Box>
        ))}
      </Box>

      {/* Link new account button */}
      <Box
        onClick={() => {
          if (traders.length >= 10) {
            showToast(t('maxLinkedAccounts'), 'error')
            return
          }
          router.push('/claim')
        }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[2],
          padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg,
          border: `1px dashed ${tokens.colors.border.secondary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
          minHeight: 44,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <Text size="sm" color="tertiary">{t('linkNewAccount')}</Text>
      </Box>

      {/* Mobile-responsive styles */}
      <style>{`
        @media (max-width: 480px) {
          .trader-link-actions {
            flex-direction: column;
          }
          .trader-link-actions button {
            width: 100%;
            text-align: center;
            min-height: 44px !important;
          }
        }
      `}</style>
    </Box>
  )
}
