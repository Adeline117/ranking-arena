'use client'

/**
 * One-Click SIWE Authentication Hook
 *
 * Combines wallet connection and SIWE sign-in into a single action:
 * 1. If wallet not connected → opens wallet modal
 * 2. Once connected → automatically prompts for signature
 * 3. Verifies signature and completes Supabase session
 *
 * Features:
 * - Single button click for entire flow
 * - Auto-sign after connection (configurable)
 * - Remembers pending sign-in intent across wallet connection
 * - Clear status feedback for each step
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'

// Lazy-load siwe (pulls in ethers ~668KB) — only needed when user triggers
// Web3 sign-in, not on initial page load.
async function getSiweMessage() {
  const { SiweMessage } = await import('siwe')
  return SiweMessage
}
import { useLanguage, type TranslationFunction } from '@/app/components/Providers/LanguageProvider'
import {
  establishRequiredSiweSession,
  parseSiweAuthResult,
  rollbackSiweSessionIfCurrent,
  SiweSessionCancelledError,
  type SiweAuthResult,
} from '@/lib/web3/siwe-session'

// ============================================
// Types
// ============================================

export type OneClickStatus =
  | 'idle' // Initial state
  | 'connecting' // Opening wallet modal / waiting for connection
  | 'signing' // Waiting for user to sign message
  | 'verifying' // Server verification in progress
  | 'success' // Sign-in complete
  | 'error' // An error occurred

interface UseOneClickSiweOptions {
  /** Auto-sign after wallet connection (default: true) */
  autoSign?: boolean
  /** Callback on successful sign-in */
  onSuccess?: (result: SiweAuthResult) => void
  /** Callback on error */
  onError?: (error: string) => void
}

interface UseOneClickSiweReturn {
  /** Initiate the one-click sign-in flow */
  signIn: () => Promise<SiweAuthResult | null>
  /** Current status of the sign-in flow */
  status: OneClickStatus
  /** Whether any operation is in progress */
  isLoading: boolean
  /** Error message if status is 'error' */
  error: string | null
  /** Clear error and reset to idle */
  reset: () => void
  /** Connected wallet address (if any) */
  address: string | undefined
  /** Whether wallet is connected */
  isConnected: boolean
}

interface ActiveSiweAttempt {
  generation: number
  controller: AbortController
  walletAddress: string
}

function sameWalletAddress(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

function isAttemptCancellation(error: unknown): boolean {
  return (
    error instanceof SiweSessionCancelledError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

// ============================================
// Error Normalization
// ============================================

function normalizeWalletError(err: unknown, t: TranslationFunction): string {
  const msg = err instanceof Error ? err.message : String(err)

  // User rejected the signature request
  if (
    msg.includes('User rejected') ||
    msg.includes('user rejected') ||
    msg.includes('ACTION_REJECTED') ||
    msg.includes('UserRejectedRequestError')
  ) {
    return t('siweRejected')
  }

  // User closed modal without connecting
  if (msg.includes('modal closed') || msg.includes('Connection request reset')) {
    return t('siweModalClosed')
  }

  // Nonce expired
  if (msg.includes('Nonce expired') || msg.includes('nonce')) {
    return t('siweExpired')
  }

  // Network / RPC errors
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
    return t('siweNetworkError')
  }

  // Wallet not connected
  if (msg.includes('No wallet connected') || msg.includes('Connector not connected')) {
    return t('siweNoWallet')
  }

  // SIWE message validation errors (invalid message format)
  if (
    msg.includes('invalid message') ||
    msg.includes('Invalid message') ||
    msg.includes('max line number')
  ) {
    return t('siweSignInFailed')
  }

  // Generic fallback — never show raw error to user
  return t('siweSignInFailed')
}

// ============================================
// Main Hook
// ============================================

export function useOneClickSiwe(options: UseOneClickSiweOptions = {}): UseOneClickSiweReturn {
  const { autoSign = true, onSuccess, onError } = options

  const { address, isConnected, isConnecting } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  const { t } = useLanguage()

  const [status, setStatus] = useState<OneClickStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Track if we're waiting for connection to complete sign-in
  const pendingSignInRef = useRef(false)
  // Prevent concurrent sign-in attempts
  const inFlightRef = useRef(false)
  // Abort controller for fetch requests
  const abortRef = useRef<AbortController | null>(null)
  // Every new/cancelled attempt invalidates all older async continuations.
  const attemptGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const currentAddressRef = useRef(address)
  const previousAddressRef = useRef(address)
  currentAddressRef.current = address

  const isAttemptCurrent = useCallback((attempt: ActiveSiweAttempt): boolean => {
    return (
      mountedRef.current &&
      attemptGenerationRef.current === attempt.generation &&
      !attempt.controller.signal.aborted &&
      sameWalletAddress(currentAddressRef.current, attempt.walletAddress)
    )
  }, [])

  const assertAttemptCurrent = useCallback(
    (attempt: ActiveSiweAttempt): void => {
      if (!isAttemptCurrent(attempt)) throw new SiweSessionCancelledError()
    },
    [isAttemptCurrent]
  )

  // A wallet switch/disconnect owns a new generation immediately. The address
  // ref is updated during render, closing the render-to-effect race as well.
  useEffect(() => {
    const previousAddress = previousAddressRef.current
    previousAddressRef.current = address
    if (!previousAddress || sameWalletAddress(previousAddress, address)) return

    attemptGenerationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    inFlightRef.current = false
    pendingSignInRef.current = false
    if (mountedRef.current) {
      setStatus('idle')
      setError(null)
    }
  }, [address])

  // ── Update status based on connection state ──
  useEffect(() => {
    if (mountedRef.current && isConnecting && pendingSignInRef.current) {
      setStatus('connecting')
    }
  }, [isConnecting])

  // ── Cleanup on unmount ──
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptGenerationRef.current += 1
      pendingSignInRef.current = false
      inFlightRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    attemptGenerationRef.current += 1
    pendingSignInRef.current = false
    inFlightRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    if (mountedRef.current) {
      setStatus('idle')
      setError(null)
    }
  }, [])

  const fetchNonce = useCallback(
    async (signal: AbortSignal, assertCurrent: () => void): Promise<string> => {
      const res = await fetch('/api/auth/siwe/nonce', { signal })
      assertCurrent()
      if (!res.ok) throw new Error(t('siweFetchNonceFailed'))
      const body = (await res.json()) as { nonce?: unknown }
      assertCurrent()
      const nonce = typeof body.nonce === 'string' ? body.nonce : null
      if (!nonce) throw new Error(t('siweFetchNonceFailed'))
      return nonce
    },
    [t]
  )

  const createSiweMessage = useCallback(
    async (nonce: string, walletAddress: string, chainId: number): Promise<string> => {
      const SiweMessage = await getSiweMessage()
      const message = new SiweMessage({
        domain: window.location.host,
        address: walletAddress,
        statement: t('siweStatement'),
        uri: window.location.origin,
        version: '1',
        chainId: chainId || 8453, // Base mainnet
        nonce,
      })
      return message.prepareMessage()
    },
    [t]
  )

  const performSignIn = useCallback(async (): Promise<SiweAuthResult | null> => {
    const walletAddress = address
    if (!walletAddress) {
      if (!mountedRef.current || currentAddressRef.current) return null
      const errMsg = t('siweNoWallet')
      setError(errMsg)
      setStatus('error')
      onError?.(errMsg)
      return null
    }
    if (!mountedRef.current || !sameWalletAddress(currentAddressRef.current, walletAddress)) {
      return null
    }

    if (inFlightRef.current) return null
    inFlightRef.current = true

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const attempt: ActiveSiweAttempt = {
      generation: attemptGenerationRef.current + 1,
      controller,
      walletAddress,
    }
    attemptGenerationRef.current = attempt.generation

    assertAttemptCurrent(attempt)
    setStatus('signing')
    assertAttemptCurrent(attempt)
    setError(null)

    let completedResult: SiweAuthResult | null = null
    let completedAccessToken: string | undefined
    let completionReturned = false

    try {
      // Fetch nonce
      const nonce = await fetchNonce(controller.signal, () => assertAttemptCurrent(attempt))
      assertAttemptCurrent(attempt)

      // Create and sign message
      const message = await createSiweMessage(nonce, walletAddress, 8453)
      assertAttemptCurrent(attempt)
      const signature = await signMessageAsync({ message })
      assertAttemptCurrent(attempt)

      assertAttemptCurrent(attempt)
      setStatus('verifying')

      // Verify on server
      const res = await fetch('/api/auth/siwe/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
        signal: controller.signal,
      })
      assertAttemptCurrent(attempt)

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        assertAttemptCurrent(attempt)
        throw new Error(body.error || t('siweVerificationFailed'))
      }

      const responseBody = await res.json()
      assertAttemptCurrent(attempt)
      const result = parseSiweAuthResult(responseBody)
      completedResult = result
      assertAttemptCurrent(attempt)
      const completedSession = await establishRequiredSiweSession(result, {
        expectedWalletAddress: walletAddress,
        signal: controller.signal,
        isCurrent: () => isAttemptCurrent(attempt),
      })
      completedAccessToken = completedSession.snapshot.session.access_token
      completionReturned = true
      assertAttemptCurrent(attempt)

      assertAttemptCurrent(attempt)
      setStatus('success')
      assertAttemptCurrent(attempt)
      onSuccess?.(result)
      return result
    } catch (err) {
      const cancelled = isAttemptCancellation(err) || !isAttemptCurrent(attempt)
      if (completionReturned && completedResult) {
        try {
          await rollbackSiweSessionIfCurrent(completedResult.userId, completedAccessToken)
        } catch {
          // The coordinator owns fail-closed sign-out diagnostics.
        }
      }
      if (cancelled || !isAttemptCurrent(attempt)) return null

      const errMsg = normalizeWalletError(err, t)
      assertAttemptCurrent(attempt)
      setError(errMsg)
      assertAttemptCurrent(attempt)
      setStatus('error')
      assertAttemptCurrent(attempt)
      onError?.(errMsg)
      return null
    } finally {
      if (attemptGenerationRef.current === attempt.generation) {
        inFlightRef.current = false
        if (abortRef.current === controller) abortRef.current = null
      }
    }
  }, [
    address,
    fetchNonce,
    createSiweMessage,
    signMessageAsync,
    t,
    onSuccess,
    onError,
    assertAttemptCurrent,
    isAttemptCurrent,
  ])

  // ── Auto-sign after wallet connection ──
  useEffect(() => {
    if (pendingSignInRef.current && isConnected && address && !inFlightRef.current) {
      pendingSignInRef.current = false
      if (autoSign) {
        const timer = setTimeout(() => {
          performSignIn()
        }, 100)
        return () => clearTimeout(timer)
      }
    }
  }, [isConnected, address, autoSign, performSignIn])

  const signIn = useCallback(async (): Promise<SiweAuthResult | null> => {
    // Reset any previous error state
    setError(null)

    // If already connected, go straight to signing
    if (isConnected && address) {
      return performSignIn()
    }

    // Not connected - open modal and wait for connection
    if (!openConnectModal) {
      const errMsg = t('siweNoWallet')
      setError(errMsg)
      setStatus('error')
      onError?.(errMsg)
      return null
    }

    // Mark that we want to sign in after connection
    pendingSignInRef.current = true
    setStatus('connecting')

    // Open the wallet connection modal
    openConnectModal()

    // The actual sign-in will be triggered by the useEffect when connection completes
    return null
  }, [isConnected, address, openConnectModal, performSignIn, t, onError])

  return {
    signIn,
    status,
    isLoading: status === 'connecting' || status === 'signing' || status === 'verifying',
    error,
    reset,
    address,
    isConnected,
  }
}

export default useOneClickSiwe
