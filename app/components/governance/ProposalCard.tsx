'use client'

/**
 * ProposalCard
 *
 * Displays a single Snapshot governance proposal with voting status.
 */

import type { SnapshotProposal } from '@/lib/web3/snapshot'
import { getProposalUrl, getArenaSpaceId } from '@/lib/web3/snapshot'

interface ProposalCardProps {
  proposal: SnapshotProposal
}

const STATE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  active: { bg: 'rgba(47, 229, 125, 0.1)', text: '#2fe57d', label: 'Active' },
  closed: { bg: 'rgba(139, 111, 168, 0.1)', text: '#8b6fa8', label: 'Closed' },
  pending: { bg: 'rgba(255, 193, 7, 0.1)', text: '#ffc107', label: 'Pending' },
}

export function ProposalCard({ proposal }: ProposalCardProps) {
  const state = STATE_COLORS[proposal.state] || STATE_COLORS.pending
  const spaceId = getArenaSpaceId()
  const totalVotes = proposal.scores_total || 0

  // Calculate time remaining for active proposals
  const now = Math.floor(Date.now() / 1000)
  const endDate = new Date(proposal.end * 1000)
  const isExpired = now > proposal.end

  return (
    <a
      href={spaceId ? getProposalUrl(spaceId, proposal.id) : '#'}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block',
        padding: '20px',
        background: 'rgba(15, 15, 20, 0.6)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: 16,
        textDecoration: 'none',
        transition: 'all 0.2s ease',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.3)'
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)'
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      {/* Header: State badge + votes count */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{
          padding: '4px 10px',
          borderRadius: 8,
          background: state.bg,
          color: state.text,
          fontSize: 12,
          fontWeight: 600,
        }}>
          {state.label}
        </span>
        <span style={{ fontSize: 12, color: '#7a7a7a' }}>
          {proposal.votes} votes
        </span>
      </div>

      {/* Title */}
      <h3 style={{
        fontSize: 16,
        fontWeight: 700,
        color: '#eaeaea',
        marginBottom: 8,
        lineHeight: 1.4,
      }}>
        {proposal.title}
      </h3>

      {/* Body preview */}
      {proposal.body && (
        <p style={{
          fontSize: 13,
          color: '#8a8a8a',
          marginBottom: 16,
          lineHeight: 1.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {proposal.body.slice(0, 200)}
        </p>
      )}

      {/* Results bars */}
      {proposal.choices && proposal.scores && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {proposal.choices.map((choice, i) => {
            const score = proposal.scores[i] || 0
            const pct = totalVotes > 0 ? (score / totalVotes) * 100 : 0

            return (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, color: '#b0b0b0' }}>{choice}</span>
                  <span style={{ fontSize: 12, color: '#7a7a7a' }}>{pct.toFixed(1)}%</span>
                </div>
                <div style={{
                  height: 4,
                  borderRadius: 2,
                  background: 'rgba(255, 255, 255, 0.06)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    borderRadius: 2,
                    width: `${pct}%`,
                    background: i === 0 ? '#2fe57d' : i === 1 ? '#ff6b6b' : '#8b6fa8',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Footer: end time */}
      <div style={{ marginTop: 12, fontSize: 11, color: '#6a6a6a' }}>
        {isExpired
          ? `Ended ${endDate.toLocaleDateString()}`
          : `Ends ${endDate.toLocaleDateString()} ${endDate.toLocaleTimeString()}`
        }
      </div>
    </a>
  )
}
