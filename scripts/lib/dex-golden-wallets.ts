import { createHash } from 'node:crypto'

import { z } from 'zod'

import { hasBase58DecodedByteLength } from '../../lib/utils/base58'

import { strictCanonicalSha256 } from './dex-contract-hash'

export const DEX_GOLDEN_WALLET_SCHEMA_VERSION = 1 as const
export const DEX_GOLDEN_WALLET_CONTRACT = 'arena.dex.golden-wallets@1' as const
export const DEX_GOLDEN_WALLET_SUBSET_CONTRACT = 'arena.dex.golden-wallet-chain-subset@1' as const
export const DEX_GOLDEN_SNAPSHOT_MAX_AGE_HOURS = 24 as const

export type DexGoldenSource = 'binance_web3_bsc' | 'okx_web3_solana'
export type DexGoldenCohort = 'top' | 'deterministic_random' | 'high_frequency'
export type DexGoldenPnlCurrency = 'USDT' | 'USDC'

export interface DexGoldenWalletCandidate {
  sourceSlug: DexGoldenSource
  wallet: string
  snapshotId: string
  snapshotScrapedAt: string
  snapshotActualCount: number
  sourceRank: number
  arenaScore: null
  pnl90d: string
  pnlCurrency: DexGoldenPnlCurrency
  activityProxyCount: number
}

export interface DexGoldenWallet {
  source_slug: DexGoldenSource
  chain: { namespace: 'eip155' | 'solana'; reference: '56' | 'mainnet-beta' }
  wallet: string
  cohort: DexGoldenCohort
  source_snapshot_id: string
  source_snapshot_scraped_at: string
  source_rank: number
  arena_score: null
  pnl_90d: string
  pnl_currency: DexGoldenPnlCurrency
  activity_proxy_count: number
}

export interface DexGoldenWalletSnapshot {
  schema_version: 1
  data_contract: typeof DEX_GOLDEN_WALLET_CONTRACT
  purpose: 'phase0_shadow_sampling_only'
  generated_at: string
  generator_git_sha: string
  sample_seed: string
  candidate_timeframe_days: 90
  planned_hit_window_days: 7
  serving_authorized: false
  rank_eligible: false
  score_eligible: false
  selection: {
    snapshot_gate: 'latest_count_check_passed_snapshot'
    snapshot_freshness_max_hours: 24
    candidate_eligibility: 'snapshot_membership_and_non_null_headline_pnl'
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
    snapshot_actual_count: number
    pnl_currency: DexGoldenPnlCurrency
    eligible_candidates_with_non_null_pnl: number
    candidates_with_positive_activity_proxy: number
  }>
  wallets: DexGoldenWallet[]
}

export interface DexGoldenWalletChainSubset {
  data_contract: typeof DEX_GOLDEN_WALLET_SUBSET_CONTRACT
  parent_snapshot_sha256: string
  source_slug: DexGoldenSource
  chain: DexGoldenWallet['chain']
  wallet_count: 50
  wallets: DexGoldenWallet[]
}

const SOURCE_CONTRACT: Record<
  DexGoldenSource,
  DexGoldenWallet['chain'] & { walletPattern: RegExp; pnlCurrency: DexGoldenPnlCurrency }
> = {
  binance_web3_bsc: {
    namespace: 'eip155',
    reference: '56',
    walletPattern: /^0x[0-9a-fA-F]{40}$/,
    pnlCurrency: 'USDT',
  },
  okx_web3_solana: {
    namespace: 'solana',
    reference: 'mainnet-beta',
    walletPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    pnlCurrency: 'USDC',
  },
}

const COHORT_ORDER: Record<DexGoldenCohort, number> = {
  top: 0,
  deterministic_random: 1,
  high_frequency: 2,
}

const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')
const safePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, 'integer must be safe')
const safeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'integer must be safe')
const canonicalDecimalSchema = z
  .string()
  .regex(CANONICAL_DECIMAL)
  .refine((value) => Number.isFinite(Number(value)), 'decimal must be finite')

const goldenWalletSchema = z
  .object({
    source_slug: z.enum(['binance_web3_bsc', 'okx_web3_solana']),
    chain: z.union([
      z.object({ namespace: z.literal('eip155'), reference: z.literal('56') }).strict(),
      z.object({ namespace: z.literal('solana'), reference: z.literal('mainnet-beta') }).strict(),
    ]),
    wallet: z.string().min(1),
    cohort: z.enum(['top', 'deterministic_random', 'high_frequency']),
    source_snapshot_id: z.string().regex(/^[1-9]\d*$/),
    source_snapshot_scraped_at: canonicalTimestampSchema,
    source_rank: safePositiveIntegerSchema,
    arena_score: z.null(),
    pnl_90d: canonicalDecimalSchema,
    pnl_currency: z.enum(['USDT', 'USDC']),
    activity_proxy_count: safeNonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((wallet, context) => {
    if (
      wallet.source_slug === 'okx_web3_solana' &&
      !hasBase58DecodedByteLength(wallet.wallet, 32)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Solana wallet must decode to exactly 32 bytes',
        path: ['wallet'],
      })
    }
  })

const goldenPopulationSchema = z
  .object({
    source_slug: z.enum(['binance_web3_bsc', 'okx_web3_solana']),
    snapshot_id: z.string().regex(/^[1-9]\d*$/),
    snapshot_scraped_at: canonicalTimestampSchema,
    snapshot_actual_count: safePositiveIntegerSchema,
    pnl_currency: z.enum(['USDT', 'USDC']),
    eligible_candidates_with_non_null_pnl: safePositiveIntegerSchema,
    candidates_with_positive_activity_proxy: safeNonNegativeIntegerSchema,
  })
  .strict()

const goldenSnapshotSchema = z
  .object({
    schema_version: z.literal(DEX_GOLDEN_WALLET_SCHEMA_VERSION),
    data_contract: z.literal(DEX_GOLDEN_WALLET_CONTRACT),
    purpose: z.literal('phase0_shadow_sampling_only'),
    generated_at: canonicalTimestampSchema,
    generator_git_sha: z.string().regex(FULL_GIT_SHA),
    sample_seed: z.string().min(1),
    candidate_timeframe_days: z.literal(90),
    planned_hit_window_days: z.literal(7),
    serving_authorized: z.literal(false),
    rank_eligible: z.literal(false),
    score_eligible: z.literal(false),
    selection: z
      .object({
        snapshot_gate: z.literal('latest_count_check_passed_snapshot'),
        snapshot_freshness_max_hours: z.literal(DEX_GOLDEN_SNAPSHOT_MAX_AGE_HOURS),
        candidate_eligibility: z.literal('snapshot_membership_and_non_null_headline_pnl'),
        top_per_source: z.literal(20),
        deterministic_random_per_source: z.literal(20),
        high_frequency_per_source: z.literal(10),
        source_rank_field: z.literal('arena.leaderboard_entries.rank'),
        pnl_90d_field: z.literal('arena.leaderboard_entries.headline_pnl'),
        activity_metric: z.literal('latest_passed_90d_snapshot_source_reported_tx_count_proxy'),
        activity_fields: z
          .object({
            binance_web3_bsc: z.literal('arena.leaderboard_entries.raw.totalTxCnt'),
            okx_web3_solana: z.literal('arena.leaderboard_entries.raw.tx'),
          })
          .strict(),
      })
      .strict(),
    populations: z.array(goldenPopulationSchema).length(2),
    wallets: z.array(goldenWalletSchema).length(100),
  })
  .strict()

const dexGoldenWalletChainSubsetSchema = z
  .object({
    data_contract: z.literal(DEX_GOLDEN_WALLET_SUBSET_CONTRACT),
    parent_snapshot_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .refine((value) => !/^0{64}$/.test(value), 'parent snapshot SHA must be nonzero'),
    source_slug: z.enum(['binance_web3_bsc', 'okx_web3_solana']),
    chain: z.union([
      z.object({ namespace: z.literal('eip155'), reference: z.literal('56') }).strict(),
      z.object({ namespace: z.literal('solana'), reference: z.literal('mainnet-beta') }).strict(),
    ]),
    wallet_count: z.literal(50),
    wallets: z.array(goldenWalletSchema).length(50),
  })
  .strict()

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(`${label} must be a canonical ISO timestamp: ${value}`)
  }
}

function canonicalWallet(source: DexGoldenSource, wallet: string): string {
  const trimmed = wallet.trim()
  if (
    !SOURCE_CONTRACT[source].walletPattern.test(trimmed) ||
    (source === 'okx_web3_solana' && !hasBase58DecodedByteLength(trimmed, 32))
  ) {
    throw new Error(`invalid ${source} wallet`)
  }
  return source === 'binance_web3_bsc' ? trimmed.toLowerCase() : trimmed
}

function assertCanonicalDecimal(value: string, label: string): void {
  if (!CANONICAL_DECIMAL.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(`${label} must be a finite canonical decimal string`)
  }
}

function randomKey(seed: string, source: DexGoldenSource, wallet: string): string {
  return createHash('sha256').update(`${seed}:${source}:${wallet}`).digest('hex')
}

function byRank(a: DexGoldenWalletCandidate, b: DexGoldenWalletCandidate): number {
  if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank
  const aPnl = Number(a.pnl90d)
  const bPnl = Number(b.pnl90d)
  if (aPnl !== bPnl) return bPnl - aPnl
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
    const identityKey = `${candidate.sourceSlug}:${wallet}`
    const label = candidate.sourceSlug
    if (identities.has(identityKey)) throw new Error(`duplicate golden-wallet candidate: ${label}`)
    identities.add(identityKey)

    if (!Number.isSafeInteger(candidate.sourceRank) || candidate.sourceRank <= 0) {
      throw new Error(`sourceRank must be a positive safe integer: ${label}`)
    }
    if (!/^[1-9]\d*$/.test(candidate.snapshotId)) {
      throw new Error(`snapshotId must be a positive decimal string: ${label}`)
    }
    assertCanonicalTimestamp(candidate.snapshotScrapedAt, `snapshotScrapedAt for ${label}`)
    if (
      !Number.isSafeInteger(candidate.snapshotActualCount) ||
      candidate.snapshotActualCount <= 0
    ) {
      throw new Error(`snapshotActualCount must be a positive safe integer: ${label}`)
    }
    if (candidate.arenaScore !== null) throw new Error(`arenaScore must remain null: ${label}`)
    assertCanonicalDecimal(candidate.pnl90d, `pnl90d for ${label}`)
    if (candidate.pnlCurrency !== SOURCE_CONTRACT[candidate.sourceSlug].pnlCurrency) {
      throw new Error(`unexpected PnL currency for ${label}: ${candidate.pnlCurrency}`)
    }
    if (!Number.isSafeInteger(candidate.activityProxyCount) || candidate.activityProxyCount < 0) {
      throw new Error(`activityProxyCount must be a non-negative safe integer: ${label}`)
    }
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
    pnl_currency: candidate.pnlCurrency,
    activity_proxy_count: candidate.activityProxyCount,
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
    const snapshotAgeMs =
      Date.parse(input.generatedAt) - Date.parse(sourceCandidates[0].snapshotScrapedAt)
    const maxSnapshotAgeMs = DEX_GOLDEN_SNAPSHOT_MAX_AGE_HOURS * 60 * 60 * 1000
    if (snapshotAgeMs < 0 || snapshotAgeMs > maxSnapshotAgeMs) {
      throw new Error(`${source} passed source snapshot is outside the freshness gate`)
    }
    const snapshotActualCounts = new Set(
      sourceCandidates.map((candidate) => candidate.snapshotActualCount)
    )
    if (snapshotActualCounts.size !== 1) {
      throw new Error(`${source} candidates must share one source snapshot actual count`)
    }
    const snapshotActualCount = sourceCandidates[0].snapshotActualCount
    if (sourceCandidates.length > snapshotActualCount) {
      throw new Error(`${source} eligible candidates exceed source snapshot actual count`)
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
      snapshot_actual_count: snapshotActualCount,
      pnl_currency: SOURCE_CONTRACT[source].pnlCurrency,
      eligible_candidates_with_non_null_pnl: sourceCandidates.length,
      candidates_with_positive_activity_proxy: sourceCandidates.filter(
        (candidate) => candidate.activityProxyCount > 0
      ).length,
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
    purpose: 'phase0_shadow_sampling_only',
    generated_at: input.generatedAt,
    generator_git_sha: input.generatorGitSha,
    sample_seed: input.sampleSeed,
    candidate_timeframe_days: 90,
    planned_hit_window_days: 7,
    serving_authorized: false,
    rank_eligible: false,
    score_eligible: false,
    selection: {
      snapshot_gate: 'latest_count_check_passed_snapshot',
      snapshot_freshness_max_hours: DEX_GOLDEN_SNAPSHOT_MAX_AGE_HOURS,
      candidate_eligibility: 'snapshot_membership_and_non_null_headline_pnl',
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
  return { snapshot, sha256: strictCanonicalSha256(snapshot) }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}

function assertParsedSnapshotInvariants(snapshot: DexGoldenWalletSnapshot): void {
  const expectedSources = Object.keys(SOURCE_CONTRACT).sort() as DexGoldenSource[]
  if (
    snapshot.populations.map((population) => population.source_slug).join(',') !==
    expectedSources.join(',')
  ) {
    throw new Error('golden-wallet populations must use canonical source order')
  }

  assertUnique(
    snapshot.wallets.map((wallet) => wallet.wallet),
    'global wallet identity'
  )
  const expectedWalletOrder = [...snapshot.wallets].sort(
    (a, b) =>
      a.source_slug.localeCompare(b.source_slug) ||
      COHORT_ORDER[a.cohort] - COHORT_ORDER[b.cohort] ||
      a.wallet.localeCompare(b.wallet)
  )
  if (expectedWalletOrder.some((wallet, index) => wallet !== snapshot.wallets[index])) {
    throw new Error('golden-wallet rows must use canonical source/cohort/wallet order')
  }

  for (const source of expectedSources) {
    const population = snapshot.populations.find((item) => item.source_slug === source)!
    if (
      population.eligible_candidates_with_non_null_pnl > population.snapshot_actual_count ||
      population.candidates_with_positive_activity_proxy >
        population.eligible_candidates_with_non_null_pnl
    ) {
      throw new Error(`${source} population denominators are inconsistent`)
    }
    if (population.pnl_currency !== SOURCE_CONTRACT[source].pnlCurrency) {
      throw new Error(`${source} population currency conflicts with its source contract`)
    }
    const ageMs = Date.parse(snapshot.generated_at) - Date.parse(population.snapshot_scraped_at)
    const maxAgeMs = snapshot.selection.snapshot_freshness_max_hours * 60 * 60 * 1000
    if (ageMs < 0 || ageMs > maxAgeMs) {
      throw new Error(`${source} parsed snapshot is outside the freshness gate`)
    }

    const sourceWallets = snapshot.wallets.filter((wallet) => wallet.source_slug === source)
    if (sourceWallets.length !== 50) throw new Error(`${source} must contain exactly 50 wallets`)
    assertUnique(
      sourceWallets.map((wallet) => String(wallet.source_rank)),
      `${source} source rank`
    )
    const expectedCohorts: Record<DexGoldenCohort, number> = {
      top: 20,
      deterministic_random: 20,
      high_frequency: 10,
    }
    for (const [cohort, expectedCount] of Object.entries(expectedCohorts) as Array<
      [DexGoldenCohort, number]
    >) {
      if (sourceWallets.filter((wallet) => wallet.cohort === cohort).length !== expectedCount) {
        throw new Error(`${source} has an invalid ${cohort} cohort size`)
      }
    }

    for (const wallet of sourceWallets) {
      if (canonicalWallet(source, wallet.wallet) !== wallet.wallet) {
        throw new Error(`${source} wallet is not canonical`)
      }
      const { namespace, reference, pnlCurrency } = SOURCE_CONTRACT[source]
      if (wallet.chain.namespace !== namespace || wallet.chain.reference !== reference) {
        throw new Error(`${source} wallet chain conflicts with its source contract`)
      }
      if (wallet.pnl_currency !== pnlCurrency) {
        throw new Error(`${source} wallet currency conflicts with its source contract`)
      }
      if (
        wallet.source_snapshot_id !== population.snapshot_id ||
        wallet.source_snapshot_scraped_at !== population.snapshot_scraped_at
      ) {
        throw new Error(`${source} wallet provenance conflicts with its source population`)
      }
      if (wallet.cohort === 'high_frequency' && wallet.activity_proxy_count === 0) {
        throw new Error(`${source} high-frequency wallet requires positive activity`)
      }
    }
  }
}

function assertParsedChainSubsetInvariants(subset: DexGoldenWalletChainSubset): void {
  const source = subset.source_slug
  const contract = SOURCE_CONTRACT[source]
  if (
    subset.chain.namespace !== contract.namespace ||
    subset.chain.reference !== contract.reference
  ) {
    throw new Error(`${source} chain subset conflicts with its source contract`)
  }
  assertUnique(
    subset.wallets.map((wallet) => wallet.wallet),
    `${source} chain subset wallet identity`
  )
  assertUnique(
    subset.wallets.map((wallet) => String(wallet.source_rank)),
    `${source} chain subset source rank`
  )
  if (new Set(subset.wallets.map((wallet) => wallet.source_snapshot_id)).size !== 1) {
    throw new Error(`${source} chain subset must use one source snapshot`)
  }
  if (new Set(subset.wallets.map((wallet) => wallet.source_snapshot_scraped_at)).size !== 1) {
    throw new Error(`${source} chain subset must use one snapshot timestamp`)
  }

  const expectedCohorts: Record<DexGoldenCohort, number> = {
    top: 20,
    deterministic_random: 20,
    high_frequency: 10,
  }
  for (const [cohort, expectedCount] of Object.entries(expectedCohorts) as Array<
    [DexGoldenCohort, number]
  >) {
    if (subset.wallets.filter((wallet) => wallet.cohort === cohort).length !== expectedCount) {
      throw new Error(`${source} chain subset has an invalid ${cohort} cohort size`)
    }
  }

  for (const wallet of subset.wallets) {
    if (wallet.source_slug !== source) {
      throw new Error(`${source} chain subset contains a foreign source wallet`)
    }
    if (
      wallet.chain.namespace !== contract.namespace ||
      wallet.chain.reference !== contract.reference
    ) {
      throw new Error(`${source} chain subset contains a foreign chain wallet`)
    }
    if (canonicalWallet(source, wallet.wallet) !== wallet.wallet) {
      throw new Error(`${source} chain subset wallet is not canonical`)
    }
    if (wallet.pnl_currency !== contract.pnlCurrency) {
      throw new Error(`${source} chain subset wallet has an invalid PnL currency`)
    }
    if (wallet.cohort === 'high_frequency' && wallet.activity_proxy_count === 0) {
      throw new Error(`${source} chain subset high-frequency wallet requires positive activity`)
    }
  }

  const expectedOrder = [...subset.wallets].sort(
    (a, b) => COHORT_ORDER[a.cohort] - COHORT_ORDER[b.cohort] || a.wallet.localeCompare(b.wallet)
  )
  if (expectedOrder.some((wallet, index) => wallet !== subset.wallets[index])) {
    throw new Error(`${source} chain subset wallets must use canonical cohort/wallet order`)
  }
}

export function parseDexGoldenWalletSnapshot(input: unknown): DexGoldenWalletSnapshot {
  const snapshot = goldenSnapshotSchema.parse(input) as DexGoldenWalletSnapshot
  assertParsedSnapshotInvariants(snapshot)
  return snapshot
}

export function dexGoldenWalletSnapshotSha256(input: unknown): string {
  return strictCanonicalSha256(parseDexGoldenWalletSnapshot(input))
}

export function parseDexGoldenWalletChainSubset(input: unknown): DexGoldenWalletChainSubset {
  const subset = dexGoldenWalletChainSubsetSchema.parse(input) as DexGoldenWalletChainSubset
  assertParsedChainSubsetInvariants(subset)
  return subset
}

export function dexGoldenWalletChainSubsetSha256(input: unknown): string {
  return strictCanonicalSha256(parseDexGoldenWalletChainSubset(input))
}

export function buildDexGoldenWalletChainSubset(
  input: unknown,
  source: DexGoldenSource
): { subset: DexGoldenWalletChainSubset; sha256: string } {
  const snapshot = parseDexGoldenWalletSnapshot(input)
  const wallets = snapshot.wallets.filter((wallet) => wallet.source_slug === source)
  if (wallets.length !== 50) throw new Error(`${source} chain subset requires exactly 50 wallets`)

  const subset: DexGoldenWalletChainSubset = {
    data_contract: DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
    parent_snapshot_sha256: strictCanonicalSha256(snapshot),
    source_slug: source,
    chain: wallets[0].chain,
    wallet_count: 50,
    wallets,
  }
  const parsedSubset = parseDexGoldenWalletChainSubset(subset)
  return { subset: parsedSubset, sha256: strictCanonicalSha256(parsedSubset) }
}
