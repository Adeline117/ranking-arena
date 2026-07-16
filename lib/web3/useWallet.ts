'use client'

/**
 * useWallet Hook
 *
 * Client-side hook for wallet state management. Wallet data and mutations are
 * bound to one canonical viewer epoch so work started by account A can never
 * read or commit state for account B.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerKey } from '@/lib/auth/viewer-scope'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'

export type WalletViewerOperation = {
  viewerKey: `user:${string}`
  sessionGeneration: number
  userId: string
  /** The exact token captured before any user interaction or network work. */
  accessToken: string
}

interface WalletDataState {
  ownerScopeKey: string | null
  linkedAddress: string | null
  hasNFT: boolean
  loading: boolean
}

interface WalletState {
  /** Wallet address linked to the user's account (from DB) */
  linkedAddress: string | null
  /** Whether the user has a valid Pro NFT */
  hasNFT: boolean
  /** Whether we're loading wallet state */
  isLoading: boolean
  /** Whether the currently connected wallet matches the linked one */
  isLinkedWalletConnected: boolean
  /** Stable identity for scoping component-local pending state. */
  viewerScopeKey: string | null
  /** Capture the viewer and exact token before a confirmation dialog opens. */
  captureWalletOperation: () => WalletViewerOperation | null
  /** Check both canonical hook state and the process-wide viewer CAS. */
  isWalletOperationCurrent: (operation: WalletViewerOperation) => boolean
  /** Unlink only the viewer captured before confirmation. */
  unlinkWallet: (operation: WalletViewerOperation) => Promise<boolean>
  /** Refresh wallet state for a captured viewer, or the current viewer. */
  refresh: (operation?: WalletViewerOperation) => Promise<void>
}

type CanonicalWalletAuth = Pick<
  AuthSessionReturn,
  | 'accessToken'
  | 'authChecked'
  | 'isLoggedIn'
  | 'loading'
  | 'sessionGeneration'
  | 'userId'
  | 'viewerKey'
>

function scopeKey(operation: Pick<WalletViewerOperation, 'viewerKey' | 'sessionGeneration'>) {
  return `${operation.viewerKey}\u0000${operation.sessionGeneration}`
}

function captureCanonicalWalletViewer(auth: CanonicalWalletAuth): WalletViewerOperation | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.isLoggedIn ||
    !auth.userId ||
    !auth.accessToken ||
    jwtSubject(auth.accessToken) !== auth.userId ||
    auth.viewerKey !== (`user:${auth.userId}` as ViewerKey)
  ) {
    return null
  }

  const operation: WalletViewerOperation = {
    viewerKey: auth.viewerKey as `user:${string}`,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    accessToken: auth.accessToken,
  }

  return isViewerScopeCurrent(operation) ? operation : null
}

function isCanonicalWalletViewerCurrent(
  operation: WalletViewerOperation,
  auth: CanonicalWalletAuth
): boolean {
  return (
    isViewerScopeCurrent(operation) &&
    auth.authChecked &&
    !auth.loading &&
    auth.isLoggedIn &&
    auth.viewerKey === operation.viewerKey &&
    auth.sessionGeneration === operation.sessionGeneration &&
    auth.userId === operation.userId
  )
}

export function useWallet(): WalletState {
  const { address: connectedAddress } = useAccount()
  const auth = useAuthSession()
  const authRef = useRef<CanonicalWalletAuth>(auth)
  // Keep synchronous callbacks on the latest rendered canonical viewer. The
  // process-wide CAS below also invalidates them before React finishes a render.
  authRef.current = auth

  const mountedRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const [walletData, setWalletData] = useState<WalletDataState>({
    ownerScopeKey: null,
    linkedAddress: null,
    hasNFT: false,
    loading: true,
  })

  const captureWalletOperation = useCallback((): WalletViewerOperation | null => {
    return captureCanonicalWalletViewer(authRef.current)
  }, [])

  const isWalletOperationCurrent = useCallback((operation: WalletViewerOperation): boolean => {
    return mountedRef.current && isCanonicalWalletViewerCurrent(operation, authRef.current)
  }, [])

  const isRequestCurrent = useCallback(
    (operation: WalletViewerOperation, requestGeneration: number): boolean => {
      return (
        mountedRef.current &&
        requestGenerationRef.current === requestGeneration &&
        isCanonicalWalletViewerCurrent(operation, authRef.current)
      )
    },
    []
  )

  const loadWalletState = useCallback(
    async (capturedOperation?: WalletViewerOperation): Promise<void> => {
      const operation = capturedOperation ?? captureWalletOperation()
      if (!operation || !isWalletOperationCurrent(operation)) return

      const requestGeneration = ++requestGenerationRef.current
      const ownerScopeKey = scopeKey(operation)
      setWalletData({
        ownerScopeKey,
        linkedAddress: null,
        hasNFT: false,
        loading: true,
      })

      try {
        const response = await fetch('/api/membership/nft', {
          headers: { Authorization: `Bearer ${operation.accessToken}` },
        })
        if (!isRequestCurrent(operation, requestGeneration)) return
        if (!response.ok) throw new Error('Wallet state could not be loaded')

        const payload = (await response.json()) as {
          hasNft?: unknown
          walletAddress?: unknown
        }
        if (!isRequestCurrent(operation, requestGeneration)) return

        setWalletData({
          ownerScopeKey,
          linkedAddress:
            typeof payload.walletAddress === 'string' && payload.walletAddress
              ? payload.walletAddress
              : null,
          hasNFT: payload.hasNft === true,
          loading: false,
        })
      } catch {
        if (!isRequestCurrent(operation, requestGeneration)) return
        // Fail closed: a partial/error response must not preserve wallet data
        // from an earlier request for this viewer.
        setWalletData({
          ownerScopeKey,
          linkedAddress: null,
          hasNFT: false,
          loading: false,
        })
      }
    },
    [captureWalletOperation, isRequestCurrent, isWalletOperationCurrent]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

  const currentOperation = captureCanonicalWalletViewer(auth)
  const viewerScopeKey = currentOperation ? scopeKey(currentOperation) : null

  useEffect(() => {
    if (!viewerScopeKey) {
      // Invalidate network work immediately when auth becomes pending/anonymous.
      requestGenerationRef.current += 1
      return
    }

    void loadWalletState()
    return () => {
      requestGenerationRef.current += 1
    }
  }, [loadWalletState, viewerScopeKey])

  const unlinkWallet = useCallback(
    async (operation: WalletViewerOperation): Promise<boolean> => {
      // The caller captures this operation before opening confirmation. Never
      // re-read a mutable current session after the user confirms.
      if (!isWalletOperationCurrent(operation)) return false

      // Any load started before this mutation is no longer authoritative.
      requestGenerationRef.current += 1
      try {
        const response = await fetch('/api/auth/siwe/unlink', {
          method: 'POST',
          headers: { Authorization: `Bearer ${operation.accessToken}` },
        })
        if (!isWalletOperationCurrent(operation) || !mountedRef.current) return false
        if (!response.ok) return false

        // Invalidate loads that raced with the mutation before committing the
        // server-confirmed state.
        requestGenerationRef.current += 1
        setWalletData({
          ownerScopeKey: scopeKey(operation),
          linkedAddress: null,
          hasNFT: false,
          loading: false,
        })
        return true
      } catch {
        return false
      }
    },
    [isWalletOperationCurrent]
  )

  // Viewer ownership is part of the rendered value, so A's state disappears in
  // the same render that canonical auth moves to pending/B (before effects run).
  const visibleWalletData =
    viewerScopeKey && walletData.ownerScopeKey === viewerScopeKey ? walletData : null
  const linkedAddress = visibleWalletData?.linkedAddress ?? null
  const hasNFT = visibleWalletData?.hasNFT ?? false
  const isLoading =
    auth.loading ||
    !auth.authChecked ||
    (viewerScopeKey !== null && (!visibleWalletData || visibleWalletData.loading))

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
    viewerScopeKey,
    captureWalletOperation,
    isWalletOperationCurrent,
    unlinkWallet,
    refresh: loadWalletState,
  }
}
