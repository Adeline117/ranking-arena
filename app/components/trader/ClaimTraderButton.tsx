'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '../base'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { walletIdentitiesMatch } from '@/lib/validators/wallet-identity'
import {
  buildTraderClaimLoginHref,
  buildTraderClaimReturnPath,
} from '@/lib/auth/trader-claim-login'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

interface ClaimTraderButtonProps {
  traderId: string
  handle: string
  userId: string
  source?: string // 'binance', 'bybit', etc.
}

/**
 * DEX platforms whose traders are identified by wallet address.
 * These use wallet signature verification instead of API key.
 */
const DEX_WALLET_PLATFORMS = [
  'hyperliquid',
  'gmx',
  'gains',
  'aevo',
  'kwenta',
  'vertex',
  'dydx',
  'jupiter_perps',
  'drift',
]

function isDexPlatform(source: string): boolean {
  return DEX_WALLET_PLATFORMS.some((p) => source.toLowerCase().startsWith(p))
}

type ClaimOperation = {
  controller: AbortController
  id: number
  viewer: SettingsViewerSnapshot
}

type ClaimStatusOutcome = 'loading' | 'ready' | 'failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readClaimStatus(
  value: unknown,
  expected: {
    source: string
    traderId: string
    userId: string
  }
): {
  claimStatus: string | null
  hasVerifiedAccounts: boolean
  thisTraderLinked: boolean
} | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null
  const data = value.data
  if (!Array.isArray(data.linked_traders) || typeof data.is_verified !== 'boolean') return null
  const normalizedSource = expected.source.toLowerCase()
  const matchesCurrentTrader = (candidate: Record<string, unknown>): boolean =>
    candidate.source === normalizedSource &&
    typeof candidate.trader_id === 'string' &&
    (isDexWalletPlatform(normalizedSource)
      ? walletIdentitiesMatch(candidate.trader_id, expected.traderId, normalizedSource)
      : candidate.trader_id === expected.traderId)

  const linked: Record<string, unknown>[] = []
  for (const candidate of data.linked_traders) {
    if (
      !isRecord(candidate) ||
      candidate.user_id !== expected.userId ||
      typeof candidate.trader_id !== 'string' ||
      typeof candidate.source !== 'string'
    ) {
      return null
    }
    linked.push(candidate)
  }

  const claim = data.claim
  if (
    claim !== null &&
    (!isRecord(claim) ||
      claim.user_id !== expected.userId ||
      typeof claim.trader_id !== 'string' ||
      typeof claim.source !== 'string' ||
      typeof claim.status !== 'string')
  ) {
    return null
  }

  const thisTraderLinked = linked.some(matchesCurrentTrader)
  return {
    claimStatus: thisTraderLinked
      ? 'verified'
      : isRecord(claim) && matchesCurrentTrader(claim)
        ? (claim.status as string)
        : null,
    hasVerifiedAccounts: linked.length > 0 || data.is_verified,
    thisTraderLinked,
  }
}

export default function ClaimTraderButton(props: ClaimTraderButtonProps) {
  const auth = useAuthSession()
  const viewer = captureSettingsViewer(auth)
  const exactViewer = viewer?.userId === props.userId ? viewer : null
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${props.userId}\u0000${props.source ?? 'binance'}\u0000${props.traderId}`

  return <ViewerScopedClaimTraderButton key={scopeKey} {...props} viewer={exactViewer} />
}

function ViewerScopedClaimTraderButton({
  traderId,
  handle,
  userId,
  source = 'binance',
  viewer,
}: ClaimTraderButtonProps & {
  viewer: SettingsViewerSnapshot | null
}) {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const statusOperationRef = useRef<ClaimOperation | null>(null)
  const confirmOperationRef = useRef<ClaimOperation | null>(null)
  const [claimStatus, setClaimStatus] = useState<string | null>(null)
  const [hasVerifiedAccounts, setHasVerifiedAccounts] = useState(false)
  const [thisTraderLinked, setThisTraderLinked] = useState(false)
  const [startingClaim, setStartingClaim] = useState(false)
  const [statusOutcome, setStatusOutcome] = useState<ClaimStatusOutcome>(
    viewer ? 'loading' : 'ready'
  )
  const claimIdentity = { traderId, source, handle }
  const claimReturnPath = buildTraderClaimReturnPath(claimIdentity)

  const operationIsCurrent = (
    operation: ClaimOperation,
    operationRef: { current: ClaimOperation | null }
  ): boolean =>
    mountedRef.current &&
    operationRef.current?.id === operation.id &&
    isSettingsViewerCurrent(operation.viewer, authRef.current)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      statusOperationRef.current?.controller.abort()
      statusOperationRef.current = null
      confirmOperationRef.current?.controller.abort()
      confirmOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    async function checkClaimStatus(): Promise<void> {
      if (!viewer || !isSettingsViewerCurrent(viewer, authRef.current)) return
      statusOperationRef.current?.controller.abort()
      const operation: ClaimOperation = {
        controller: new AbortController(),
        id: ++nextOperationIdRef.current,
        viewer,
      }
      statusOperationRef.current = operation
      setStatusOutcome('loading')
      try {
        const normalizedSource = source.toLowerCase()
        const query = new URLSearchParams({
          trader_id: traderId,
          source: normalizedSource,
        })
        const result = await authedFetch<unknown>(
          `/api/traders/claim?${query.toString()}`,
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
        if (!operationIsCurrent(operation, statusOperationRef) || result.stale) return
        if (!result.ok) throw new Error(`Claim status request failed (${result.status})`)
        const next = readClaimStatus(result.data, {
          source,
          traderId,
          userId: operation.viewer.userId,
        })
        if (!next) throw new Error('Invalid claim status response')
        setHasVerifiedAccounts(next.hasVerifiedAccounts)
        setThisTraderLinked(next.thisTraderLinked)
        setClaimStatus(next.claimStatus)
        setStatusOutcome('ready')
      } catch (err: unknown) {
        if (operationIsCurrent(operation, statusOperationRef)) {
          setStatusOutcome('failed')
          logger.error('[ClaimTrader] Status check failed:', {
            message: err instanceof Error ? err.message : String(err),
            userId: operation.viewer.userId,
            source,
          })
        }
      } finally {
        if (statusOperationRef.current?.id === operation.id) {
          operation.controller.abort()
          statusOperationRef.current = null
        }
      }
    }

    void checkClaimStatus()
    // Re-check when user returns to this tab (instead of polling every 30s)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && mountedRef.current) {
        void checkClaimStatus()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      statusOperationRef.current?.controller.abort()
      statusOperationRef.current = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [source, traderId, userId, viewer])

  const handleClaim = async () => {
    if (confirmOperationRef.current) return
    const operationViewer = captureSettingsViewer(authRef.current)
    if (!operationViewer || operationViewer.userId !== userId) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        showToast(t('pleaseLoginFirst'), 'warning')
        router.push(buildTraderClaimLoginHref(claimIdentity))
      }
      return
    }
    const operation: ClaimOperation = {
      controller: new AbortController(),
      id: ++nextOperationIdRef.current,
      viewer: operationViewer,
    }
    confirmOperationRef.current = operation
    setStartingClaim(true)

    const cancelClaimStart = () => {
      if (confirmOperationRef.current?.id !== operation.id) return
      operation.controller.abort()
      confirmOperationRef.current = null
      if (isSettingsViewerCurrent(operation.viewer, authRef.current)) setStartingClaim(false)
    }

    // For DEX platforms, redirect to the claim page with wallet flow
    if (isDexPlatform(source)) {
      if (operationIsCurrent(operation, confirmOperationRef)) router.push(claimReturnPath)
      return
    }

    const confirmTitle = hasVerifiedAccounts ? t('confirmLink') : t('confirmClaim')
    const confirmDesc = hasVerifiedAccounts
      ? t('confirmLinkDesc').replace('{handle}', handle)
      : `${t('confirmClaimDesc').replace('{handle}', handle)}\n${t('verifyOwnership')}`

    let confirmed = false
    try {
      confirmed = await showConfirm(confirmTitle, confirmDesc)
    } catch {
      if (operationIsCurrent(operation, confirmOperationRef)) {
        showToast(t('operationFailed'), 'error')
      }
      cancelClaimStart()
      return
    }
    if (!operationIsCurrent(operation, confirmOperationRef)) return
    if (!confirmed) {
      cancelClaimStart()
      return
    }

    // For CEX platforms, redirect to claim page with API key flow
    router.push(claimReturnPath)
  }

  const authPending = !viewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))

  if (viewer && statusOutcome !== 'ready') {
    return (
      <Button variant="ghost" size="sm" disabled>
        {t(statusOutcome === 'loading' ? 'loading' : 'operationFailed')}
      </Button>
    )
  }

  if (thisTraderLinked || claimStatus === 'verified') {
    return (
      <Button variant="ghost" size="sm" disabled>
        {t('claimSubmitted')}
      </Button>
    )
  }

  if (claimStatus === 'pending' || claimStatus === 'reviewing') {
    return (
      <Button variant="ghost" size="sm" disabled>
        {t('claimSubmitted')}
      </Button>
    )
  }

  // If user already has verified accounts, show "Link to Profile" instead of "Claim"
  const buttonLabel = hasVerifiedAccounts ? t('linkToProfile') : t('claimTrader')

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClaim}
      disabled={authPending || startingClaim}
    >
      {buttonLabel}
    </Button>
  )
}
