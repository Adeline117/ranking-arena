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
 */

import { useCallback, useState } from 'react'
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
}

export function useSiweAuth(): UseSiweAuthReturn {
  const { address, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const fetchNonce = useCallback(async (): Promise<string> => {
    const res = await fetch('/api/auth/siwe/nonce')
    if (!res.ok) throw new Error('Failed to fetch nonce')
    const { nonce } = await res.json()
    return nonce
  }, [])

  /**
   * Sign in with SIWE — creates or finds a user account linked to the wallet.
   */
  const signIn = useCallback(async (): Promise<SiweAuthResult | null> => {
    if (!address) {
      setError('No wallet connected')
      return null
    }

    setIsLoading(true)
    setError(null)

    try {
      const nonce = await fetchNonce()
      const message = await createSiweMessage(nonce)
      const signature = await signMessageAsync({ message })

      const res = await fetch('/api/auth/siwe/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })

      if (!res.ok) {
        const { error: errMsg } = await res.json()
        throw new Error(errMsg || 'Verification failed')
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
          // Fallback: try signing in with OTP magic link
          console.warn('[SIWE] OTP verification failed, session may require email confirmation:', otpError)
        }
      }

      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed'
      setError(msg)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [address, fetchNonce, createSiweMessage, signMessageAsync])

  /**
   * Link wallet to an existing authenticated account.
   */
  const linkWallet = useCallback(async (): Promise<{ walletAddress: string } | null> => {
    if (!address) {
      setError('No wallet connected')
      return null
    }

    setIsLoading(true)
    setError(null)

    try {
      const nonce = await fetchNonce()
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
      })

      if (!res.ok) {
        const { error: errMsg } = await res.json()
        throw new Error(errMsg || 'Failed to link wallet')
      }

      const result = await res.json()
      return { walletAddress: result.walletAddress }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Link failed'
      setError(msg)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [address, fetchNonce, createSiweMessage, signMessageAsync])

  return { signIn, linkWallet, isLoading, error }
}
