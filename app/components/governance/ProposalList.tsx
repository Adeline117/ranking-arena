'use client'

/**
 * ProposalList
 *
 * Fetches and displays Snapshot governance proposals for the Arena space.
 * Uses SWR for caching and revalidation.
 */

import { useState } from 'react'
import useSWR from 'swr'
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
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>(state as 'active' | 'closed' || 'all')
  const spaceId = spaceIdProp || getArenaSpaceId()

  const { data: proposals, error, isLoading } = useSWR<SnapshotProposal[]>(
    spaceId ? ['snapshot-proposals', spaceId, filter, limit] : null,
    () => getProposals(spaceId!, {
      state: filter === 'all' ? undefined : filter as 'active' | 'closed' | 'pending',
      first: limit,
    }),
    { revalidateOnFocus: false, dedupingInterval: 30_000, errorRetryCount: 2 }
  )

  if (!spaceId) {
    return (
      <div className="p-8 text-center text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
        Governance is not configured yet. Set NEXT_PUBLIC_SNAPSHOT_SPACE_ID to enable voting.
      </div>
    )
  }

  return (
    <div>
      {showHeader && (
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            Governance
          </h2>

          <div className="flex gap-2 items-center">
            {/* Filter tabs */}
            {(['all', 'active', 'closed'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className="px-3.5 py-1.5 rounded-lg border-none text-[13px] cursor-pointer transition-all duration-200"
                style={filter === tab
                  ? { background: `color-mix(in srgb, var(--color-brand) 15%, transparent)`, color: 'var(--color-brand-accent)', fontWeight: 600 }
                  : { background: 'transparent', color: 'var(--color-text-secondary)', fontWeight: 500 }
                }
              >
                {tab === 'all' ? 'All' : tab === 'active' ? 'Active' : 'Closed'}
              </button>
            ))}

            {/* Link to Snapshot */}
            <a
              href={getSpaceUrl(spaceId)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-transparent text-xs font-semibold no-underline inline-flex items-center gap-1 transition-colors"
              style={{ border: `1px solid color-mix(in srgb, var(--color-brand) 30%, transparent)`, color: 'var(--color-brand)' }}
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

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="p-5 rounded-2xl h-[140px] animate-pulse"
              style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-primary)' }}
            />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
          Failed to load proposals. Please try again later.
        </div>
      ) : !proposals?.length ? (
        <div className="p-8 text-center text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
          No proposals found.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </div>
      )}
    </div>
  )
}
