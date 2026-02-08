/**
 * Snapshot Voting Integration
 *
 * Integrates with Snapshot's Hub API for gasless governance voting.
 * Pro NFT holders get voting power via Snapshot strategies.
 *
 * Snapshot is off-chain: signatures are free, no gas costs.
 */

const _SNAPSHOT_HUB = 'https://hub.snapshot.org'
const SNAPSHOT_GRAPHQL = 'https://hub.snapshot.org/graphql'

// ── Types ──

export interface SnapshotSpace {
  id: string
  name: string
  about: string
  network: string
  symbol: string
  members: string[]
  admins: string[]
  strategies: SnapshotStrategy[]
}

export interface SnapshotStrategy {
  name: string
  network: string
  params: Record<string, unknown>
}

export interface SnapshotProposal {
  id: string
  title: string
  body: string
  choices: string[]
  start: number
  end: number
  snapshot: string
  state: 'pending' | 'active' | 'closed'
  author: string
  scores: number[]
  scores_total: number
  votes: number
  space: { id: string; name: string }
  created: number
}

export interface SnapshotVote {
  id: string
  voter: string
  choice: number | number[]
  vp: number // voting power
  created: number
}

// ── GraphQL Queries ──

const PROPOSALS_QUERY = `
  query Proposals($space: String!, $first: Int!, $skip: Int!, $state: String) {
    proposals(
      first: $first
      skip: $skip
      where: { space: $space, state: $state }
      orderBy: "created"
      orderDirection: desc
    ) {
      id
      title
      body
      choices
      start
      end
      snapshot
      state
      author
      scores
      scores_total
      votes
      space { id name }
      created
    }
  }
`

const SINGLE_PROPOSAL_QUERY = `
  query Proposal($id: String!) {
    proposal(id: $id) {
      id
      title
      body
      choices
      start
      end
      snapshot
      state
      author
      scores
      scores_total
      votes
      space { id name }
      created
    }
  }
`

const VOTES_QUERY = `
  query Votes($proposal: String!, $first: Int!, $skip: Int!) {
    votes(
      first: $first
      skip: $skip
      where: { proposal: $proposal }
      orderBy: "vp"
      orderDirection: desc
    ) {
      id
      voter
      choice
      vp
      created
    }
  }
`

const SPACE_QUERY = `
  query Space($id: String!) {
    space(id: $id) {
      id
      name
      about
      network
      symbol
      members
      admins
      strategies {
        name
        network
        params
      }
    }
  }
`

// ── API Functions ──

async function graphqlQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(SNAPSHOT_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Snapshot API error: ${res.status}`)
  }

  const { data, errors } = await res.json()
  if (errors?.length) {
    throw new Error(errors[0].message)
  }

  return data
}

/**
 * Get a Snapshot space configuration.
 */
export async function getSpace(spaceId: string): Promise<SnapshotSpace | null> {
  const data = await graphqlQuery<{ space: SnapshotSpace | null }>(SPACE_QUERY, { id: spaceId })
  return data.space
}

/**
 * List proposals for a Snapshot space.
 */
export async function getProposals(
  spaceId: string,
  options?: { state?: 'active' | 'closed' | 'pending'; first?: number; skip?: number }
): Promise<SnapshotProposal[]> {
  const data = await graphqlQuery<{ proposals: SnapshotProposal[] }>(PROPOSALS_QUERY, {
    space: spaceId,
    first: options?.first || 20,
    skip: options?.skip || 0,
    state: options?.state || null,
  })
  return data.proposals
}

/**
 * Get a single proposal by ID.
 */
export async function getProposal(proposalId: string): Promise<SnapshotProposal | null> {
  const data = await graphqlQuery<{ proposal: SnapshotProposal | null }>(SINGLE_PROPOSAL_QUERY, {
    id: proposalId,
  })
  return data.proposal
}

/**
 * Get votes for a proposal.
 */
export async function getVotes(
  proposalId: string,
  options?: { first?: number; skip?: number }
): Promise<SnapshotVote[]> {
  const data = await graphqlQuery<{ votes: SnapshotVote[] }>(VOTES_QUERY, {
    proposal: proposalId,
    first: options?.first || 100,
    skip: options?.skip || 0,
  })
  return data.votes
}

/**
 * Check if a user has voted on a proposal.
 */
export async function hasVoted(proposalId: string, voterAddress: string): Promise<boolean> {
  const data = await graphqlQuery<{ votes: SnapshotVote[] }>(
    `query HasVoted($proposal: String!, $voter: String!) {
      votes(where: { proposal: $proposal, voter: $voter }) {
        id
      }
    }`,
    { proposal: proposalId, voter: voterAddress.toLowerCase() }
  )
  return data.votes.length > 0
}

/**
 * Get the Arena Snapshot space ID from environment.
 */
export function getArenaSpaceId(): string | null {
  return process.env.NEXT_PUBLIC_SNAPSHOT_SPACE_ID || null
}

/**
 * Get the Snapshot proposal URL for a given proposal.
 */
export function getProposalUrl(spaceId: string, proposalId: string): string {
  return `https://snapshot.org/#/${spaceId}/proposal/${proposalId}`
}

/**
 * Get the Snapshot space URL.
 */
export function getSpaceUrl(spaceId: string): string {
  return `https://snapshot.org/#/${spaceId}`
}
