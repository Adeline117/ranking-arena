'use client'

/**
 * ProposalCard
 *
 * Displays a single Snapshot governance proposal with voting status
 * and inline vote buttons for active proposals.
 */

import { useState, memo, useCallback } from 'react'
import { useSWRConfig } from 'swr'
import type { SnapshotProposal } from '@/lib/web3/snapshot'
import { getProposalUrl, getArenaSpaceId } from '@/lib/web3/snapshot'
import { VoteButton } from './VoteButton'

interface ProposalCardProps {
  proposal: SnapshotProposal
}

const STATE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  active: { bg: 'var(--color-accent-success)', color: 'var(--color-accent-success)', label: 'Active' },
  closed: { bg: 'var(--color-brand)', color: 'var(--color-brand)', label: 'Closed' },
  pending: { bg: 'var(--color-accent-warning)', color: 'var(--color-accent-warning)', label: 'Pending' },
}

const CHOICE_COLORS = ['var(--color-accent-success)', 'var(--color-accent-error)', 'var(--color-brand)']

export const ProposalCard = memo(function ProposalCard({ proposal }: ProposalCardProps) {
  const state = STATE_STYLES[proposal.state] || STATE_STYLES.pending
  const spaceId = getArenaSpaceId()
  const totalVotes = proposal.scores_total || 0
  const isActive = proposal.state === 'active'
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null)
  const { mutate } = useSWRConfig()

  const handleVoted = useCallback((choiceIndex: number) => {
    setSelectedChoice(choiceIndex)
    // Revalidate proposals list after a short delay to let Snapshot process
    setTimeout(() => {
      mutate((key: unknown) => Array.isArray(key) && key[0] === 'snapshot-proposals')
    }, 3000)
  }, [mutate])

  const now = Math.floor(Date.now() / 1000)
  const endDate = new Date(proposal.end * 1000)
  const isExpired = now > proposal.end

  const formatTimeRemaining = () => {
    if (isExpired) return `Ended ${endDate.toLocaleDateString()}`
    const diff = proposal.end - now
    if (diff < 3600) return `Ends in ${Math.ceil(diff / 60)}m`
    if (diff < 86400) return `Ends in ${Math.floor(diff / 3600)}h`
    const days = Math.floor(diff / 86400)
    return `Ends in ${days}d ${Math.floor((diff % 86400) / 3600)}h`
  }

  return (
    <div className="p-5 rounded-2xl transition-all duration-200" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-primary)' }}>
      {/* Header: State badge + votes count + Snapshot link */}
      <div className="flex justify-between items-center mb-3">
        <span
          className="px-2.5 py-1 rounded-lg text-xs font-semibold"
          style={{ backgroundColor: `color-mix(in srgb, ${state.bg} 10%, transparent)`, color: state.color }}
        >
          {state.label}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {proposal.votes} votes
          </span>
          {spaceId && (
            <a
              href={getProposalUrl(spaceId, proposal.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] transition-colors no-underline"
              style={{ color: 'var(--color-text-tertiary)' }}
              title="View on Snapshot"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* Title */}
      <h3 className="text-base font-bold mb-2 leading-snug" style={{ color: 'var(--color-text-primary)' }}>
        {proposal.title}
      </h3>

      {/* Body preview */}
      {proposal.body && (
        <p className="text-[13px] mb-4 leading-relaxed line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>
          {proposal.body.slice(0, 200)}
        </p>
      )}

      {/* Results bars */}
      {proposal.choices && proposal.scores && (
        <div className="flex flex-col gap-1.5">
          {proposal.choices.map((choice, i) => {
            const score = proposal.scores[i] || 0
            const pct = totalVotes > 0 ? (score / totalVotes) * 100 : 0

            return (
              <div key={i}>
                <div className="flex justify-between mb-0.5">
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{choice}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{pct.toFixed(1)}%</span>
                </div>
                <div className="h-1 rounded-sm overflow-hidden" style={{ background: 'var(--color-bg-tertiary)' }}>
                  <div
                    className="h-full rounded-sm transition-[width] duration-300"
                    style={{ width: `${pct}%`, backgroundColor: CHOICE_COLORS[i] || CHOICE_COLORS[2] }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Voting section for active proposals */}
      {isActive && proposal.choices && (
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-border-primary)' }}>
          <div className="flex flex-wrap gap-2">
            {proposal.choices.map((choice, i) => (
              <div key={i} className="flex-1 min-w-[120px]">
                <VoteButton
                  proposalId={proposal.id}
                  choice={i + 1}
                  choiceLabel={choice}
                  onVoted={() => handleVoted(i + 1)}
                  disabled={selectedChoice !== null && selectedChoice !== i + 1}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: end time */}
      <div className="mt-3 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {formatTimeRemaining()}
      </div>
    </div>
  )
})
