'use client'

/**
 * /claim - Landing page for traders to claim their profiles.
 * Includes:
 * - Marketing content explaining benefits
 * - Search box to find trader profile
 * - Verification flow (API key for CEX, wallet for DEX)
 * - FAQ section
 * - Stats (claimed/total traders)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box, Text } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'

import { SearchResult, LinkedTrader, isDex } from './components/types'
import { HeroSection } from './components/HeroSection'
import { BenefitsSection } from './components/BenefitsSection'
import { SearchSection } from './components/SearchSection'
import { FaqSection } from './components/FaqSection'
import { CexVerifyForm } from './components/CexVerifyForm'
import { DexVerifyForm } from './components/DexVerifyForm'
import { LinkedAccountsSidebar } from './components/LinkedAccountsSidebar'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { buildTraderClaimLoginHref } from '@/lib/auth/trader-claim-login'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

type LinkedTraderOperation = {
  controller: AbortController
  id: number
  viewer: SettingsViewerSnapshot
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isLinkedTraderStats(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const stats = value as Record<string, unknown>
  return (
    isNullableFiniteNumber(stats.arena_score) &&
    isNullableFiniteNumber(stats.roi) &&
    isNullableFiniteNumber(stats.pnl) &&
    isNullableFiniteNumber(stats.rank) &&
    isNullableString(stats.handle) &&
    isNullableString(stats.avatar_url)
  )
}

function isLinkedTraderForViewer(value: unknown, userId: string): value is LinkedTrader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const trader = value as Record<string, unknown>
  return (
    typeof trader.id === 'string' &&
    !!trader.id &&
    trader.user_id === userId &&
    typeof trader.trader_id === 'string' &&
    !!trader.trader_id &&
    typeof trader.source === 'string' &&
    !!trader.source &&
    (trader.label === null || typeof trader.label === 'string') &&
    typeof trader.is_primary === 'boolean' &&
    typeof trader.display_order === 'number' &&
    Number.isFinite(trader.display_order) &&
    typeof trader.verified_at === 'string' &&
    typeof trader.verification_method === 'string' &&
    typeof trader.created_at === 'string' &&
    typeof trader.updated_at === 'string' &&
    (trader.stats === null || isLinkedTraderStats(trader.stats))
  )
}

function readLinkedTraders(value: unknown, userId: string): LinkedTrader[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const response = value as Record<string, unknown>
  if (response.success !== true || !response.data || typeof response.data !== 'object') return null
  const rows = (response.data as Record<string, unknown>).linked_traders
  if (!Array.isArray(rows) || !rows.every((row) => isLinkedTraderForViewer(row, userId))) {
    return null
  }
  return rows
}

// ============================================
// Main Page Component
// ============================================

export default function ClaimPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = captureSettingsViewer(auth)
  const linkedScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const authPending = !currentViewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))
  const [selectedTrader, setSelectedTrader] = useState<SearchResult | null>(null)
  const selectedTraderRef = useRef(selectedTrader)
  selectedTraderRef.current = selectedTrader
  const [step, setStep] = useState<'search' | 'verify' | 'done'>('search')
  const stepRef = useRef(step)
  stepRef.current = step
  const [pendingTrader, setPendingTrader] = useState<SearchResult | null>(null)
  const [linkedTraders, setLinkedTraders] = useViewerOwnedState<LinkedTrader[]>(
    [],
    () => [],
    linkedScopeKey
  )
  const mountedRef = useRef(false)
  const nextLinkedOperationIdRef = useRef(0)
  const linkedOperationRef = useRef<LinkedTraderOperation | null>(null)
  const redirectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch linked traders for the user
  const fetchLinkedTraders = useCallback(
    async (expectedViewer?: SettingsViewerSnapshot) => {
      const viewer = expectedViewer ?? captureSettingsViewer(authRef.current)
      if (!viewer || !isSettingsViewerCurrent(viewer, authRef.current)) return
      linkedOperationRef.current?.controller.abort()
      const operation: LinkedTraderOperation = {
        controller: new AbortController(),
        id: ++nextLinkedOperationIdRef.current,
        viewer,
      }
      linkedOperationRef.current = operation
      const operationIsCurrent = () =>
        mountedRef.current &&
        linkedOperationRef.current?.id === operation.id &&
        isSettingsViewerCurrent(operation.viewer, authRef.current)

      try {
        const result = await authedFetch<unknown>(
          '/api/traders/linked',
          'GET',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (!operationIsCurrent() || result.stale || !result.ok) return
        const rows = readLinkedTraders(result.data, operation.viewer.userId)
        if (rows) setLinkedTraders(rows)
      } catch {
        // Silent fail
      } finally {
        if (operationIsCurrent()) linkedOperationRef.current = null
      }
    },
    [setLinkedTraders]
  )

  const redirectSelectionToLogin = useCallback(
    (result: SearchResult) => {
      showToast(t('pleaseLoginFirst'), 'warning')
      router.push(
        buildTraderClaimLoginHref({
          traderId: result.source_trader_id,
          source: result.source,
          handle: result.handle,
        })
      )
    },
    [router, showToast, t]
  )

  const enterVerification = useCallback((result: SearchResult) => {
    setSelectedTrader(result)
    setStep('verify')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      linkedOperationRef.current?.controller.abort()
      linkedOperationRef.current = null
      if (redirectTimeoutRef.current) clearTimeout(redirectTimeoutRef.current)
    }
  }, [])

  // Check URL params for direct link
  useEffect(() => {
    const traderId = searchParams?.get('trader')
    const source = searchParams?.get('source')
    const handle = searchParams?.get('handle')
    const stepParam = searchParams?.get('step')

    if (traderId && source) {
      setSelectedTrader({
        handle: handle || traderId,
        source,
        source_trader_id: traderId,
      })
      if (stepParam === 'verify') {
        setStep('verify')
      }
    }
  }, [searchParams])

  // A principal transition synchronously renders linked-trader state empty.
  // This effect owns cancellation/reload and prevents an old success redirect
  // from carrying into the replacement account.
  useEffect(() => {
    linkedOperationRef.current?.controller.abort()
    linkedOperationRef.current = null
    setLinkedTraders([])
    if (redirectTimeoutRef.current) {
      clearTimeout(redirectTimeoutRef.current)
      redirectTimeoutRef.current = null
    }
    if (stepRef.current === 'done') {
      setStep(selectedTraderRef.current ? 'verify' : 'search')
    }
    const viewer = captureSettingsViewer(authRef.current)
    if (viewer) void fetchLinkedTraders(viewer)
    return () => {
      linkedOperationRef.current?.controller.abort()
    }
  }, [fetchLinkedTraders, linkedScopeKey, setLinkedTraders])

  useEffect(() => {
    if (!pendingTrader || authPending) return
    if (currentViewer) {
      const result = pendingTrader
      setPendingTrader(null)
      enterVerification(result)
      return
    }
    setPendingTrader(null)
    redirectSelectionToLogin(pendingTrader)
  }, [authPending, currentViewer, enterVerification, pendingTrader, redirectSelectionToLogin])

  const handleTraderSelect = (result: SearchResult) => {
    const viewer = captureSettingsViewer(authRef.current)
    if (viewer) {
      enterVerification(result)
      return
    }
    if (
      !authRef.current.authChecked ||
      authRef.current.loading ||
      Boolean(authRef.current.userId)
    ) {
      setPendingTrader(result)
      return
    }
    redirectSelectionToLogin(result)
  }

  const handleClaimSuccess = () => {
    const viewer = captureSettingsViewer(authRef.current)
    const trader = selectedTraderRef.current
    if (!viewer || !trader) return
    setStep('done')
    void fetchLinkedTraders(viewer)
    if (redirectTimeoutRef.current) clearTimeout(redirectTimeoutRef.current)
    redirectTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && isSettingsViewerCurrent(viewer, authRef.current)) {
        router.push(
          `/trader/${encodeURIComponent(trader.source_trader_id)}?platform=${encodeURIComponent(trader.source)}`
        )
      }
      redirectTimeoutRef.current = null
    }, 2000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Box
        style={{
          flex: 1,
          padding: `0 ${tokens.spacing[4]}`,
          maxWidth: '900px',
          margin: '0 auto',
          width: '100%',
        }}
      >
        {/* Hero */}
        <HeroSection />

        {/* Step: Search / Verify / Done */}
        {step === 'search' && (
          <>
            {linkedTraders.length > 0 && (
              <>
                <LinkedAccountsSidebar linkedTraders={linkedTraders} />
                <Box
                  style={{
                    textAlign: 'center',
                    marginBottom: tokens.spacing[5],
                  }}
                >
                  <Text
                    style={{
                      fontSize: tokens.typography.fontSize.lg,
                      fontWeight: tokens.typography.fontWeight.bold,
                      color: tokens.colors.text.primary,
                    }}
                  >
                    {t('linkAdditionalAccount')}
                  </Text>
                  <Text
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      color: tokens.colors.text.secondary,
                      marginTop: tokens.spacing[1],
                    }}
                  >
                    {t('linkAdditionalAccountDesc')}
                  </Text>
                </Box>
              </>
            )}
            <SearchSection onSelect={handleTraderSelect} />
            {linkedTraders.length === 0 && (
              <>
                <BenefitsSection />
              </>
            )}
            <FaqSection />
          </>
        )}

        {step === 'verify' && selectedTrader && (
          <Box style={{ marginBottom: tokens.spacing[8] }}>
            {/* Trader info header */}
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[4],
                backgroundColor: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                marginBottom: tokens.spacing[5],
                maxWidth: '500px',
                margin: `0 auto ${tokens.spacing[5]}`,
              }}
            >
              {selectedTrader.avatar_url && (
                <img
                  src={avatarSrc(selectedTrader.avatar_url)}
                  alt={selectedTrader.handle || 'Trader'}
                  style={{ width: 40, height: 40, borderRadius: '50%' }}
                />
              )}
              <Box>
                <Text style={{ fontWeight: tokens.typography.fontWeight.bold }}>
                  {selectedTrader.handle}
                </Text>
                <Text
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  {selectedTrader.source}
                </Text>
              </Box>
              <button
                onClick={() => {
                  setStep('search')
                  setSelectedTrader(null)
                }}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  border: 'none',
                  color: tokens.colors.text.tertiary,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {t('change')}
              </button>
            </Box>

            {/* Verification form */}
            {authPending ? (
              <Box style={{ textAlign: 'center' }}>
                <Text>{t('loading')}</Text>
              </Box>
            ) : !currentViewer ? (
              <Box style={{ textAlign: 'center' }}>
                <Text style={{ marginBottom: tokens.spacing[3] }}>{t('pleaseLoginFirst')}</Text>
                <button
                  onClick={() =>
                    router.push(
                      buildTraderClaimLoginHref({
                        traderId: selectedTrader.source_trader_id,
                        source: selectedTrader.source,
                        handle: selectedTrader.handle,
                      })
                    )
                  }
                  style={{
                    color: tokens.colors.accent.primary,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontSize: 'inherit',
                    fontFamily: 'inherit',
                  }}
                >
                  {t('loginToClaim')}
                </button>
              </Box>
            ) : isDex(selectedTrader.source) ? (
              <DexVerifyForm trader={selectedTrader} onSuccess={handleClaimSuccess} />
            ) : (
              <CexVerifyForm trader={selectedTrader} onSuccess={handleClaimSuccess} />
            )}
          </Box>
        )}

        {step === 'done' && (
          <Box
            style={{
              textAlign: 'center',
              padding: tokens.spacing[8],
            }}
          >
            <Box
              style={{
                width: 80,
                height: 80,
                borderRadius: '50%',
                backgroundColor: alpha(tokens.colors.accent.success, 13),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: `0 auto ${tokens.spacing[4]}`,
                fontSize: '2rem',
              }}
            >
              &#10003;
            </Box>
            <h2
              style={{
                fontSize: tokens.typography.fontSize['2xl'],
                fontWeight: tokens.typography.fontWeight.bold,
                marginBottom: tokens.spacing[3],
                color: tokens.colors.accent.success,
              }}
            >
              {t('claimSubmitted')}
            </h2>
            <Text style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4] }}>
              {t('redirectingToProfile')}
            </Text>
            {linkedTraders.length > 0 && <LinkedAccountsSidebar linkedTraders={linkedTraders} />}
          </Box>
        )}
      </Box>

      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}

// window.ethereum type is already declared globally by @privy-io/react-auth
