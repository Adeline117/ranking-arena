import { createHash } from 'node:crypto'

import { canonicalSha256 } from './dex-census'

export const DEX_GOLDEN_WALLET_SCHEMA_VERSION = 1 as const
export const DEX_GOLDEN_WALLET_CONTRACT = 'arena.dex.golden-wallets@1' as const

export type DexGoldenSource = 'binance_web3_bsc' | 'okx_web3_solana'
export type DexGoldenCohort = 'top' | 'deterministic_random' | 'high_frequency'

export interface DexGoldenWalletCandidate {
  sourceSlug: DexGoldenSource
  wallet: string
  snapshotId: string
  snapshotScrapedAt: string
  sourceRank: number | null
  arenaScore: number | null
  pnl90d: number
  activityProxyCount: number
  metricAsOf: string
}

export interface DexGoldenWallet {
  source_slug: DexGoldenSource
  chain: { namespace: 'eip155' | 'solana'; reference: '56' | 'mainnet-beta' }
  wallet: string
  cohort: DexGoldenCohort
  source_snapshot_id: string
  source_snapshot_scraped_at: string
  source_rank: number | null
  arena_score: number | null
  pnl_90d: number
  activity_proxy_count: number
  metric_as_of: string
}

export interface DexGoldenWalletSnapshot {
  schema_version: 1
  data_contract: typeof DEX_GOLDEN_WALLET_CONTRACT
  generated_at: string
  generator_git_sha: string
  sample_seed: string
  lookback_days: 7
  serving_authorized: false
  rank_eligible: false
  selection: {
    top_per_source: 20
    deterministic_random_per_source: 20
    high_frequency_per_source: 10
    source_rank_field: 'arena.leaderboard_entries.rank'
    pnl_90d_field: 'arena.leaderboard_entries.headline_pnl'
    activity_metric: 'latest_passed_90d_snapshot_source_reported_tx_count_proxy'
    activity_fields: Record<DexGoldenSource, string>
  }
  populations: Array<{
    source_slug: DexGoldenSource
    snapshot_id: string
    snapshot_scraped_at: string
    eligible_candidates: number
    candidates_with_activity_proxy: number
    max_metric_as_of: string
  }>
  wallets: DexGoldenWallet[]
}

const SOURCE_CONTRACT: Record<
  DexGoldenSource,
  DexGoldenWallet['chain'] & { walletPattern: RegExp }
> = {
  binance_web3_bsc: {
    namespace: 'eip155',
    reference: '56',
    walletPattern: /^0x[0-9a-fA-F]{40}$/,
  },
  okx_web3_solana: {
    namespace: 'solana',
    reference: 'mainnet-beta',
    walletPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
}

const COHORT_ORDER: Record<DexGoldenCohort, number> = {
  top: 0,
  deterministic_random: 1,
  high_frequency: 2,
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp: ${value}`)
  }
}

function canonicalWallet(source: DexGoldenSource, wallet: string): string {
  const trimmed = wallet.trim()
  if (!SOURCE_CONTRACT[source].walletPattern.test(trimmed)) {
    throw new Error(`invalid ${source} wallet: ${wallet}`)
  }
  return source === 'binance_web3_bsc' ? trimmed.toLowerCase() : trimmed
}

function assertFiniteNullable(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite or null`)
}

function randomKey(seed: string, source: DexGoldenSource, wallet: string): string {
  return createHash('sha256').update(`${seed}:${source}:${wallet}`).digest('hex')
}

function byRank(a: DexGoldenWalletCandidate, b: DexGoldenWalletCandidate): number {
  const aRank = a.sourceRank ?? Number.POSITIVE_INFINITY
  const bRank = b.sourceRank ?? Number.POSITIVE_INFINITY
  if (aRank !== bRank) return aRank - bRank
  const aScore = a.arenaScore ?? Number.NEGATIVE_INFINITY
  const bScore = b.arenaScore ?? Number.NEGATIVE_INFINITY
  if (aScore !== bScore) return bScore - aScore
  if (a.pnl90d !== b.pnl90d) return b.pnl90d - a.pnl90d
  return a.wallet.localeCompare(b.wallet)
}

function byActivity(a: DexGoldenWalletCandidate, b: DexGoldenWalletCandidate): number {
  if (a.activityProxyCount !== b.activityProxyCount) {
    return b.activityProxyCount - a.activityProxyCount
  }
  return byRank(a, b)
}

function validateAndCanonicalize(
  candidates: readonly DexGoldenWalletCandidate[]
): DexGoldenWalletCandidate[] {
  const identities = new Set<string>()
  return candidates.map((candidate) => {
    if (!(candidate.sourceSlug in SOURCE_CONTRACT)) {
      throw new Error(`unsupported golden-wallet source: ${candidate.sourceSlug}`)
    }
    const wallet = canonicalWallet(candidate.sourceSlug, candidate.wallet)
    const identity = `${candidate.sourceSlug}:${wallet}`
    if (identities.has(identity)) throw new Error(`duplicate golden-wallet candidate: ${identity}`)
    identities.add(identity)

    if (
      candidate.sourceRank !== null &&
      (!Number.isSafeInteger(candidate.sourceRank) || candidate.sourceRank <= 0)
    ) {
      throw new Error(`sourceRank must be a positive safe integer or null: ${identity}`)
    }
    if (!/^[1-9]\d*$/.test(candidate.snapshotId)) {
      throw new Error(`snapshotId must be a positive decimal string: ${identity}`)
    }
    assertCanonicalTimestamp(candidate.snapshotScrapedAt, `snapshotScrapedAt for ${identity}`)
    assertFiniteNullable(candidate.arenaScore, `arenaScore for ${identity}`)
    if (!Number.isFinite(candidate.pnl90d)) throw new Error(`pnl90d must be finite: ${identity}`)
    if (!Number.isSafeInteger(candidate.activityProxyCount) || candidate.activityProxyCount < 0) {
      throw new Error(`activityProxyCount must be a non-negative safe integer: ${identity}`)
    }
    assertCanonicalTimestamp(candidate.metricAsOf, `metricAsOf for ${identity}`)
    return { ...candidate, wallet }
  })
}

function selectedWallet(
  candidate: DexGoldenWalletCandidate,
  cohort: DexGoldenCohort
): DexGoldenWallet {
  const { namespace, reference } = SOURCE_CONTRACT[candidate.sourceSlug]
  return {
    source_slug: candidate.sourceSlug,
    chain: { namespace, reference },
    wallet: candidate.wallet,
    cohort,
    source_snapshot_id: candidate.snapshotId,
    source_snapshot_scraped_at: candidate.snapshotScrapedAt,
    source_rank: candidate.sourceRank,
    arena_score: candidate.arenaScore,
    pnl_90d: candidate.pnl90d,
    activity_proxy_count: candidate.activityProxyCount,
    metric_as_of: candidate.metricAsOf,
  }
}

export function buildDexGoldenWalletSnapshot(input: {
  candidates: readonly DexGoldenWalletCandidate[]
  generatedAt: string
  generatorGitSha: string
  sampleSeed: string
}): { snapshot: DexGoldenWalletSnapshot; sha256: string } {
  assertCanonicalTimestamp(input.generatedAt, 'generatedAt')
  if (!/^[0-9a-f]{40}$/.test(input.generatorGitSha)) {
    throw new Error('generatorGitSha must be a full lowercase 40-character Git SHA')
  }
  if (!input.sampleSeed.trim()) throw new Error('sampleSeed must not be empty')

  const candidates = validateAndCanonicalize(input.candidates)
  const wallets: DexGoldenWallet[] = []
  const populations: DexGoldenWalletSnapshot['populations'] = []

  for (const source of Object.keys(SOURCE_CONTRACT).sort() as DexGoldenSource[]) {
    const sourceCandidates = candidates.filter((candidate) => candidate.sourceSlug === source)
    if (sourceCandidates.length < 50) {
      throw new Error(`${source} requires at least 50 eligible candidates`)
    }
    const snapshotIds = new Set(sourceCandidates.map((candidate) => candidate.snapshotId))
    const snapshotTimes = new Set(sourceCandidates.map((candidate) => candidate.snapshotScrapedAt))
    if (snapshotIds.size !== 1 || snapshotTimes.size !== 1) {
      throw new Error(`${source} candidates must come from one passed source snapshot`)
    }
    const selected = new Set<string>()

    const top = [...sourceCandidates].sort(byRank).slice(0, 20)
    for (const candidate of top) {
      selected.add(candidate.wallet)
      wallets.push(selectedWallet(candidate, 'top'))
    }

    const highFrequency = sourceCandidates
      .filter((candidate) => !selected.has(candidate.wallet) && candidate.activityProxyCount > 0)
      .sort(byActivity)
      .slice(0, 10)
    if (highFrequency.length !== 10) {
      throw new Error(`${source} requires 10 non-top candidates with an activity proxy`)
    }
    for (const candidate of highFrequency) {
      selected.add(candidate.wallet)
      wallets.push(selectedWallet(candidate, 'high_frequency'))
    }

    const deterministicRandom = sourceCandidates
      .filter((candidate) => !selected.has(candidate.wallet))
      .sort((a, b) =>
        randomKey(input.sampleSeed, source, a.wallet).localeCompare(
          randomKey(input.sampleSeed, source, b.wallet)
        )
      )
      .slice(0, 20)
    if (deterministicRandom.length !== 20) {
      throw new Error(`${source} requires 20 non-overlapping deterministic-random candidates`)
    }
    for (const candidate of deterministicRandom) {
      selected.add(candidate.wallet)
      wallets.push(selectedWallet(candidate, 'deterministic_random'))
    }

    populations.push({
      source_slug: source,
      snapshot_id: sourceCandidates[0].snapshotId,
      snapshot_scraped_at: sourceCandidates[0].snapshotScrapedAt,
      eligible_candidates: sourceCandidates.length,
      candidates_with_activity_proxy: sourceCandidates.filter(
        (candidate) => candidate.activityProxyCount > 0
      ).length,
      max_metric_as_of: sourceCandidates
        .map((candidate) => candidate.metricAsOf)
        .sort()
        .at(-1)!,
    })
  }

  wallets.sort(
    (a, b) =>
      a.source_slug.localeCompare(b.source_slug) ||
      COHORT_ORDER[a.cohort] - COHORT_ORDER[b.cohort] ||
      a.wallet.localeCompare(b.wallet)
  )
  if (wallets.length !== 100 || new Set(wallets.map((wallet) => wallet.wallet)).size !== 100) {
    throw new Error('golden-wallet snapshot must contain 100 globally unique wallets')
  }

  const snapshot: DexGoldenWalletSnapshot = {
    schema_version: DEX_GOLDEN_WALLET_SCHEMA_VERSION,
    data_contract: DEX_GOLDEN_WALLET_CONTRACT,
    generated_at: input.generatedAt,
    generator_git_sha: input.generatorGitSha,
    sample_seed: input.sampleSeed,
    lookback_days: 7,
    serving_authorized: false,
    rank_eligible: false,
    selection: {
      top_per_source: 20,
      deterministic_random_per_source: 20,
      high_frequency_per_source: 10,
      source_rank_field: 'arena.leaderboard_entries.rank',
      pnl_90d_field: 'arena.leaderboard_entries.headline_pnl',
      activity_metric: 'latest_passed_90d_snapshot_source_reported_tx_count_proxy',
      activity_fields: {
        binance_web3_bsc: 'arena.leaderboard_entries.raw.totalTxCnt',
        okx_web3_solana: 'arena.leaderboard_entries.raw.tx',
      },
    },
    populations,
    wallets,
  }
  return { snapshot, sha256: canonicalSha256(snapshot) }
}
