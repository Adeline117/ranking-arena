'use client'

/**
 * useWallet Hook
 *
 * Client-side hook for wallet state management.
 * Provides the linked wallet address, NFT membership status,
 * and wallet disconnect functionality.
 *
 * Unlike useSiweAuth (which handles sign-in flows), this hook
 * is for reading wallet state and managing the linked wallet
 * after the user is already authenticated.
 */

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { supabase } from '@/lib/supabase/client'

interface WalletState {
  /** Wallet address linked to the user's account (from DB) */
  linkedAddress: string | null
  /** Whether the user has a valid Pro NFT */
  hasNFT: boolean
  /** Whether we're loading wallet state */
  isLoading: boolean
  /** Whether the currently connected wallet matches the linked one */
  isLinkedWalletConnected: boolean
  /** Unlink the wallet from the user's account */
  unlinkWallet: () => Promise<boolean>
  /** Refresh wallet state from the server */
  refresh: () => Promise<void>
}

export function useWallet(): WalletState {
  const { address: connectedAddress } = useAccount()
  const [linkedAddress, setLinkedAddress] = useState<string | null>(null)
  const [hasNFT, setHasNFT] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const loadWalletState = useCallback(async () => {
    try {
      setIsLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user?.id) {
        setLinkedAddress(null)
        setHasNFT(false)
        return
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('wallet_address')
        .eq('id', session.user.id)
        .maybeSingle()

      setLinkedAddress(profile?.wallet_address || null)

      // Check NFT status if wallet is linked
      if (profile?.wallet_address) {
        try {
          const res = await fetch('/api/membership/nft', {
            headers: { 'Authorization': `Bearer ${session.access_token}` },
          })
          if (res.ok) {
            const { hasNFT: nft } = await res.json()
            setHasNFT(nft)
          }
        } catch (_err) {
          // Intentionally swallowed: NFT ownership check is optional enrichment
        }
      }
    } catch (_err) {
      // Intentionally swallowed: wallet connection check failed, loading state will clear via finally
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWalletState()
  }, [loadWalletState])

  const unlinkWallet = useCallback(async (): Promise<boolean> => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return false

      const res = await fetch('/api/auth/siwe/unlink', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      })

      if (!res.ok) return false

      setLinkedAddress(null)
      setHasNFT(false)
      return true
    } catch (_err) {
      // Intentionally swallowed: wallet unlink API call failed, return false to indicate failure
      return false
    }
  }, [])

  const isLinkedWalletConnected = Boolean(
    connectedAddress &&
    linkedAddress &&
    connectedAddress.toLowerCase() === linkedAddress.toLowerCase()
  )

  return {
    linkedAddress,
    hasNFT,
    isLoading,
    isLinkedWalletConnected,
    unlinkWallet,
    refresh: loadWalletState,
  }
}
