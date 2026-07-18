import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { hasBase58DecodedByteLength } from '../../lib/utils/base58'
import {
  DEX_BSC_PROTOCOL_MANIFEST_CONTRACT,
  dexBscProtocolManifestSha256,
  normalizeDexBscProtocolManifest,
  type DexBscProtocol,
  type DexBscProtocolArtifact,
} from './dex-bsc-protocol-manifest'
import { dexContractSha256 } from './dex-contract-hash'
import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  dexGoldenRpcEvidenceSha256,
  parseDexGoldenRpcEvidence,
} from './dex-golden-rpc-evidence'
import {
  DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
} from './dex-golden-transaction-facts'
import {
  DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT,
  dexSolanaProtocolManifestSha256,
  normalizeDexSolanaProtocolManifest,
  type DexSolanaProtocol,
  type DexSolanaProtocolArtifact,
} from './dex-solana-protocol-manifest'

export const DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION = 3 as const
export const DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT =
  'arena.dex.protocol-decoder-golden-binding@3' as const

export const DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS = [
  'commercial_decoder_clearance_unverified',
  'decoder_expected_facts_unbound',
  'decoder_version_unbound',
  'golden_case_classification_unverified',
  'golden_rpc_evidence_not_replayed',
  'protocol_deployment_or_code_epoch_unverified',
  'protocol_invocation_unverified',
  'raw_blob_persistence_not_authorized',
] as const

export const DEX_BSC_GOLDEN_SCENARIO_TAGS = [
  'bridge',
  'buy',
  'failed_transaction',
  'fee',
  'fee_on_transfer_token',
  'internal_refund',
  'migration',
  'multi_hop',
  'native_bnb_wbnb',
  'protocol_upgrade_boundary',
  'sell',
] as const

export const DEX_SOLANA_GOLDEN_SCENARIO_TAGS = [
  'address_lookup_table',
  'buy',
  'direct_venue',
  'failed_transaction',
  'fee',
  'inner_cpi',
  'jupiter_route',
  'legacy_transaction',
  'missing_block_time',
  'multi_hop',
  'program_upgrade_boundary',
  'sell',
  'sol_wsol',
  'token_2022',
  'versioned_transaction',
] as const

const SHA256 = /^[0-9a-f]{64}$/
const LOGICAL_ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/
const BSC_TRANSACTION_HASH = /^0x[0-9a-f]{64}$/

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

const logicalIdSchema = z.string().regex(LOGICAL_ID)
const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')
const timestampSchema = z.string().refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')

const protocolManifestBaseSchema = z
  .object({
    canonical_sha256: sha256Schema,
    protocol_id: logicalIdSchema,
    protocol_snapshot_sha256: sha256Schema,
    source_protocol_blockers: z.array(logicalIdSchema).min(1),
  })
  .strict()

const goldenRpcEvidenceBaseSchema = z
  .object({
    data_contract: z.literal(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT),
    canonical_sha256: sha256Schema,
    verification_state: z.literal('declared_not_replayed'),
    transaction_id: z.string().min(1).max(128),
    stable_transaction_facts_sha256: sha256Schema,
    source_evidence_blockers: z.array(logicalIdSchema).min(1),
  })
  .strict()

const decoderBindingSchema = z
  .object({
    state: z.literal('unbound'),
    manifest_decoder_snapshot_sha256: sha256Schema,
    owner: z.null(),
    implementation_state: z.literal('not_started'),
    version: z.null(),
    implementation_sha256: z.null(),
    golden_transactions_verified: z.literal(false),
    expected_decoder_facts_sha256: z.null(),
  })
  .strict()

const claimsSchema = z
  .object({
    protocol_deployment_or_code_epoch_verified: z.literal(false),
    protocol_invocation_verified: z.literal(false),
    decoder_implementation_verified: z.literal(false),
    golden_case_classification_verified: z.literal(false),
    decoder_facts_verified: z.literal(false),
    legal_clearance_verified: z.literal(false),
  })
  .strict()

const authorizationSchema = z
  .object({
    network_execution: z.literal(false),
    artifact_persistence: z.literal(false),
    raw_blob_persistence: z.literal(false),
    decoder_execution: z.literal(false),
    decoder_fixture: z.literal(false),
    serving: z.literal(false),
    rank: z.literal(false),
    score: z.literal(false),
  })
  .strict()

const commonFields = {
  schema_version: z.literal(DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION),
  data_contract: z.literal(DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT),
  purpose: z.literal('phase0_protocol_decoder_golden_binding_draft_only'),
  proof_boundary: z.literal(
    'cross_document_hash_and_seed_projection_only_not_chain_code_protocol_invocation_decoder_or_legal_proof'
  ),
  verification_state: z.literal('draft'),
  generated_at: timestampSchema,
  decoder_binding: decoderBindingSchema,
  required_blockers: z.array(logicalIdSchema).min(1),
  claims: claimsSchema,
  authorization: authorizationSchema,
} as const

function goldenCaseSchema<T extends readonly [string, ...string[]]>(tags: T) {
  return z
    .object({
      case_id: logicalIdSchema,
      scenario_tags: z.array(z.enum(tags)).min(1),
      expected_execution: z.enum(['succeeded', 'failed']),
      selection_state: z.literal('selected_rpc_evidence_unverified'),
      expected_decoder_facts_sha256: z.null(),
    })
    .strict()
}

const bscBindingSchema = z
  .object({
    ...commonFields,
    chain: z
      .object({
        namespace: z.literal('eip155'),
        reference: z.literal('56'),
        chain_id: z.literal(56),
        product_source_slug: z.literal('binance_web3_bsc'),
        chain_stream_slug: z.literal('bsc_mainnet'),
      })
      .strict(),
    protocol_manifest: protocolManifestBaseSchema.extend({
      data_contract: z.literal(DEX_BSC_PROTOCOL_MANIFEST_CONTRACT),
    }),
    deployment_binding: z
      .object({
        kind: z.literal('bsc_manifest_epoch_candidate'),
        epoch_id: logicalIdSchema,
        epoch_snapshot_sha256: sha256Schema,
        activation_state: z.literal('unverified'),
        start_block: z.null(),
        end_block: z.null(),
        contract_ids: z.array(logicalIdSchema).min(1),
        creation_transaction_binding_sha256: z.null(),
        runtime_code_binding_sha256: z.null(),
        transaction_within_epoch_verified: z.literal(false),
      })
      .strict(),
    golden_rpc_evidence: goldenRpcEvidenceBaseSchema.extend({
      transaction_id: z.string().regex(BSC_TRANSACTION_HASH),
      stable_transaction_facts_contract: z.literal(DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT),
    }),
    golden_case: goldenCaseSchema(DEX_BSC_GOLDEN_SCENARIO_TAGS),
    legal_binding: z
      .object({
        state: z.literal('reference_only_not_cleared'),
        artifact_ids: z.array(logicalIdSchema).min(1),
        artifact_snapshot_sha256: sha256Schema,
        review_requirement: z.literal('not_modeled_by_bsc_manifest_v1'),
        review_artifact_ids: z.array(z.never()).length(0),
        commercial_reuse_authorized: z.literal(false),
        legal_decision_sha256: z.null(),
      })
      .strict(),
  })
  .strict()

const solanaBindingSchema = z
  .object({
    ...commonFields,
    chain: z
      .object({
        namespace: z.literal('solana'),
        cluster: z.literal('mainnet-beta'),
        product_source_slug: z.literal('okx_web3_solana'),
        chain_stream_slug: z.literal('solana_mainnet'),
      })
      .strict(),
    protocol_manifest: protocolManifestBaseSchema.extend({
      data_contract: z.literal(DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT),
    }),
    deployment_binding: z
      .object({
        kind: z.literal('solana_code_epoch_unavailable'),
        program_id: z
          .string()
          .refine(
            (value) => hasBase58DecodedByteLength(value, 32),
            'Solana program ID must be a base58-encoded 32-byte public key'
          ),
        loader_evidence_state: z.literal('not_verified'),
        code_epoch_id: z.null(),
        effective_slot: z.null(),
        code_sha256: z.null(),
        transaction_within_epoch_verified: z.literal(false),
      })
      .strict(),
    golden_rpc_evidence: goldenRpcEvidenceBaseSchema.extend({
      transaction_id: z
        .string()
        .refine(
          (value) => hasBase58DecodedByteLength(value, 64),
          'Solana transaction ID must be a base58-encoded 64-byte signature'
        ),
      stable_transaction_facts_contract: z.literal(DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT),
    }),
    golden_case: goldenCaseSchema(DEX_SOLANA_GOLDEN_SCENARIO_TAGS),
    legal_binding: z
      .object({
        state: z.literal('reference_only_not_cleared'),
        artifact_ids: z.array(logicalIdSchema).min(1),
        artifact_snapshot_sha256: sha256Schema,
        review_requirement: z.enum(['required_by_manifest', 'not_required_by_seed_policy']),
        review_artifact_ids: z.array(logicalIdSchema),
        commercial_reuse_authorized: z.literal(false),
        legal_decision_sha256: z.null(),
      })
      .strict(),
  })
  .strict()

const bindingSchema = z.union([bscBindingSchema, solanaBindingSchema])

type DexBscGoldenProtocolBinding = z.infer<typeof bscBindingSchema>
export type DexGoldenProtocolBinding = z.infer<typeof bindingSchema>
export type DexBscGoldenScenarioTag = (typeof DEX_BSC_GOLDEN_SCENARIO_TAGS)[number]
export type DexSolanaGoldenScenarioTag = (typeof DEX_SOLANA_GOLDEN_SCENARIO_TAGS)[number]

export type DexGoldenProtocolBindingSelection =
  | Readonly<{
      chain: 'bsc'
      protocol_id: string
      epoch_id: string
    }>
  | Readonly<{
      chain: 'solana'
      protocol_id: string
    }>

export type DexGoldenProtocolBindingCase =
  | Readonly<{
      chain: 'bsc'
      case_id: string
      scenario_tags: readonly DexBscGoldenScenarioTag[]
      expected_execution: 'succeeded' | 'failed'
    }>
  | Readonly<{
      chain: 'solana'
      case_id: string
      scenario_tags: readonly DexSolanaGoldenScenarioTag[]
      expected_execution: 'succeeded' | 'failed'
    }>

export interface DexGoldenProtocolBindingBuildInput {
  generated_at: string
  manifest_input: unknown
  golden_rpc_evidence_input: unknown
  selection: DexGoldenProtocolBindingSelection
  golden_case: DexGoldenProtocolBindingCase
}

export interface DexGoldenProtocolBindingVerifyInput {
  binding_input: unknown
  manifest_input: unknown
  golden_rpc_evidence_input: unknown
}

function assertCanonicalStrings(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareText(values[index - 1], values[index]) >= 0) {
      throw new Error(`${label} must be unique and canonically sorted`)
    }
  }
}

function assertExactRequiredBlockers(values: readonly string[]): void {
  if (
    values.length !== DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS.length ||
    values.some((value, index) => value !== DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS[index])
  ) {
    throw new Error('golden protocol binding must preserve every canonical required blocker')
  }
}

function assertGoldenCase(
  goldenCase: DexGoldenProtocolBinding['golden_case'],
  chain: 'bsc' | 'solana'
): void {
  assertCanonicalStrings(goldenCase.scenario_tags, 'golden scenario tags')
  const failed = goldenCase.scenario_tags.includes('failed_transaction')
  if (failed !== (goldenCase.expected_execution === 'failed')) {
    throw new Error('failed golden cases must declare failed_transaction consistently')
  }
  const allowed = new Set<string>(
    chain === 'bsc' ? DEX_BSC_GOLDEN_SCENARIO_TAGS : DEX_SOLANA_GOLDEN_SCENARIO_TAGS
  )
  if (goldenCase.scenario_tags.some((tag) => !allowed.has(tag))) {
    throw new Error('golden scenario tag belongs to a different chain')
  }
}

function isBscBinding(binding: DexGoldenProtocolBinding): binding is DexBscGoldenProtocolBinding {
  return binding.chain.namespace === 'eip155'
}

function assertBindingInvariants(binding: DexGoldenProtocolBinding): void {
  assertExactRequiredBlockers(binding.required_blockers)
  assertCanonicalStrings(
    binding.protocol_manifest.source_protocol_blockers,
    'source protocol blockers'
  )
  assertCanonicalStrings(
    binding.golden_rpc_evidence.source_evidence_blockers,
    'source evidence blockers'
  )
  assertCanonicalStrings(binding.legal_binding.artifact_ids, 'legal artifact IDs')
  assertGoldenCase(binding.golden_case, binding.chain.namespace === 'eip155' ? 'bsc' : 'solana')

  if (isBscBinding(binding)) {
    assertCanonicalStrings(binding.deployment_binding.contract_ids, 'BSC epoch contract IDs')
  } else {
    assertCanonicalStrings(binding.legal_binding.review_artifact_ids, 'legal review artifact IDs')
    const artifactIds = new Set(binding.legal_binding.artifact_ids)
    if (binding.legal_binding.review_artifact_ids.some((id) => !artifactIds.has(id))) {
      throw new Error('legal review artifacts must belong to the selected protocol closure')
    }
    if (
      binding.legal_binding.review_artifact_ids.length > 0 !==
      (binding.legal_binding.review_requirement === 'required_by_manifest')
    ) {
      throw new Error('legal review requirement conflicts with selected artifact policy')
    }
  }
}

export function parseDexGoldenProtocolBinding(input: unknown): DexGoldenProtocolBinding {
  const binding = bindingSchema.parse(input)
  assertBindingInvariants(binding)
  return binding
}

export function parseDexGoldenProtocolBindingJson(text: string): DexGoldenProtocolBinding {
  return parseDexGoldenProtocolBinding(parseStrictJson(text))
}

function snapshotSha256(kind: string, value: unknown): string {
  return dexContractSha256(
    {
      domain: `arena.dex.protocol-decoder-golden-binding.${kind}`,
      schema_id: DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT,
      schema_version: DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION,
    },
    value
  )
}

function artifactSnapshotSha256(
  artifacts: readonly (DexBscProtocolArtifact | DexSolanaProtocolArtifact)[]
): string {
  return snapshotSha256('reference-artifact-closure', artifacts)
}

function bscArtifactIds(protocol: DexBscProtocol, epochId: string): string[] {
  const epoch = protocol.epochs.find((candidate) => candidate.epoch_id === epochId)
  if (epoch === undefined) {
    throw new Error(`BSC protocol epoch does not exist: ${protocol.protocol_id}:${epochId}`)
  }
  const artifactIds = new Set<string>()
  for (const contract of epoch.contracts) {
    artifactIds.add(contract.address_artifact_id)
    for (const artifactId of contract.interface_artifact_ids) artifactIds.add(artifactId)
  }
  if (epoch.event_surface.kind === 'factory_created_contracts') {
    artifactIds.add(epoch.event_surface.child_event_interface_artifact_id)
  }
  return [...artifactIds].sort(compareText)
}

function selectedArtifacts<T extends { artifact_id: string }>(
  artifacts: readonly T[],
  artifactIds: readonly string[]
): T[] {
  const wanted = new Set(artifactIds)
  const selected = artifacts
    .filter((artifact) => wanted.has(artifact.artifact_id))
    .sort((left, right) => compareText(left.artifact_id, right.artifact_id))
  if (selected.length !== artifactIds.length) {
    throw new Error('selected protocol artifact closure references a missing artifact')
  }
  return selected
}

function assertGeneratedAfterSources(
  generatedAt: string,
  manifestEvidenceAsOf: string,
  rpcEvidenceGeneratedAt: string
): void {
  if (!isCanonicalTimestamp(generatedAt)) {
    throw new Error('golden protocol binding generated_at must be canonical ISO')
  }
  if (
    Date.parse(generatedAt) < Date.parse(manifestEvidenceAsOf) ||
    Date.parse(generatedAt) < Date.parse(rpcEvidenceGeneratedAt)
  ) {
    throw new Error('golden protocol binding cannot predate either bound source document')
  }
}

function commonBinding(
  generatedAt: string,
  protocol: DexBscProtocol | DexSolanaProtocol,
  evidence: ReturnType<typeof parseDexGoldenRpcEvidence>,
  goldenCase: DexGoldenProtocolBindingCase
) {
  return {
    schema_version: DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION,
    data_contract: DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT,
    purpose: 'phase0_protocol_decoder_golden_binding_draft_only' as const,
    proof_boundary:
      'cross_document_hash_and_seed_projection_only_not_chain_code_protocol_invocation_decoder_or_legal_proof' as const,
    verification_state: 'draft' as const,
    generated_at: generatedAt,
    decoder_binding: {
      state: 'unbound' as const,
      manifest_decoder_snapshot_sha256: snapshotSha256('manifest-decoder', protocol.decoder),
      owner: null,
      implementation_state: 'not_started' as const,
      version: null,
      implementation_sha256: null,
      golden_transactions_verified: false as const,
      expected_decoder_facts_sha256: null,
    },
    golden_case: {
      case_id: goldenCase.case_id,
      scenario_tags: [...goldenCase.scenario_tags].sort(compareText),
      expected_execution: goldenCase.expected_execution,
      selection_state: 'selected_rpc_evidence_unverified' as const,
      expected_decoder_facts_sha256: null,
    },
    required_blockers: [...DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS],
    claims: {
      protocol_deployment_or_code_epoch_verified: false as const,
      protocol_invocation_verified: false as const,
      decoder_implementation_verified: false as const,
      golden_case_classification_verified: false as const,
      decoder_facts_verified: false as const,
      legal_clearance_verified: false as const,
    },
    authorization: {
      network_execution: false as const,
      artifact_persistence: false as const,
      raw_blob_persistence: false as const,
      decoder_execution: false as const,
      decoder_fixture: false as const,
      serving: false as const,
      rank: false as const,
      score: false as const,
    },
    golden_rpc_evidence: {
      data_contract: evidence.data_contract,
      canonical_sha256: dexGoldenRpcEvidenceSha256(evidence),
      verification_state: evidence.verification_state,
      transaction_id: evidence.transaction_id,
      stable_transaction_facts_contract: evidence.stable_transaction_facts_contract,
      stable_transaction_facts_sha256: evidence.stable_transaction_facts_sha256,
      source_evidence_blockers: [...evidence.required_blockers].sort(compareText),
    },
  }
}

export function buildDexGoldenProtocolBinding(
  input: DexGoldenProtocolBindingBuildInput
): DexGoldenProtocolBinding {
  const selection = input.selection
  if (selection.chain !== input.golden_case.chain) {
    throw new Error('golden case chain conflicts with protocol selection')
  }
  const evidence = parseDexGoldenRpcEvidence(input.golden_rpc_evidence_input)

  if (selection.chain === 'bsc') {
    const epochId = selection.epoch_id
    if (evidence.chain.namespace !== 'eip155') {
      throw new Error('BSC protocol selection requires BSC golden RPC evidence')
    }
    const manifest = normalizeDexBscProtocolManifest(input.manifest_input)
    assertGeneratedAfterSources(input.generated_at, manifest.evidence_as_of, evidence.generated_at)
    if (
      manifest.chain.chain_id !== evidence.chain.chain_id ||
      manifest.chain.source_slug !== evidence.chain.product_source_slug
    ) {
      throw new Error('BSC protocol manifest chain conflicts with golden RPC evidence')
    }
    const protocol = manifest.protocols.find(
      (candidate) => candidate.protocol_id === selection.protocol_id
    )
    if (protocol === undefined) {
      throw new Error(`BSC protocol does not exist: ${selection.protocol_id}`)
    }
    const epoch = protocol.epochs.find((candidate) => candidate.epoch_id === epochId)
    if (epoch === undefined) {
      throw new Error(`BSC protocol epoch does not exist: ${protocol.protocol_id}:${epochId}`)
    }
    const artifactIds = bscArtifactIds(protocol, epoch.epoch_id)
    const artifacts = selectedArtifacts(manifest.artifacts, artifactIds)
    return parseDexGoldenProtocolBinding({
      ...commonBinding(input.generated_at, protocol, evidence, input.golden_case),
      chain: {
        namespace: 'eip155',
        reference: '56',
        chain_id: 56,
        product_source_slug: evidence.chain.product_source_slug,
        chain_stream_slug: evidence.chain.chain_stream_slug,
      },
      protocol_manifest: {
        data_contract: manifest.data_contract,
        canonical_sha256: dexBscProtocolManifestSha256(manifest),
        protocol_id: protocol.protocol_id,
        protocol_snapshot_sha256: snapshotSha256('manifest-protocol', protocol),
        source_protocol_blockers: [...protocol.blocking_reasons].sort(compareText),
      },
      deployment_binding: {
        kind: 'bsc_manifest_epoch_candidate',
        epoch_id: epoch.epoch_id,
        epoch_snapshot_sha256: snapshotSha256('bsc-manifest-epoch', epoch),
        activation_state: epoch.activation_state,
        start_block: epoch.start_block,
        end_block: epoch.end_block,
        contract_ids: epoch.contracts.map((contract) => contract.contract_id).sort(compareText),
        creation_transaction_binding_sha256: null,
        runtime_code_binding_sha256: null,
        transaction_within_epoch_verified: false,
      },
      legal_binding: {
        state: 'reference_only_not_cleared',
        artifact_ids: artifactIds,
        artifact_snapshot_sha256: artifactSnapshotSha256(artifacts),
        review_requirement: 'not_modeled_by_bsc_manifest_v1',
        review_artifact_ids: [],
        commercial_reuse_authorized: false,
        legal_decision_sha256: null,
      },
    })
  }

  if (evidence.chain.namespace !== 'solana') {
    throw new Error('Solana protocol selection requires Solana golden RPC evidence')
  }
  const manifest = normalizeDexSolanaProtocolManifest(input.manifest_input)
  assertGeneratedAfterSources(input.generated_at, manifest.evidence_as_of, evidence.generated_at)
  if (manifest.chain.source_slug !== evidence.chain.chain_stream_slug) {
    throw new Error('Solana protocol manifest chain conflicts with golden RPC evidence')
  }
  const protocol = manifest.protocols.find(
    (candidate) => candidate.protocol_id === selection.protocol_id
  )
  if (protocol === undefined) {
    throw new Error(`Solana protocol does not exist: ${selection.protocol_id}`)
  }
  if (protocol.loader_evidence.state !== 'not_verified' || protocol.code_epochs.length !== 0) {
    throw new Error('draft binding requires an unverified Solana loader and no code epochs')
  }
  const artifactIds = [
    ...new Set([...protocol.reference_artifact_ids, protocol.program_address_artifact_id]),
  ].sort(compareText)
  const artifacts = selectedArtifacts(manifest.artifacts, artifactIds)
  const reviewArtifactIds = artifacts
    .filter((artifact) => artifact.legal_review_required)
    .map((artifact) => artifact.artifact_id)
    .sort(compareText)

  return parseDexGoldenProtocolBinding({
    ...commonBinding(input.generated_at, protocol, evidence, input.golden_case),
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      product_source_slug: evidence.chain.product_source_slug,
      chain_stream_slug: evidence.chain.chain_stream_slug,
    },
    protocol_manifest: {
      data_contract: manifest.data_contract,
      canonical_sha256: dexSolanaProtocolManifestSha256(manifest),
      protocol_id: protocol.protocol_id,
      protocol_snapshot_sha256: snapshotSha256('manifest-protocol', protocol),
      source_protocol_blockers: [...protocol.blocking_reasons].sort(compareText),
    },
    deployment_binding: {
      kind: 'solana_code_epoch_unavailable',
      program_id: protocol.program_id,
      loader_evidence_state: protocol.loader_evidence.state,
      code_epoch_id: null,
      effective_slot: null,
      code_sha256: null,
      transaction_within_epoch_verified: false,
    },
    legal_binding: {
      state: 'reference_only_not_cleared',
      artifact_ids: artifactIds,
      artifact_snapshot_sha256: artifactSnapshotSha256(artifacts),
      review_requirement:
        reviewArtifactIds.length > 0 ? 'required_by_manifest' : 'not_required_by_seed_policy',
      review_artifact_ids: reviewArtifactIds,
      commercial_reuse_authorized: false,
      legal_decision_sha256: null,
    },
  })
}

/**
 * Rebuild a binding from both source documents and require exact equality.
 * A successful return proves only cross-document consistency. Every claim and
 * authorization in the returned draft remains false.
 */
export function verifyDexGoldenProtocolBinding(
  input: DexGoldenProtocolBindingVerifyInput
): DexGoldenProtocolBinding {
  const binding = parseDexGoldenProtocolBinding(input.binding_input)
  let selection: DexGoldenProtocolBindingSelection
  let goldenCase: DexGoldenProtocolBindingCase
  if (isBscBinding(binding)) {
    selection = {
      chain: 'bsc',
      protocol_id: binding.protocol_manifest.protocol_id,
      epoch_id: binding.deployment_binding.epoch_id,
    }
    goldenCase = {
      chain: 'bsc',
      case_id: binding.golden_case.case_id,
      scenario_tags: binding.golden_case.scenario_tags,
      expected_execution: binding.golden_case.expected_execution,
    }
  } else {
    selection = {
      chain: 'solana',
      protocol_id: binding.protocol_manifest.protocol_id,
    }
    goldenCase = {
      chain: 'solana',
      case_id: binding.golden_case.case_id,
      scenario_tags: binding.golden_case.scenario_tags,
      expected_execution: binding.golden_case.expected_execution,
    }
  }
  const rebuilt = buildDexGoldenProtocolBinding({
    generated_at: binding.generated_at,
    manifest_input: input.manifest_input,
    golden_rpc_evidence_input: input.golden_rpc_evidence_input,
    selection,
    golden_case: goldenCase,
  })
  if (!isDeepStrictEqual(binding, rebuilt)) {
    throw new Error('golden protocol binding conflicts with its source documents')
  }
  return binding
}

export function dexGoldenProtocolBindingSha256(input: unknown): string {
  const binding = parseDexGoldenProtocolBinding(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.protocol-decoder-golden-binding',
      schema_id: DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT,
      schema_version: DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION,
    },
    binding
  )
}
