'use client'

/**
 * SIWE Authentication Hook
 *
 * Handles Sign-In with Ethereum flow:
 * 1. Fetch nonce from server
 * 2. Create SIWE message
 * 3. Sign with wallet
 * 4. Verify on server
 * 5. Complete Supabase session
 *
 * Also handles wallet lifecycle events:
 * - Disconnect → sign out from Supabase
 * - Account switch → clear stale session
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

// Lazy-load siwe (pulls in ethers ~668KB) — only needed when user triggers
// Web3 sign-in, not on initial page load.
async function getSiweMessage() {
  const { SiweMessage } = await import('siwe')
  return SiweMessage
}
import { useLanguage, type TranslationFunction } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  assertExpectedSiweWalletAddress,
  establishRequiredSiweSession,
  parseSiweAuthResult,
  rollbackSiweSessionIfCurrent,
  SiweSessionCancelledError,
  type SiweAuthResult,
} from '@/lib/web3/siwe-session'

interface UseSiweAuthReturn {
  signIn: () => Promise<SiweAuthResult | null>
  linkWallet: () => Promise<{ walletAddress: string } | null>
  isLoading: boolean
  error: string | null
  clearError: () => void
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

/**
 * Normalise wallet errors into user-friendly messages.
 */
function normaliseWalletError(err: unknown, t: TranslationFunction): string {
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

  // Already linked
  if (msg.includes('already linked')) {
    return t('siweAlreadyLinked')
  }

  return msg || t('siweSignInFailed')
}

export function useSiweAuth(): UseSiweAuthReturn {
  const { address, chainId, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { t } = useLanguage()
  const { email: authEmail, getToken, signOut } = useAuthSession()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track previous address to detect wallet switches
  const prevAddressRef = useRef<string | undefined>(address)
  // Guard against concurrent sign-in attempts
  const inFlightRef = useRef(false)
  // Abort controller for fetch requests on unmount
  const abortRef = useRef<AbortController | null>(null)
  const attemptGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const currentAddressRef = useRef(address)
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

  // ── Handle wallet disconnect & account switch ──
  useEffect(() => {
    const prevAddress = prevAddressRef.current
    prevAddressRef.current = address
    const addressChanged = Boolean(prevAddress && !sameWalletAddress(prevAddress, address))

    if (addressChanged) {
      attemptGenerationRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      inFlightRef.current = false
      if (mountedRef.current) {
        setIsLoading(false)
        setError(null)
      }
    }

    // Wallet disconnected while we had an address → sign out if the session was wallet-based
    if (prevAddress && !address && !isConnected) {
      if (authEmail?.endsWith('@wallet.arena')) void signOut()
      return
    }

    // Account switched to a different address → clear stale error
    if (prevAddress && address && addressChanged) {
      setError(null)
    }
  }, [address, authEmail, isConnected, signOut])

  // Clean up abort controller on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptGenerationRef.current += 1
      inFlightRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const createSiweMessage = useCallback(
    async (nonce: string, walletAddress: string, messageChainId: number): Promise<string> => {
      const SiweMessage = await getSiweMessage()
      const message = new SiweMessage({
        domain: window.location.host,
        address: walletAddress,
        statement: t('siweStatement'),
        uri: window.location.origin,
        version: '1',
        chainId: messageChainId,
        nonce,
      })
      return message.prepareMessage()
    },
    [t]
  )

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

  /**
   * Sign in with SIWE — creates or finds a user account linked to the wallet.
   */
  const signIn = useCallback(async (): Promise<SiweAuthResult | null> => {
    const walletAddress = address
    if (!walletAddress) {
      if (!mountedRef.current || currentAddressRef.current) return null
      setError(t('siweNoWallet'))
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
    setIsLoading(true)
    assertAttemptCurrent(attempt)
    setError(null)

    let completedResult: SiweAuthResult | null = null
    let completedAccessToken: string | undefined
    let completionReturned = false

    try {
      const nonce = await fetchNonce(controller.signal, () => assertAttemptCurrent(attempt))
      assertAttemptCurrent(attempt)
      const message = await createSiweMessage(nonce, walletAddress, chainId || 8453)
      assertAttemptCurrent(attempt)
      const signature = await signMessageAsync({ message })
      assertAttemptCurrent(attempt)

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

      assertAttemptCurrent(attempt)
      setError(normaliseWalletError(err, t))
      return null
    } finally {
      if (attemptGenerationRef.current === attempt.generation) {
        inFlightRef.current = false
        if (abortRef.current === controller) abortRef.current = null
        if (isAttemptCurrent(attempt)) setIsLoading(false)
      }
    }
  }, [
    address,
    chainId,
    fetchNonce,
    createSiweMessage,
    signMessageAsync,
    t,
    assertAttemptCurrent,
    isAttemptCurrent,
  ])

  /**
   * Link wallet to an existing authenticated account.
   */
  const linkWallet = useCallback(async (): Promise<{ walletAddress: string } | null> => {
    const walletAddress = address
    if (!walletAddress) {
      if (!mountedRef.current || currentAddressRef.current) return null
      setError(t('siweNoWallet'))
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
    setIsLoading(true)
    assertAttemptCurrent(attempt)
    setError(null)

    try {
      const nonce = await fetchNonce(controller.signal, () => assertAttemptCurrent(attempt))
      assertAttemptCurrent(attempt)
      const message = await createSiweMessage(nonce, walletAddress, chainId || 8453)
      assertAttemptCurrent(attempt)
      const signature = await signMessageAsync({ message })
      assertAttemptCurrent(attempt)

      // Get current access token
      const accessToken = await getToken()
      assertAttemptCurrent(attempt)
      if (!accessToken) {
        throw new Error(t('siweNotAuthenticated'))
      }

      const res = await fetch('/api/auth/siwe/link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message, signature }),
        signal: controller.signal,
        credentials: 'same-origin',
      })
      assertAttemptCurrent(attempt)

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        assertAttemptCurrent(attempt)
        // Provide more specific error messages
        if (res.status === 409) {
          throw new Error(body.error || t('siweAlreadyLinked'))
        }
        if (res.status === 400 && body.error?.includes('Nonce')) {
          throw new Error(t('siweExpired'))
        }
        throw new Error(body.error || t('siweLinkFailed'))
      }

      const result = (await res.json()) as { walletAddress?: unknown }
      assertAttemptCurrent(attempt)
      const returnedWalletAddress =
        typeof result.walletAddress === 'string' ? result.walletAddress : ''
      assertExpectedSiweWalletAddress(returnedWalletAddress, walletAddress)
      assertAttemptCurrent(attempt)
      return { walletAddress: returnedWalletAddress }
    } catch (err) {
      if (isAttemptCancellation(err) || !isAttemptCurrent(attempt)) return null

      assertAttemptCurrent(attempt)
      setError(normaliseWalletError(err, t))
      return null
    } finally {
      if (attemptGenerationRef.current === attempt.generation) {
        inFlightRef.current = false
        if (abortRef.current === controller) abortRef.current = null
        if (isAttemptCurrent(attempt)) setIsLoading(false)
      }
    }
  }, [
    address,
    chainId,
    fetchNonce,
    createSiweMessage,
    getToken,
    signMessageAsync,
    t,
    assertAttemptCurrent,
    isAttemptCurrent,
  ])

  return { signIn, linkWallet, isLoading, error, clearError }
}
