import { z } from 'zod'

import { dexContractSha256 } from './dex-contract-hash'
import { DEX_GOLDEN_SOURCES } from './dex-golden-wallet-query'
import {
  cloneStrictDexJsonInput,
  dexGoldenWalletSnapshotSha256,
  parseDexGoldenWalletSnapshot,
  type DexGoldenSource,
} from './dex-golden-wallets'

export const DEX_GOLDEN_SOURCE_PROVENANCE_SCHEMA_VERSION = 1 as const
export const DEX_GOLDEN_SOURCE_PROVENANCE_CONTRACT =
  'arena.dex.golden-wallet-source-provenance@1' as const
export const DEX_GOLDEN_SOURCE_PROVENANCE_V1_SHA256 =
  '34d7a1b696b6ef686cbfa0dd342bd76ded0275f6052f9fc062cedebc9c4eee5a' as const

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/)
const positiveSafeIntegerSchema = z.number().int().safe().positive()
const sourceSchema = z.enum(DEX_GOLDEN_SOURCES as [DexGoldenSource, ...DexGoldenSource[]])
const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}, 'must be a canonical ISO timestamp')

const sourcePinSchema = z
  .object({
    source_slug: sourceSchema,
    snapshot_id: z.string().regex(/^[1-9]\d*$/),
    snapshot_scraped_at: canonicalTimestampSchema,
    snapshot_actual_count: positiveSafeIntegerSchema,
  })
  .strict()

const provenanceSchema = z
  .object({
    schema_version: z.literal(DEX_GOLDEN_SOURCE_PROVENANCE_SCHEMA_VERSION),
    data_contract: z.literal(DEX_GOLDEN_SOURCE_PROVENANCE_CONTRACT),
    purpose: z.literal('phase0_selected_fixture_generator_baseline_only'),
    baseline_recorded_at: canonicalTimestampSchema,
    parent_snapshot_sha256: sha256Schema,
    observation: z
      .object({
        recorded_verifier_git_sha: gitShaSchema,
        recorded_verifier_worktree_clean: z.literal(true),
        database_url_binding: z.literal('literal_authority_bound_to_ranking_arena_project_ref'),
        tls_transport_encrypted: z.literal(true),
        tls_server_identity_verified: z.literal(false),
        production_database_identity_verified: z.literal(false),
      })
      .strict(),
    source_snapshot_pins: z.array(sourcePinSchema).length(DEX_GOLDEN_SOURCES.length),
    candidate_query: z
      .object({
        commitment_state: z.literal('pinned_in_source_provenance'),
        sha256: sha256Schema,
      })
      .strict(),
    query_row_set: z
      .object({
        commitment_state: z.literal('pinned_observation_baseline'),
        sha256: sha256Schema,
        row_count: positiveSafeIntegerSchema,
      })
      .strict(),
    eligible_candidate_set: z
      .object({
        commitment_state: z.literal('pinned_observation_baseline'),
        sha256: sha256Schema,
        candidate_count: positiveSafeIntegerSchema,
        candidate_counts: z
          .object({
            binance_web3_bsc: positiveSafeIntegerSchema,
            okx_web3_solana: positiveSafeIntegerSchema,
          })
          .strict(),
      })
      .strict(),
    raw_boundary: z
      .object({
        provider_refetch_performed: z.literal(false),
        provider_body_included: z.literal(false),
        raw_object_locator_included: z.literal(false),
        raw_content_commitment_included: z.literal(false),
      })
      .strict(),
    claims: z
      .object({
        population_denominator_authorized: z.literal(false),
        serving_authorized: z.literal(false),
        rank_eligible: z.literal(false),
        score_eligible: z.literal(false),
      })
      .strict(),
  })
  .strict()

export type DexGoldenWalletSourceProvenance = z.infer<typeof provenanceSchema>

function assertSourcePins(
  provenance: DexGoldenWalletSourceProvenance,
  parent: ReturnType<typeof parseDexGoldenWalletSnapshot>
): void {
  for (const [index, source] of DEX_GOLDEN_SOURCES.entries()) {
    const pin = provenance.source_snapshot_pins[index]
    const population = parent.populations.find((item) => item.source_slug === source)!
    if (
      pin.source_slug !== source ||
      pin.snapshot_id !== population.snapshot_id ||
      pin.snapshot_scraped_at !== population.snapshot_scraped_at ||
      pin.snapshot_actual_count !== population.snapshot_actual_count
    ) {
      throw new Error(`${source} source provenance pin conflicts with the parent snapshot`)
    }
  }
}

function assertPopulationCounts(
  provenance: DexGoldenWalletSourceProvenance,
  parent: ReturnType<typeof parseDexGoldenWalletSnapshot>
): void {
  const expectedRows = parent.populations.reduce(
    (sum, population) => sum + population.snapshot_actual_count,
    0
  )
  if (provenance.query_row_set.row_count !== expectedRows) {
    throw new Error('source provenance query row count conflicts with snapshot actual counts')
  }

  let expectedCandidates = 0
  for (const source of DEX_GOLDEN_SOURCES) {
    const population = parent.populations.find((item) => item.source_slug === source)!
    const actual = provenance.eligible_candidate_set.candidate_counts[source]
    if (actual !== population.eligible_candidates_with_non_null_pnl) {
      throw new Error(`${source} candidate count conflicts with the parent population`)
    }
    expectedCandidates += actual
  }
  if (provenance.eligible_candidate_set.candidate_count !== expectedCandidates) {
    throw new Error('source provenance candidate total conflicts with its per-source counts')
  }
  if (expectedCandidates > provenance.query_row_set.row_count) {
    throw new Error('source provenance eligible candidates exceed queried rows')
  }
}

export function parseDexGoldenWalletSourceProvenance(
  input: unknown,
  parentSnapshotInput: unknown
): DexGoldenWalletSourceProvenance {
  const safeInput = cloneStrictDexJsonInput(input)
  const provenance = provenanceSchema.parse(safeInput)
  const parent = parseDexGoldenWalletSnapshot(parentSnapshotInput)
  if (provenance.parent_snapshot_sha256 !== dexGoldenWalletSnapshotSha256(parent)) {
    throw new Error('source provenance parent snapshot SHA does not match the supplied fixture')
  }
  if (Date.parse(provenance.baseline_recorded_at) < Date.parse(parent.generated_at)) {
    throw new Error('source provenance baseline predates the parent fixture')
  }
  assertSourcePins(provenance, parent)
  assertPopulationCounts(provenance, parent)
  return provenance
}

export function dexGoldenWalletSourceProvenanceSha256(
  input: unknown,
  parentSnapshotInput: unknown
): string {
  const provenance = parseDexGoldenWalletSourceProvenance(input, parentSnapshotInput)
  return sourceProvenanceSha256(provenance)
}

function sourceProvenanceSha256(provenance: DexGoldenWalletSourceProvenance): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.golden-wallet-source-provenance',
      schema_id: DEX_GOLDEN_SOURCE_PROVENANCE_CONTRACT,
      schema_version: DEX_GOLDEN_SOURCE_PROVENANCE_SCHEMA_VERSION,
    },
    provenance
  )
}

/** Verify the one canonical Phase 0 baseline, not merely a structurally valid provenance record. */
export function verifyCanonicalDexGoldenWalletSourceProvenance(
  input: unknown,
  parentSnapshotInput: unknown
): DexGoldenWalletSourceProvenance {
  const provenance = parseDexGoldenWalletSourceProvenance(input, parentSnapshotInput)
  if (sourceProvenanceSha256(provenance) !== DEX_GOLDEN_SOURCE_PROVENANCE_V1_SHA256) {
    throw new Error('canonical source provenance SHA does not match the Phase 0 baseline')
  }
  return provenance
}
