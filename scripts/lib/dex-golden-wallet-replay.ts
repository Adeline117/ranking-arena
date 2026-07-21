import { dexContractSha256 } from './dex-contract-hash'
import {
  buildDexGoldenWalletCandidates,
  DEX_GOLDEN_SOURCES,
  type DexGoldenWalletQueryRow,
} from './dex-golden-wallet-query'
import {
  buildDexGoldenWalletSnapshot,
  compareDexGoldenText,
  compareDexGoldenWalletIdentity,
  dexGoldenWalletSnapshotSha256,
  parseDexGoldenWalletSnapshot,
  type DexGoldenSource,
  type DexGoldenWalletCandidate,
} from './dex-golden-wallets'

export const DEX_GOLDEN_PINNED_REBUILD_SCHEMA_VERSION = 1 as const
export const DEX_GOLDEN_PINNED_REBUILD_CONTRACT =
  'arena.dex.golden-wallet-pinned-snapshot-rebuild@1' as const
export const DEX_GOLDEN_PINNED_QUERY_CONTRACT = 'arena.dex.golden-wallet-pinned-query@1' as const
export const DEX_GOLDEN_QUERY_ROW_SET_CONTRACT = 'arena.dex.golden-wallet-query-row-set@1' as const
export const DEX_GOLDEN_CANDIDATE_SET_CONTRACT = 'arena.dex.golden-wallet-candidate-set@1' as const
export const DEX_GOLDEN_PRODUCTION_PROJECT_REF = 'iknktzifjdyujdccyhsv' as const

const CANDIDATE_SELECT = `
SELECT l.slug AS source_slug,
       l.source_currency,
       le.currency AS entry_currency,
       l.source_meta_chain_id,
       l.snapshot_id,
       l.snapshot_scraped_at,
       l.snapshot_actual_count,
       l.is_derived,
       t.wallet_address,
       t.exchange_trader_id,
       le.rank AS source_rank,
       le.headline_pnl::text AS pnl_90d_raw,
       CASE
         WHEN l.slug = 'binance_web3_bsc'
           THEN jsonb_typeof(le.raw->'totalTxCnt')
         ELSE jsonb_typeof(le.raw->'tx')
       END AS activity_json_type,
       CASE
         WHEN l.slug = 'binance_web3_bsc'
           THEN le.raw->>'totalTxCnt'
         ELSE le.raw->>'tx'
       END AS activity_total_raw,
       jsonb_typeof(le.raw->'buyTxCnt') AS activity_buy_json_type,
       le.raw->>'buyTxCnt' AS activity_buy_raw,
       jsonb_typeof(le.raw->'sellTxCnt') AS activity_sell_json_type,
       le.raw->>'sellTxCnt' AS activity_sell_raw,
       le.raw->>'periodType' AS period_type,
       le.raw->>'chainId' AS raw_chain_id
  FROM selected l
  JOIN arena.leaderboard_entries le
    ON le.snapshot_id = l.snapshot_id::bigint
   AND le.scraped_at = l.snapshot_scraped_at
   AND le.timeframe = 90
  JOIN arena.traders t
    ON t.id = le.trader_id
   AND t.source_id = l.source_id
 ORDER BY l.slug, le.rank, t.exchange_trader_id`

/**
 * Replay one exact source/snapshot pair per golden source. Current source
 * serving status is deliberately excluded: it is mutable and was not frozen
 * in the v1 fixture. Immutable snapshot gates remain enforced.
 */
export const DEX_GOLDEN_PINNED_CANDIDATE_QUERY = `
WITH requested(source_slug, snapshot_id) AS MATERIALIZED (
  SELECT request.source_slug, request.snapshot_id
    FROM unnest($1::text[], $2::bigint[])
      AS request(source_slug, snapshot_id)
),
selected AS MATERIALIZED (
  SELECT s.slug,
         s.id AS source_id,
         s.currency AS source_currency,
         s.meta->>'chain_id' AS source_meta_chain_id,
         ls.id::text AS snapshot_id,
         ls.scraped_at AS snapshot_scraped_at,
         ls.actual_count AS snapshot_actual_count,
         ls.is_derived
    FROM requested r
    JOIN arena.sources s
      ON s.slug = r.source_slug
    JOIN arena.leaderboard_snapshots ls
      ON ls.id = r.snapshot_id
     AND ls.source_id = s.id
   WHERE ls.timeframe = 90
     AND ls.count_check_passed
)
${CANDIDATE_SELECT}`

export type DexGoldenGeneratorMode = 'generate-latest' | 'verify-pinned'

export interface DexGoldenPinnedQueryParameters {
  sourceSlugs: DexGoldenSource[]
  snapshotIds: string[]
}

export interface DexGoldenPinnedRebuildReport {
  schema_version: typeof DEX_GOLDEN_PINNED_REBUILD_SCHEMA_VERSION
  data_contract: typeof DEX_GOLDEN_PINNED_REBUILD_CONTRACT
  result: 'selected_fixture_rebuilt'
  verification_scope: 'normalized_leaderboard_snapshot_rows_only'
  selected_fixture_sha256_verified: true
  provider_refetch_performed: false
  provider_body_persistence_authorized: false
  population_denominator_authorized: false
  serving_authorized: false
  rank_eligible: false
  score_eligible: false
  verifier_git_sha: string
  verifier_worktree_clean: true
  database_url_binding: 'literal_authority_bound_to_ranking_arena_project_ref'
  tls_transport_encrypted: true
  tls_server_identity_verified: false
  production_database_identity_verified: false
  fixture_generator_git_sha: string
  fixture_generated_at: string
  source_snapshot_pins: Array<{
    source_slug: DexGoldenSource
    snapshot_id: string
    snapshot_scraped_at: string
    snapshot_actual_count: number
  }>
  candidate_query_binding: 'verifier_code_only_not_parent_fixture'
  candidate_query_sha256: string
  queried_row_set_commitment_state: 'observed_unpinned'
  observed_query_row_set_sha256: string
  queried_row_count: number
  eligible_candidate_set_commitment_state: 'observed_unpinned'
  observed_eligible_candidate_set_sha256: string
  eligible_candidate_count: number
  eligible_candidate_counts: Record<DexGoldenSource, number>
  expected_snapshot_sha256: string
  rebuilt_snapshot_sha256: string
}

interface CanonicalQueryRow {
  source_slug: string
  snapshot_id: string
  snapshot_scraped_at: string
  snapshot_actual_count: number
  source_currency: string
  entry_currency: string
  source_meta_chain_id: string | null
  is_derived: boolean
  wallet_address: string | null
  exchange_trader_id: string
  source_rank: number
  pnl_90d_raw: string | null
  activity_json_type: string | null
  activity_total_raw: string | null
  activity_buy_json_type: string | null
  activity_buy_raw: string | null
  activity_sell_json_type: string | null
  activity_sell_raw: string | null
  period_type: string | null
  raw_chain_id: string | null
}

function canonicalTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('query row timestamp is invalid')
  return parsed.toISOString()
}

function canonicalQueryRows(rows: readonly DexGoldenWalletQueryRow[]): CanonicalQueryRow[] {
  return rows
    .map((row) => ({
      source_slug: row.source_slug,
      snapshot_id: row.snapshot_id,
      snapshot_scraped_at: canonicalTimestamp(row.snapshot_scraped_at),
      snapshot_actual_count: row.snapshot_actual_count,
      source_currency: row.source_currency,
      entry_currency: row.entry_currency,
      source_meta_chain_id: row.source_meta_chain_id,
      is_derived: row.is_derived,
      wallet_address: row.wallet_address,
      exchange_trader_id: row.exchange_trader_id,
      source_rank: row.source_rank,
      pnl_90d_raw: row.pnl_90d_raw,
      activity_json_type: row.activity_json_type,
      activity_total_raw: row.activity_total_raw,
      activity_buy_json_type: row.activity_buy_json_type,
      activity_buy_raw: row.activity_buy_raw,
      activity_sell_json_type: row.activity_sell_json_type,
      activity_sell_raw: row.activity_sell_raw,
      period_type: row.period_type,
      raw_chain_id: row.raw_chain_id,
    }))
    .sort(
      (left, right) =>
        compareDexGoldenText(left.source_slug, right.source_slug) ||
        left.source_rank - right.source_rank ||
        compareDexGoldenWalletIdentity(left.exchange_trader_id, right.exchange_trader_id)
    )
}

function canonicalCandidates(
  candidates: readonly DexGoldenWalletCandidate[]
): Array<Record<string, unknown>> {
  return candidates
    .map((candidate) => ({
      source_slug: candidate.sourceSlug,
      wallet:
        candidate.sourceSlug === 'binance_web3_bsc'
          ? candidate.wallet.toLowerCase()
          : candidate.wallet,
      snapshot_id: candidate.snapshotId,
      snapshot_scraped_at: candidate.snapshotScrapedAt,
      snapshot_actual_count: candidate.snapshotActualCount,
      source_rank: candidate.sourceRank,
      arena_score: candidate.arenaScore,
      pnl_90d: candidate.pnl90d,
      pnl_currency: candidate.pnlCurrency,
      activity_proxy_count: candidate.activityProxyCount,
    }))
    .sort((left, right) => {
      const leftSource = String(left.source_slug)
      const rightSource = String(right.source_slug)
      return (
        compareDexGoldenText(leftSource, rightSource) ||
        Number(left.source_rank) - Number(right.source_rank) ||
        compareDexGoldenWalletIdentity(String(left.wallet), String(right.wallet))
      )
    })
}

function contractHash(domain: string, schemaId: string, payload: unknown): string {
  return dexContractSha256(
    {
      domain,
      schema_id: schemaId,
      schema_version: DEX_GOLDEN_PINNED_REBUILD_SCHEMA_VERSION,
    },
    payload
  )
}

export function parseDexGoldenGeneratorArgs(args: readonly string[]): DexGoldenGeneratorMode {
  if (args.length === 0) return 'generate-latest'
  if (args.length === 1 && args[0] === '--verify-pinned') return 'verify-pinned'
  throw new Error('Usage: generate-dex-golden-wallets.mts [--verify-pinned]')
}

export function assertDexGoldenProductionDatabaseUrlLiteral(databaseUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('golden-wallet database URL is not a valid URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('golden-wallet database URL must use postgres or postgresql')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('golden-wallet database URL must not contain query parameters or a fragment')
  }
  if (parsed.pathname !== '/postgres') {
    throw new Error('golden-wallet database URL must select the postgres database explicitly')
  }

  let username: string
  try {
    username = decodeURIComponent(parsed.username).toLowerCase()
  } catch {
    throw new Error('golden-wallet database URL has invalid username encoding')
  }
  const hostname = parsed.hostname.toLowerCase()
  const projectRef = DEX_GOLDEN_PRODUCTION_PROJECT_REF.toLowerCase()
  const directHostMatches = hostname === `db.${projectRef}.supabase.co`
  const poolerBindingMatches =
    hostname.endsWith('.pooler.supabase.com') &&
    (username === projectRef || username.endsWith(`.${projectRef}`))
  if (!directHostMatches && !poolerBindingMatches) {
    throw new Error('golden-wallet database URL literal is not bound to Ranking Arena production')
  }
  if (
    (directHostMatches && parsed.port !== '5432') ||
    (poolerBindingMatches && !['5432', '6543'].includes(parsed.port))
  ) {
    throw new Error('golden-wallet database URL uses an unsupported production port')
  }
}

export function buildDexGoldenPinnedQueryParameters(
  fixtureInput: unknown
): DexGoldenPinnedQueryParameters {
  const fixture = parseDexGoldenWalletSnapshot(fixtureInput)
  return {
    sourceSlugs: DEX_GOLDEN_SOURCES.map((source) => source),
    snapshotIds: DEX_GOLDEN_SOURCES.map(
      (source) =>
        fixture.populations.find((population) => population.source_slug === source)!.snapshot_id
    ),
  }
}

export function dexGoldenPinnedCandidateQuerySha256(): string {
  return contractHash('arena.dex.golden-wallet-pinned-query', DEX_GOLDEN_PINNED_QUERY_CONTRACT, {
    sql: DEX_GOLDEN_PINNED_CANDIDATE_QUERY,
  })
}

export function verifyDexGoldenPinnedSnapshotRebuild(input: {
  fixture: unknown
  rows: readonly DexGoldenWalletQueryRow[]
  verifierGitSha: string
  verifierWorktreeClean: boolean
  databaseUrl: string
}): DexGoldenPinnedRebuildReport {
  if (!/^[0-9a-f]{40}$/.test(input.verifierGitSha)) {
    throw new Error('pinned snapshot verifier Git SHA must be a full lowercase SHA')
  }
  if (!input.verifierWorktreeClean) {
    throw new Error('pinned snapshot rebuild requires a clean Git worktree')
  }
  assertDexGoldenProductionDatabaseUrlLiteral(input.databaseUrl)
  const fixture = parseDexGoldenWalletSnapshot(input.fixture)
  const candidates = buildDexGoldenWalletCandidates(input.rows)
  const rebuilt = buildDexGoldenWalletSnapshot({
    candidates,
    generatedAt: fixture.generated_at,
    generatorGitSha: fixture.generator_git_sha,
    sampleSeed: fixture.sample_seed,
  })
  const expectedSnapshotSha256 = dexGoldenWalletSnapshotSha256(fixture)
  if (rebuilt.sha256 !== expectedSnapshotSha256) {
    throw new Error(
      `pinned golden-wallet snapshot rebuild mismatch: expected ${expectedSnapshotSha256}, rebuilt ${rebuilt.sha256}`
    )
  }

  const eligibleCandidateCounts = Object.fromEntries(
    DEX_GOLDEN_SOURCES.map((source) => [
      source,
      candidates.filter((candidate) => candidate.sourceSlug === source).length,
    ])
  ) as Record<DexGoldenSource, number>

  return {
    schema_version: DEX_GOLDEN_PINNED_REBUILD_SCHEMA_VERSION,
    data_contract: DEX_GOLDEN_PINNED_REBUILD_CONTRACT,
    result: 'selected_fixture_rebuilt',
    verification_scope: 'normalized_leaderboard_snapshot_rows_only',
    selected_fixture_sha256_verified: true,
    provider_refetch_performed: false,
    provider_body_persistence_authorized: false,
    population_denominator_authorized: false,
    serving_authorized: false,
    rank_eligible: false,
    score_eligible: false,
    verifier_git_sha: input.verifierGitSha,
    verifier_worktree_clean: true,
    database_url_binding: 'literal_authority_bound_to_ranking_arena_project_ref',
    tls_transport_encrypted: true,
    tls_server_identity_verified: false,
    production_database_identity_verified: false,
    fixture_generator_git_sha: fixture.generator_git_sha,
    fixture_generated_at: fixture.generated_at,
    source_snapshot_pins: fixture.populations.map((population) => ({
      source_slug: population.source_slug,
      snapshot_id: population.snapshot_id,
      snapshot_scraped_at: population.snapshot_scraped_at,
      snapshot_actual_count: population.snapshot_actual_count,
    })),
    candidate_query_binding: 'verifier_code_only_not_parent_fixture',
    candidate_query_sha256: dexGoldenPinnedCandidateQuerySha256(),
    queried_row_set_commitment_state: 'observed_unpinned',
    observed_query_row_set_sha256: contractHash(
      'arena.dex.golden-wallet-query-row-set',
      DEX_GOLDEN_QUERY_ROW_SET_CONTRACT,
      { rows: canonicalQueryRows(input.rows) }
    ),
    queried_row_count: input.rows.length,
    eligible_candidate_set_commitment_state: 'observed_unpinned',
    observed_eligible_candidate_set_sha256: contractHash(
      'arena.dex.golden-wallet-candidate-set',
      DEX_GOLDEN_CANDIDATE_SET_CONTRACT,
      { candidate_timeframe_days: 90, candidates: canonicalCandidates(candidates) }
    ),
    eligible_candidate_count: candidates.length,
    eligible_candidate_counts: eligibleCandidateCounts,
    expected_snapshot_sha256: expectedSnapshotSha256,
    rebuilt_snapshot_sha256: rebuilt.sha256,
  }
}
