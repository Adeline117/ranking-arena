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
import { SiweMessage } from 'siwe'
import { supabase } from '@/lib/supabase/client'

interface SiweAuthResult {
  action: 'existing_user' | 'new_user'
  userId: string
  handle?: string
  walletAddress: string
  verificationToken?: string
  email: string
}

interface UseSiweAuthReturn {
  signIn: () => Promise<SiweAuthResult | null>
  linkWallet: () => Promise<{ walletAddress: string } | null>
  isLoading: boolean
  error: string | null
  clearError: () => void
}

/**
 * Normalise wallet errors into user-friendly messages.
 */
function normaliseWalletError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  // User rejected the signature request
  if (
    msg.includes('User rejected') ||
    msg.includes('user rejected') ||
    msg.includes('ACTION_REJECTED') ||
    msg.includes('UserRejectedRequestError')
  ) {
    return 'Signature request was rejected. Please approve the signature in your wallet to sign in.'
  }

  // Nonce expired
  if (msg.includes('Nonce expired') || msg.includes('nonce')) {
    return 'Session expired. Please try again.'
  }

  // Network / RPC errors
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
    return 'Network error. Please check your connection and try again.'
  }

  // Wallet not connected
  if (msg.includes('No wallet connected') || msg.includes('Connector not connected')) {
    return 'No wallet connected. Please connect your wallet first.'
  }

  // Already linked
  if (msg.includes('already linked')) {
    return 'This wallet is already linked to another account.'
  }

  return msg || 'Sign in failed'
}

export function useSiweAuth(): UseSiweAuthReturn {
  const { address, chainId, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track previous address to detect wallet switches
  const prevAddressRef = useRef<string | undefined>(address)
  // Guard against concurrent sign-in attempts
  const inFlightRef = useRef(false)
  // Abort controller for fetch requests on unmount
  const abortRef = useRef<AbortController | null>(null)

  // ── Handle wallet disconnect & account switch ──
  useEffect(() => {
    const prevAddress = prevAddressRef.current
    prevAddressRef.current = address

    // Wallet disconnected while we had an address → sign out if the session was wallet-based
    if (prevAddress && !address && !isConnected) {
      ;(async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.user?.email?.endsWith('@wallet.arena')) {
            await supabase.auth.signOut()
          }
        } catch {
          // non-critical
        }
      })()
      return
    }

    // Account switched to a different address → warn & clear stale error
    if (prevAddress && address && prevAddress !== address) {
      setError(null)
    }
  }, [address, isConnected])

  // Clean up abort controller on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const createSiweMessage = useCallback(async (nonce: string): Promise<string> => {
    const message = new SiweMessage({
      domain: window.location.host,
      address: address!,
      statement: 'Sign in to Arena with your wallet.',
      uri: window.location.origin,
      version: '1',
      chainId: chainId || 8453, // Base mainnet
      nonce,
    })
    return message.prepareMessage()
  }, [address, chainId])

  const fetchNonce = useCallback(async (signal?: AbortSignal): Promise<string> => {
    const res = await fetch('/api/auth/siwe/nonce', { signal })
    if (!res.ok) throw new Error('Failed to fetch nonce')
    const { nonce } = await res.json()
    return nonce
  }, [])

  /**
   * Sign in with SIWE — creates or finds a user account linked to the wallet.
   */
  const signIn = useCallback(async (): Promise<SiweAuthResult | null> => {
    if (!address) {
      setError('No wallet connected. Please connect your wallet first.')
      return null
    }
    if (inFlightRef.current) return null

    inFlightRef.current = true
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsLoading(true)
    setError(null)

    try {
      const nonce = await fetchNonce(controller.signal)
      const message = await createSiweMessage(nonce)
      const signature = await signMessageAsync({ message })

      const res = await fetch('/api/auth/siwe/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Verification failed')
      }

      const result: SiweAuthResult = await res.json()

      // Complete Supabase auth using the verification token
      if (result.verificationToken && result.email) {
        const { error: otpError } = await supabase.auth.verifyOtp({
          email: result.email,
          token: result.verificationToken,
          type: 'email',
        })

        if (otpError) {
          console.warn('[SIWE] OTP verification failed, session may require email confirmation:', otpError)
        }
      }

      return result
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      setError(normaliseWalletError(err))
      return null
    } finally {
      inFlightRef.current = false
      setIsLoading(false)
    }
  }, [address, fetchNonce, createSiweMessage, signMessageAsync])

  /**
   * Link wallet to an existing authenticated account.
   */
  const linkWallet = useCallback(async (): Promise<{ walletAddress: string } | null> => {
    if (!address) {
      setError('No wallet connected. Please connect your wallet first.')
      return null
    }
    if (inFlightRef.current) return null

    inFlightRef.current = true
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsLoading(true)
    setError(null)

    try {
      const nonce = await fetchNonce(controller.signal)
      const message = await createSiweMessage(nonce)
      const signature = await signMessageAsync({ message })

      // Get current access token
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        throw new Error('Not authenticated')
      }

      const res = await fetch('/api/auth/siwe/link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ message, signature }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to link wallet')
      }

      const result = await res.json()
      return { walletAddress: result.walletAddress }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      setError(normaliseWalletError(err))
      return null
    } finally {
      inFlightRef.current = false
      setIsLoading(false)
    }
  }, [address, fetchNonce, createSiweMessage, signMessageAsync])

  return { signIn, linkWallet, isLoading, error, clearError }
}
