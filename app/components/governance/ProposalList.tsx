'use client'

/**
 * ProposalList
 *
 * Fetches and displays Snapshot governance proposals for the Arena space.
 * Can be embedded in the main app or in a dedicated governance page.
 */

import { useState, useEffect } from 'react'
import { getProposals, getArenaSpaceId, getSpaceUrl, type SnapshotProposal } from '@/lib/web3/snapshot'
import { ProposalCard } from './ProposalCard'

interface ProposalListProps {
  /** Override the space ID (for group-specific spaces) */
  spaceId?: string
  /** Filter by state */
  state?: 'active' | 'closed' | 'pending'
  /** Max proposals to show */
  limit?: number
  /** Show header with link to Snapshot */
  showHeader?: boolean
}

export function ProposalList({ spaceId: spaceIdProp, state, limit = 10, showHeader = true }: ProposalListProps) {
  const [proposals, setProposals] = useState<SnapshotProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>(state as 'active' | 'closed' || 'all')

  const spaceId = spaceIdProp || getArenaSpaceId()

  useEffect(() => {
    if (!spaceId) {
      setLoading(false)
      return
    }

    async function load() {
      setLoading(true)
      try {
        const stateFilter = filter === 'all' ? undefined : filter as 'active' | 'closed' | 'pending'
        const data = await getProposals(spaceId!, {
          state: stateFilter,
          first: limit,
        })
        setProposals(data)
      } catch (err) {
        console.error('[Governance] Failed to load proposals:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [spaceId, filter, limit])

  if (!spaceId) {
    return (
      <div style={{
        padding: 32,
        textAlign: 'center',
        color: '#6a6a6a',
        fontSize: 14,
      }}>
        Governance is not configured yet. Set NEXT_PUBLIC_SNAPSHOT_SPACE_ID to enable voting.
      </div>
    )
  }

  return (
    <div>
      {showHeader && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#eaeaea' }}>
            Governance
          </h2>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Filter tabs */}
            {(['all', 'active', 'closed'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: filter === tab ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
                  color: filter === tab ? '#c9b8db' : '#7a7a7a',
                  fontSize: 13,
                  fontWeight: filter === tab ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                {tab === 'all' ? 'All' : tab === 'active' ? 'Active' : 'Closed'}
              </button>
            ))}

            {/* Link to Snapshot */}
            <a
              href={getSpaceUrl(spaceId)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid rgba(139, 111, 168, 0.3)',
                background: 'transparent',
                color: '#8b6fa8',
                fontSize: 12,
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              Snapshot
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              padding: 20,
              background: 'rgba(15, 15, 20, 0.6)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 16,
              height: 140,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <div style={{
          padding: 32,
          textAlign: 'center',
          color: '#6a6a6a',
          fontSize: 14,
        }}>
          No proposals found.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </div>
      )}
    </div>
  )
}
