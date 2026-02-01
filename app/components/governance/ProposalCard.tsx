'use client'

/**
 * ProposalCard
 *
 * Displays a single Snapshot governance proposal with voting status
 * and inline vote buttons for active proposals.
 */

import { useState } from 'react'
import type { SnapshotProposal } from '@/lib/web3/snapshot'
import { getProposalUrl, getArenaSpaceId } from '@/lib/web3/snapshot'
import { VoteButton } from './VoteButton'

interface ProposalCardProps {
  proposal: SnapshotProposal
}

const STATE_STYLES: Record<string, { badge: string; label: string }> = {
  active: { badge: 'bg-green-500/10 text-green-400', label: 'Active' },
  closed: { badge: 'bg-purple-500/10 text-purple-400', label: 'Closed' },
  pending: { badge: 'bg-yellow-500/10 text-yellow-400', label: 'Pending' },
}

const CHOICE_COLORS = ['bg-green-400', 'bg-red-400', 'bg-purple-400']

export function ProposalCard({ proposal }: ProposalCardProps) {
  const state = STATE_STYLES[proposal.state] || STATE_STYLES.pending
  const spaceId = getArenaSpaceId()
  const totalVotes = proposal.scores_total || 0
  const isActive = proposal.state === 'active'
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null)

  const now = Math.floor(Date.now() / 1000)
  const endDate = new Date(proposal.end * 1000)
  const isExpired = now > proposal.end

  return (
    <div className="p-5 bg-white/[0.03] border border-white/[0.06] rounded-2xl transition-all duration-200 hover:border-purple-400/30">
      {/* Header: State badge + votes count + Snapshot link */}
      <div className="flex justify-between items-center mb-3">
        <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${state.badge}`}>
          {state.label}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">
            {proposal.votes} votes
          </span>
          {spaceId && (
            <a
              href={getProposalUrl(spaceId, proposal.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-neutral-600 hover:text-purple-400 transition-colors no-underline"
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
      <h3 className="text-base font-bold text-neutral-200 mb-2 leading-snug">
        {proposal.title}
      </h3>

      {/* Body preview */}
      {proposal.body && (
        <p className="text-[13px] text-neutral-500 mb-4 leading-relaxed line-clamp-2">
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
                  <span className="text-xs text-neutral-400">{choice}</span>
                  <span className="text-xs text-neutral-500">{pct.toFixed(1)}%</span>
                </div>
                <div className="h-1 rounded-sm bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-sm transition-[width] duration-300 ${CHOICE_COLORS[i] || CHOICE_COLORS[2]}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Voting section for active proposals */}
      {isActive && proposal.choices && (
        <div className="mt-4 pt-4 border-t border-white/[0.06]">
          <div className="flex flex-wrap gap-2">
            {proposal.choices.map((choice, i) => (
              <div key={i} className="flex-1 min-w-[120px]">
                <VoteButton
                  proposalId={proposal.id}
                  choice={i + 1}
                  choiceLabel={choice}
                  onVoted={() => setSelectedChoice(i + 1)}
                  disabled={selectedChoice !== null && selectedChoice !== i + 1}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: end time */}
      <div className="mt-3 text-[11px] text-neutral-600">
        {isExpired
          ? `Ended ${endDate.toLocaleDateString()}`
          : `Ends ${endDate.toLocaleDateString()} ${endDate.toLocaleTimeString()}`
        }
      </div>
    </div>
  )
}
