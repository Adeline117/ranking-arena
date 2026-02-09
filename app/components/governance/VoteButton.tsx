'use client'

/**
 * VoteButton
 *
 * Allows users to cast a gasless vote on a Snapshot proposal.
 * Snapshot voting uses EIP-712 signatures — no gas fees.
 *
 * The signature is submitted directly to Snapshot Hub.
 */

import { useState, useCallback } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { getArenaSpaceId } from '@/lib/web3/snapshot'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface VoteButtonProps {
  proposalId: string
  /** Choice index (1-based, matching Snapshot convention) */
  choice: number
  choiceLabel: string
  /** Whether the user has already voted */
  hasVoted?: boolean
  disabled?: boolean
  onVoted?: () => void
}

const SNAPSHOT_SEQ = 'https://seq.snapshot.org'

// EIP-712 types for Snapshot vote
const SNAPSHOT_VOTE_TYPES = {
  Vote: [
    { name: 'from', type: 'address' },
    { name: 'space', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'proposal', type: 'bytes32' },
    { name: 'choice', type: 'uint32' },
    { name: 'reason', type: 'string' },
    { name: 'app', type: 'string' },
    { name: 'metadata', type: 'string' },
  ],
} as const

const SNAPSHOT_DOMAIN = {
  name: 'snapshot',
  version: '0.1.4',
  chainId: 1,
} as const

export function VoteButton({
  proposalId,
  choice,
  choiceLabel,
  hasVoted = false,
  disabled = false,
  onVoted,
}: VoteButtonProps) {
  const { address, isConnected } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const { t } = useLanguage()
  const [isVoting, setIsVoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voted, setVoted] = useState(hasVoted)

  const spaceId = getArenaSpaceId()

  const handleVote = useCallback(async () => {
    if (!address || !spaceId) return

    // Validate proposalId is a valid bytes32 hex string
    if (!/^0x[0-9a-fA-F]{64}$/.test(proposalId)) {
      setError(t('voteInvalidProposal'))
      return
    }

    setIsVoting(true)
    setError(null)

    try {
      const timestamp = Math.floor(Date.now() / 1000)

      const message = {
        from: address,
        space: spaceId,
        timestamp: BigInt(timestamp),
        proposal: proposalId as `0x${string}`,
        choice,
        reason: '',
        app: 'arena',
        metadata: '{}',
      }

      // Sign EIP-712 typed data
      const signature = await signTypedDataAsync({
        domain: SNAPSHOT_DOMAIN,
        types: SNAPSHOT_VOTE_TYPES,
        primaryType: 'Vote',
        message,
      })

      // Submit to Snapshot sequencer
      const res = await fetch(SNAPSHOT_SEQ, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          sig: signature,
          data: {
            domain: SNAPSHOT_DOMAIN,
            types: SNAPSHOT_VOTE_TYPES,
            message: {
              ...message,
              timestamp: Number(message.timestamp),
            },
          },
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message || body.error || t('voteSubmissionFailed'))
      }

      setVoted(true)
      onVoted?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('voteFailed')
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setError(t('voteSignatureRejected'))
      } else {
        setError(msg)
      }
    } finally {
      setIsVoting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, spaceId, proposalId, choice, signTypedDataAsync, onVoted])

  if (!isConnected) {
    return (
      <button
        disabled
        className="w-full px-3 py-2 rounded-lg text-sm font-medium cursor-not-allowed"
        style={{ border: '1px solid var(--color-border-primary)', background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }}
      >
        {t('voteConnectWallet')}
      </button>
    )
  }

  if (voted) {
    return (
      <button
        disabled
        className="w-full px-3 py-2 rounded-lg border border-green-500/20 bg-green-500/5 text-green-400 text-sm font-semibold cursor-default flex items-center justify-center gap-1.5"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {t('voteVoted')}: {choiceLabel}
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={handleVote}
        disabled={disabled || isVoting}
        className={`w-full px-3 py-2 rounded-lg border text-sm font-semibold transition-all duration-200 ${
          isVoting
            ? 'border-purple-500/20 bg-purple-500/5 text-purple-300 cursor-wait'
            : 'border-purple-500/30 bg-purple-500/10 text-purple-300 cursor-pointer hover:bg-purple-500/15 hover:border-purple-500/40'
        }`}
      >
        {isVoting ? t('voteSigning') : `${t('voteLabel')}: ${choiceLabel}`}
      </button>
      {error && (
        <p className="mt-1 text-[11px] text-red-400">{error}</p>
      )}
    </div>
  )
}
