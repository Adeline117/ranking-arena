import { createHash } from 'node:crypto'
import { z } from 'zod'

export const DEX_BSC_PROTOCOL_MANIFEST_SCHEMA_VERSION = 1 as const
export const DEX_BSC_PROTOCOL_MANIFEST_CONTRACT = 'arena.dex.bsc-protocol-manifest@1' as const

export const DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS = [
  'artifact_integrity_unverified',
  'chain_code_unverified',
  'creation_transaction_unverified',
  'decoder_owner_unassigned',
  'deployment_start_block_unverified',
  'finality_policy_unverified',
  'golden_transactions_unverified',
  'live_sample_event_share_unmeasured',
  'registry_replay_unverified',
  'runtime_source_build_unbound',
  'trace_internal_attribution_unverified',
  'upgrade_epochs_unverified',
] as const

export const DEX_BSC_REQUIRED_KNOWN_GAPS = [
  'meme_router_families_not_profiled',
  'non_pancakeswap_protocols_not_profiled',
  'pancakeswap_classic_stableswap_not_seeded',
  'pancakeswap_x_not_seeded',
] as const

export const DEX_BSC_TARGET_PROTOCOL_IDS = [
  'pancakeswap_v2',
  'pancakeswap_v3',
  'pancakeswap_infinity_cl',
  'pancakeswap_infinity_bin',
] as const

const LOGICAL_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SAFE_REPOSITORY_PATH =
  /^[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*(?:\/[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*)*$/

const OFFICIAL_PANCAKE_REPOSITORIES = new Set([
  'https://github.com/pancakeswap/pancake-developer',
  'https://github.com/pancakeswap/pancake-smart-contracts',
  'https://github.com/pancakeswap/pancake-v3-contracts',
  'https://github.com/pancakeswap/infinity-core',
  'https://github.com/pancakeswap/infinity-periphery',
  'https://github.com/pancakeswap/infinity-universal-router',
])

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeRepositoryPath(value: string): boolean {
  return SAFE_REPOSITORY_PATH.test(value)
}

function isOfficialPancakeRepository(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.pathname !== '/' &&
      !parsed.pathname.endsWith('/') &&
      OFFICIAL_PANCAKE_REPOSITORIES.has(value)
    )
  } catch {
    return false
  }
}

const logicalIdSchema = z.string().regex(LOGICAL_ID)
const sha256Schema = z.string().regex(SHA256)

const artifactSchema = z
  .object({
    artifact_id: logicalIdSchema,
    artifact_kind: z.enum([
      'official_address_registry',
      'official_deployment_registry',
      'contract_source',
      'event_interface',
    ]),
    official_url: z.string().url(),
    repository: z
      .string()
      .refine(isOfficialPancakeRepository, 'repository must be a canonical official Pancake URL'),
    git_commit: z.string().regex(FULL_GIT_SHA),
    path: z.string().refine(isSafeRepositoryPath, 'path must be a safe repository-relative path'),
    declared_raw_file_sha256: sha256Schema,
    hash_basis: z.literal('git_file_raw_bytes'),
    integrity_state: z.literal('declared_not_repository_verified'),
    license: z.enum([
      'GPL-2.0-only',
      'GPL-2.0-or-later',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
      'MIT',
      'NOASSERTION',
    ]),
    license_scope: z.enum(['repository', 'file', 'none']),
    usage: z.literal('reference_only'),
  })
  .strict()

const contractSchema = z
  .object({
    contract_id: logicalIdSchema,
    role: z.enum([
      'factory',
      'pool_deployer',
      'router',
      'universal_router',
      'pool_manager',
      'vault',
    ]),
    address: z.string().regex(EVM_ADDRESS),
    event_role: z.enum([
      'factory_discovery_root',
      'singleton_trade_event_source',
      'attribution_only',
      'settlement_context',
      'deployment_context',
    ]),
    address_artifact_id: logicalIdSchema,
    address_evidence_locator: z.string().min(1),
    interface_artifact_ids: z.array(logicalIdSchema),
    onchain_verification: z
      .object({
        state: z.literal('not_verified'),
        observed_at: z.null(),
        finalized_block: z.null(),
        creation_transaction_hash: z.null(),
        runtime_code_keccak256: z.null(),
      })
      .strict(),
  })
  .strict()

const factoryChildEventSurfaceSchema = z
  .object({
    kind: z.literal('factory_created_contracts'),
    discovery_root_contract_id: logicalIdSchema,
    discovery_event: z.enum(['PairCreated', 'PoolCreated']),
    child_contract_kind: z.enum(['pair', 'pool']),
    child_event_interface_artifact_id: logicalIdSchema,
    trade_event_emitter_scope: z.literal('discovered_child_contracts'),
    discovered_child_set_complete: z.literal(false),
    child_start_blocks_verified: z.literal(false),
  })
  .strict()

const singletonManagerEventSurfaceSchema = z
  .object({
    kind: z.literal('singleton_pool_manager'),
    trade_event_source_contract_id: logicalIdSchema,
    initialization_event: z.literal('Initialize'),
    pool_identity_scope: z.literal('manager_scoped_pool_id'),
    initialization_registry_complete: z.literal(false),
  })
  .strict()

const epochSchema = z
  .object({
    epoch_id: logicalIdSchema,
    version_label: z.string().min(1),
    start_block: z.null(),
    end_block: z.null(),
    activation_state: z.literal('unverified'),
    contracts: z.array(contractSchema).min(1),
    event_surface: z.discriminatedUnion('kind', [
      factoryChildEventSurfaceSchema,
      singletonManagerEventSurfaceSchema,
    ]),
  })
  .strict()

const protocolSchema = z
  .object({
    protocol_id: logicalIdSchema,
    family: z.literal('pancakeswap'),
    lifecycle_status: z.literal('official_source_candidate_unverified'),
    selection_basis: z.literal('official_pancakeswap_seed_not_live_sample'),
    upgrade_model: z.enum([
      'immutable_factory_dynamic_pools',
      'singleton_managers_upgradeability_unverified',
    ]),
    verification_state: z.literal('draft'),
    blocking_reasons: z.array(logicalIdSchema),
    epochs: z.array(epochSchema).min(1),
    decoder: z
      .object({
        owner: z.null(),
        implementation_state: z.literal('not_started'),
        golden_transactions_verified: z.literal(false),
        required_fact_families: z
          .array(
            z.enum([
              'failed_transaction_semantics',
              'fees',
              'native_bnb_cashflow',
              'router_user_attribution',
              'swap_fills',
              'token_cashflow',
            ])
          )
          .min(1),
      })
      .strict(),
    finality_policy: z.null(),
  })
  .strict()

const manifestSchema = z
  .object({
    schema_version: z.literal(DEX_BSC_PROTOCOL_MANIFEST_SCHEMA_VERSION),
    data_contract: z.literal(DEX_BSC_PROTOCOL_MANIFEST_CONTRACT),
    purpose: z.literal('phase0_bsc_protocol_discovery_seed_only'),
    evidence_as_of: z.string().refine(isCanonicalTimestamp, 'evidence_as_of must be canonical ISO'),
    chain: z
      .object({
        namespace: z.literal('eip155'),
        chain_id: z.literal(56),
        network: z.literal('bsc-mainnet'),
        source_slug: z.literal('binance_web3_bsc'),
      })
      .strict(),
    coverage: z
      .object({
        selection_basis: z.literal('official_pancakeswap_seed_only'),
        live_wallet_sample_profiled: z.literal(false),
        non_pancakeswap_protocols_profiled: z.literal(false),
        protocol_event_share_measured: z.literal(false),
        wallet_population_recall_measured: z.literal(false),
        coverage_claim: z.literal('none'),
      })
      .strict(),
    artifacts: z.array(artifactSchema).min(1),
    protocols: z.array(protocolSchema).min(1),
    known_gaps: z.array(logicalIdSchema),
    authorization: z
      .object({
        execution: z.literal(false),
        artifact_persistence: z.literal(false),
        serving: z.literal(false),
        rank: z.literal(false),
        score: z.literal(false),
      })
      .strict(),
  })
  .strict()

export type DexBscProtocolArtifact = z.infer<typeof artifactSchema>
export type DexBscProtocol = z.infer<typeof protocolSchema>
export type DexBscProtocolManifest = z.infer<typeof manifestSchema>

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertArtifactInvariants(artifact: DexBscProtocolArtifact): void {
  const expectedUrl = `${artifact.repository}/blob/${artifact.git_commit}/${artifact.path}`
  if (artifact.official_url !== expectedUrl) {
    throw new Error(
      `artifact URL is not pinned to its declared commit and path: ${artifact.artifact_id}`
    )
  }
  if ((artifact.license === 'NOASSERTION') !== (artifact.license_scope === 'none')) {
    throw new Error(
      `artifact license scope conflicts with SPDX declaration: ${artifact.artifact_id}`
    )
  }
}

function assertRequiredBlockers(protocol: DexBscProtocol): void {
  assertUnique(protocol.blocking_reasons, `blocking reason in ${protocol.protocol_id}`)
  const actual = new Set(protocol.blocking_reasons)
  for (const required of DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS) {
    if (!actual.has(required)) {
      throw new Error(`missing required blocker in ${protocol.protocol_id}: ${required}`)
    }
  }
  const hasFactorySurface = protocol.epochs.some(
    (epoch) => epoch.event_surface.kind === 'factory_created_contracts'
  )
  const hasSingletonSurface = protocol.epochs.some(
    (epoch) => epoch.event_surface.kind === 'singleton_pool_manager'
  )
  if (hasFactorySurface && !actual.has('child_contract_set_incomplete')) {
    throw new Error(
      `missing factory child-set blocker in ${protocol.protocol_id}: child_contract_set_incomplete`
    )
  }
  if (hasSingletonSurface && !actual.has('manager_pool_registry_unverified')) {
    throw new Error(
      `missing manager registry blocker in ${protocol.protocol_id}: manager_pool_registry_unverified`
    )
  }
  if (hasSingletonSurface && !actual.has('hook_delta_semantics_unverified')) {
    throw new Error(
      `missing singleton hook blocker in ${protocol.protocol_id}: hook_delta_semantics_unverified`
    )
  }
}

function expectedEventRole(
  role: DexBscProtocol['epochs'][number]['contracts'][number]['role']
): DexBscProtocol['epochs'][number]['contracts'][number]['event_role'] {
  switch (role) {
    case 'factory':
      return 'factory_discovery_root'
    case 'pool_manager':
      return 'singleton_trade_event_source'
    case 'router':
    case 'universal_router':
      return 'attribution_only'
    case 'vault':
      return 'settlement_context'
    case 'pool_deployer':
      return 'deployment_context'
  }
}

function assertTargetProtocolTopology(protocol: DexBscProtocol): void {
  for (const epoch of protocol.epochs) {
    if (protocol.protocol_id === 'pancakeswap_v2') {
      if (
        epoch.event_surface.kind !== 'factory_created_contracts' ||
        epoch.event_surface.child_contract_kind !== 'pair' ||
        epoch.event_surface.discovery_event !== 'PairCreated'
      ) {
        throw new Error('pancakeswap_v2 requires PairCreated-discovered pair contracts')
      }
    } else if (protocol.protocol_id === 'pancakeswap_v3') {
      if (
        epoch.event_surface.kind !== 'factory_created_contracts' ||
        epoch.event_surface.child_contract_kind !== 'pool' ||
        epoch.event_surface.discovery_event !== 'PoolCreated'
      ) {
        throw new Error('pancakeswap_v3 requires PoolCreated-discovered pool contracts')
      }
    } else if (
      protocol.protocol_id === 'pancakeswap_infinity_cl' ||
      protocol.protocol_id === 'pancakeswap_infinity_bin'
    ) {
      const expectedManagerId =
        protocol.protocol_id === 'pancakeswap_infinity_cl' ? 'cl_pool_manager' : 'bin_pool_manager'
      if (
        epoch.event_surface.kind !== 'singleton_pool_manager' ||
        epoch.event_surface.trade_event_source_contract_id !== expectedManagerId
      ) {
        throw new Error(
          `${protocol.protocol_id} requires its named singleton pool manager trade source`
        )
      }
    }
  }
}

function assertEpochInvariants(
  protocol: DexBscProtocol,
  artifacts: ReadonlyMap<string, DexBscProtocolArtifact>
): void {
  assertUnique(
    protocol.epochs.map((epoch) => epoch.epoch_id),
    `epoch in ${protocol.protocol_id}`
  )

  for (const epoch of protocol.epochs) {
    assertUnique(
      epoch.contracts.map((contract) => contract.contract_id),
      `contract id in ${protocol.protocol_id}:${epoch.epoch_id}`
    )
    assertUnique(
      epoch.contracts.map((contract) => contract.address.toLowerCase()),
      `contract address in ${protocol.protocol_id}:${epoch.epoch_id}`
    )

    const contracts = new Map(
      epoch.contracts.map((contract) => [contract.contract_id, contract] as const)
    )
    for (const contract of epoch.contracts) {
      if (/^0x0{40}$/i.test(contract.address)) {
        throw new Error(`zero contract address in ${protocol.protocol_id}:${epoch.epoch_id}`)
      }
      assertUnique(
        contract.interface_artifact_ids,
        `interface artifact in ${protocol.protocol_id}:${epoch.epoch_id}:${contract.contract_id}`
      )
      const addressArtifact = artifacts.get(contract.address_artifact_id)
      if (
        addressArtifact?.artifact_kind !== 'official_address_registry' &&
        addressArtifact?.artifact_kind !== 'official_deployment_registry'
      ) {
        throw new Error(
          `invalid address artifact for ${protocol.protocol_id}:${contract.contract_id}`
        )
      }
      for (const artifactId of contract.interface_artifact_ids) {
        const artifact = artifacts.get(artifactId)
        if (
          artifact?.artifact_kind !== 'contract_source' &&
          artifact?.artifact_kind !== 'event_interface'
        ) {
          throw new Error(
            `invalid interface artifact for ${protocol.protocol_id}:${contract.contract_id}`
          )
        }
      }
      if (contract.event_role !== expectedEventRole(contract.role)) {
        throw new Error(
          `contract role conflicts with event role: ${protocol.protocol_id}:${contract.contract_id}`
        )
      }
      if (
        (contract.event_role === 'factory_discovery_root' ||
          contract.event_role === 'singleton_trade_event_source') &&
        contract.interface_artifact_ids.length === 0
      ) {
        throw new Error(
          `discovery or trade event source requires an interface artifact: ${protocol.protocol_id}:${contract.contract_id}`
        )
      }
    }

    if (epoch.event_surface.kind === 'factory_created_contracts') {
      const discoveryRoot = contracts.get(epoch.event_surface.discovery_root_contract_id)
      if (
        discoveryRoot?.role !== 'factory' ||
        discoveryRoot.event_role !== 'factory_discovery_root'
      ) {
        throw new Error(
          `factory event surface requires a discovery-only factory root: ${protocol.protocol_id}`
        )
      }
      if (
        epoch.contracts.filter((contract) => contract.event_role === 'factory_discovery_root')
          .length !== 1
      ) {
        throw new Error(
          `factory epoch must have exactly one discovery root: ${protocol.protocol_id}`
        )
      }
      const childInterface = artifacts.get(epoch.event_surface.child_event_interface_artifact_id)
      if (
        childInterface?.artifact_kind !== 'contract_source' &&
        childInterface?.artifact_kind !== 'event_interface'
      ) {
        throw new Error(`factory child event interface is invalid: ${protocol.protocol_id}`)
      }
      const expectedEvent =
        epoch.event_surface.child_contract_kind === 'pair' ? 'PairCreated' : 'PoolCreated'
      if (epoch.event_surface.discovery_event !== expectedEvent) {
        throw new Error(
          `factory discovery event conflicts with child kind: ${protocol.protocol_id}`
        )
      }
      if (protocol.upgrade_model !== 'immutable_factory_dynamic_pools') {
        throw new Error(
          `factory event surface conflicts with upgrade model: ${protocol.protocol_id}`
        )
      }
    } else {
      const tradeEventSource = contracts.get(epoch.event_surface.trade_event_source_contract_id)
      if (
        tradeEventSource?.role !== 'pool_manager' ||
        tradeEventSource.event_role !== 'singleton_trade_event_source'
      ) {
        throw new Error(
          `singleton manager event surface requires a manager trade source: ${protocol.protocol_id}`
        )
      }
      if (
        epoch.contracts.filter((contract) => contract.event_role === 'singleton_trade_event_source')
          .length !== 1
      ) {
        throw new Error(
          `singleton manager epoch must have exactly one trade source: ${protocol.protocol_id}`
        )
      }
      if (protocol.upgrade_model !== 'singleton_managers_upgradeability_unverified') {
        throw new Error(
          `singleton manager event surface conflicts with upgrade model: ${protocol.protocol_id}`
        )
      }
    }
  }
}

function assertManifestInvariants(manifest: DexBscProtocolManifest): void {
  assertUnique(
    manifest.artifacts.map((artifact) => artifact.artifact_id),
    'artifact id'
  )
  assertUnique(
    manifest.artifacts.map(
      (artifact) => `${artifact.repository}@${artifact.git_commit}:${artifact.path}`
    ),
    'artifact source'
  )
  assertUnique(
    manifest.protocols.map((protocol) => protocol.protocol_id),
    'protocol id'
  )
  assertUnique(manifest.known_gaps, 'known gap')
  const knownGaps = new Set(manifest.known_gaps)
  for (const requiredGap of DEX_BSC_REQUIRED_KNOWN_GAPS) {
    if (!knownGaps.has(requiredGap)) {
      throw new Error(`BSC source seed is missing required known gap: ${requiredGap}`)
    }
  }
  const protocolIds = new Set(manifest.protocols.map((protocol) => protocol.protocol_id))
  for (const targetId of DEX_BSC_TARGET_PROTOCOL_IDS) {
    const missingGap = `${targetId}_not_seeded`
    if (!protocolIds.has(targetId) && !knownGaps.has(missingGap)) {
      throw new Error(`BSC source seed must disclose missing target protocol: ${targetId}`)
    }
    if (protocolIds.has(targetId) && knownGaps.has(missingGap)) {
      throw new Error(`BSC source seed contradicts seeded target protocol: ${targetId}`)
    }
  }

  for (const artifact of manifest.artifacts) assertArtifactInvariants(artifact)
  const artifacts = new Map(
    manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact] as const)
  )
  for (const protocol of manifest.protocols) {
    assertRequiredBlockers(protocol)
    assertTargetProtocolTopology(protocol)
    assertUnique(
      protocol.decoder.required_fact_families,
      `decoder fact family in ${protocol.protocol_id}`
    )
    assertEpochInvariants(protocol, artifacts)
  }
}

export function parseDexBscProtocolManifest(input: unknown): DexBscProtocolManifest {
  const manifest = manifestSchema.parse(input)
  assertManifestInvariants(manifest)
  return manifest
}

export function normalizeDexBscProtocolManifest(input: unknown): DexBscProtocolManifest {
  const manifest = parseDexBscProtocolManifest(input)
  return {
    ...manifest,
    artifacts: [...manifest.artifacts].sort((a, b) => compareText(a.artifact_id, b.artifact_id)),
    known_gaps: [...manifest.known_gaps].sort(compareText),
    protocols: manifest.protocols
      .map((protocol) => ({
        ...protocol,
        blocking_reasons: [...protocol.blocking_reasons].sort(compareText),
        epochs: protocol.epochs
          .map((epoch) => ({
            ...epoch,
            contracts: epoch.contracts
              .map((contract) => ({
                ...contract,
                interface_artifact_ids: [...contract.interface_artifact_ids].sort(compareText),
              }))
              .sort((a, b) => compareText(a.contract_id, b.contract_id)),
          }))
          .sort((a, b) => compareText(a.epoch_id, b.epoch_id)),
        decoder: {
          ...protocol.decoder,
          required_fact_families: [...protocol.decoder.required_fact_families].sort(compareText),
        },
      }))
      .sort((a, b) => compareText(a.protocol_id, b.protocol_id)),
  }
}

export function dexBscProtocolManifestSha256(input: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonCodePoint(normalizeDexBscProtocolManifest(input)))
    .digest('hex')
}

function canonicalValueCodePoint(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
    return value
  }
  if (typeof value !== 'object') {
    throw new Error(`canonical JSON rejects ${typeof value}`)
  }
  if (ancestors.has(value)) throw new Error('canonical JSON rejects cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalValueCodePoint(item, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical JSON accepts plain objects only')
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalValueCodePoint(item, ancestors)])
    )
  } finally {
    ancestors.delete(value)
  }
}

function canonicalJsonCodePoint(value: unknown): string {
  return JSON.stringify(canonicalValueCodePoint(value, new Set()))
}
