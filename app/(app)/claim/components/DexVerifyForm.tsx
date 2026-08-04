'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { authedFetch } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { SearchResult, isSolanaDex, walletMatchesTrader } from './types'
import { trackEvent } from '@/lib/analytics/track'
import { buildTraderClaimLoginHref } from '@/lib/auth/trader-claim-login'
import { buildTraderClaimWalletMessage } from '@/lib/auth/trader-claim-wallet-message'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'
import { readTraderClaimSubmitAcknowledgement } from '@/lib/auth/trader-claim-submit-contract'

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider }
    solana?: SolanaProvider
  }
}

interface SolanaProvider {
  isPhantom?: boolean
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>
  connect: () => Promise<{ publicKey: { toString: () => string } }>
}

type DexVerifyFormProps = {
  trader: SearchResult
  onSuccess: () => void
}

type ClaimOperation = {
  controller: AbortController
  viewer: SettingsViewerSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim()
  if (
    isRecord(value.error) &&
    typeof value.error.message === 'string' &&
    value.error.message.trim()
  ) {
    return value.error.message.trim()
  }
  return fallback
}

function canonicalTraderId(trader: SearchResult): string {
  try {
    return canonicalizeWalletIdentity(trader.source_trader_id, trader.source)
  } catch {
    return trader.source_trader_id
  }
}

export function DexVerifyForm(props: DexVerifyFormProps) {
  const auth = useAuthSession()
  const viewer = captureSettingsViewer(auth)
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${props.trader.source}\u0000${props.trader.source_trader_id}`

  return <ViewerScopedDexVerifyForm key={scopeKey} {...props} viewer={viewer} />
}

function ViewerScopedDexVerifyForm({
  trader,
  onSuccess,
  viewer,
}: DexVerifyFormProps & {
  viewer: SettingsViewerSnapshot | null
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const mountedRef = useRef(false)
  const operationRef = useRef<ClaimOperation | null>(null)
  const [loading, setLoading] = useState(false)

  const isSolana = isSolanaDex(trader.source)
  const claimTraderId = canonicalTraderId(trader)
  const operationIsCurrent = (operation: ClaimOperation): boolean =>
    mountedRef.current &&
    operationRef.current === operation &&
    isSettingsViewerCurrent(operation.viewer, authRef.current)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  const redirectToLogin = () => {
    showToast(t('loginExpiredPleaseRelogin'), 'error')
    router.push(
      buildTraderClaimLoginHref({
        traderId: trader.source_trader_id,
        source: trader.source,
        handle: trader.handle,
      })
    )
  }

  const handleWalletVerify = async () => {
    // State updates render asynchronously; close the same-frame double-click
    // window before a second wallet prompt or proof operation can start.
    if (loading || operationRef.current) return
    const operationViewer = viewerRef.current
    if (!operationViewer || !isSettingsViewerCurrent(operationViewer, authRef.current)) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        redirectToLogin()
      }
      return
    }

    const operation: ClaimOperation = {
      controller: new AbortController(),
      viewer: operationViewer,
    }
    operationRef.current = operation
    setLoading(true)
    try {
      let walletAddress: string
      let signature: string
      const timestamp = Date.now()
      const message = buildTraderClaimWalletMessage({
        userId: operation.viewer.userId,
        source: trader.source,
        traderKey: claimTraderId,
        timestamp,
      })

      if (isSolana) {
        // Solana wallet signing (Phantom, Solflare, etc.)
        const solanaProvider = window.phantom?.solana ?? window.solana
        if (!solanaProvider?.signMessage) {
          showToast(t('claimSolanaWalletRequired'), 'warning')
          return
        }

        const connectTimeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Wallet connection timed out. Please try again.')),
            30000
          )
        )
        const resp = await Promise.race([solanaProvider.connect(), connectTimeout])
        if (!operationIsCurrent(operation)) return
        walletAddress = resp.publicKey.toString()

        if (!walletMatchesTrader(walletAddress, trader.source_trader_id, trader.source)) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        const encodedMessage = new TextEncoder().encode(message)
        const signedMessage = await solanaProvider.signMessage(encodedMessage, 'utf8')
        if (!operationIsCurrent(operation)) return
        // Convert Uint8Array signature to base64 for transmission
        // Use btoa instead of Buffer.from to avoid Node.js-only API in browser
        signature = btoa(String.fromCharCode(...signedMessage.signature))
      } else {
        // EVM wallet signing
        if (!window.ethereum) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        const ethTimeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Wallet connection timed out. Please try again.')),
            30000
          )
        )
        const accounts = (await Promise.race([
          window.ethereum.request({ method: 'eth_requestAccounts' }),
          ethTimeout,
        ])) as string[]
        if (!operationIsCurrent(operation)) return
        walletAddress = accounts[0]

        if (!walletAddress) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        if (!walletMatchesTrader(walletAddress, trader.source_trader_id, trader.source)) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        signature = (await window.ethereum.request({
          method: 'personal_sign',
          params: [message, walletAddress],
        })) as string
        if (!operationIsCurrent(operation)) return
      }

      // The claim endpoint verifies and consumes the signed proof exactly once
      // before atomically creating the review submission. A separate preflight
      // verification would consume the replay nonce and make this request fail.
      const claimResult = await authedFetch<unknown>(
        '/api/traders/claim',
        'POST',
        operation.viewer.accessToken,
        {
          trader_id: claimTraderId,
          source: trader.source,
          verification_method: 'signature',
          verification_data: {
            wallet_address: walletAddress,
            signature,
            message,
          },
        },
        30_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (claimResult.stale || !operationIsCurrent(operation)) return
      if (claimResult.status === 401) {
        redirectToLogin()
        return
      }
      if (
        !claimResult.ok ||
        claimResult.status !== 200 ||
        !readTraderClaimSubmitAcknowledgement(claimResult.data, {
          source: trader.source,
          traderId: claimTraderId,
          viewerId: operation.viewer.userId,
          method: 'signature',
        })
      ) {
        showToast(responseMessage(claimResult.data, t('claimFailed')), 'error')
        return
      }

      trackEvent('claim_trader', { method: 'dex_wallet' })
      showToast(t('claimSubmitted'), 'success')
      onSuccess()
    } catch (error) {
      if (!operationIsCurrent(operation)) return
      const msg = error instanceof Error ? error.message : ''
      if (
        msg.includes('User rejected') ||
        msg.includes('user rejected') ||
        msg.includes('timed out')
      ) {
        // User cancelled wallet interaction or timeout
        setLoading(false)
        if (msg.includes('timed out')) {
          showToast(t('claimWalletTimeout'), 'warning')
        }
        return
      }
      showToast(t('claimWalletSignFailed'), 'error')
    } finally {
      if (operationRef.current === operation) operationRef.current = null
      if (mountedRef.current && isSettingsViewerCurrent(operation.viewer, authRef.current)) {
        setLoading(false)
      }
    }
  }

  const authPending = !viewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto', textAlign: 'center' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimWalletVerifyTitle')}</h3>
      <p
        style={{
          color: tokens.colors.text.secondary,
          marginBottom: tokens.spacing[4],
          fontSize: tokens.typography.fontSize.sm,
        }}
      >
        {t('claimWalletVerifyDesc')}
      </p>

      <Box
        style={{
          padding: tokens.spacing[4],
          backgroundColor: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text
          style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}
        >
          {t('claimWalletToVerifyLabel')}
        </Text>
        <Text
          style={{
            fontFamily: 'monospace',
            fontSize: tokens.typography.fontSize.sm,
            wordBreak: 'break-all',
            color: tokens.colors.text.primary,
            marginTop: tokens.spacing[1],
          }}
        >
          {trader.source_trader_id}
        </Text>
      </Box>

      <button
        onClick={handleWalletVerify}
        disabled={loading || authPending}
        style={{
          width: '100%',
          padding: tokens.spacing[3],
          fontSize: tokens.typography.fontSize.md,
          fontWeight: tokens.typography.fontWeight.semibold,
          borderRadius: tokens.radius.md,
          border: 'none',
          backgroundColor:
            loading || authPending ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
          color: tokens.colors.white,
          cursor: loading || authPending ? 'not-allowed' : 'pointer',
          opacity: loading || authPending ? 0.6 : 1,
        }}
      >
        {loading ? t('claimWalletSigning') : t('claimWalletSignMessage')}
      </button>
    </Box>
  )
}
