import { createHash } from 'node:crypto'
import { z } from 'zod'

import { strictCanonicalSha256 } from './dex-contract-hash'

export const DEX_SOLANA_PROTOCOL_MANIFEST_SCHEMA_VERSION = 1 as const
export const DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT = 'arena.dex.solana-protocol-manifest@1' as const

export const SOLANA_BPF_LOADER_V1 = 'BPFLoader1111111111111111111111111111111111' as const
export const SOLANA_BPF_LOADER_V2 = 'BPFLoader2111111111111111111111111111111111' as const
export const SOLANA_BPF_LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111' as const
export const SOLANA_LOADER_V4 = 'LoaderV411111111111111111111111111111111111' as const

export const DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS = [
  'artifact_integrity_unverified',
  'chain_program_bytes_unverified',
  'decoder_owner_unassigned',
  'deployment_slot_unverified',
  'finality_policy_unverified',
  'golden_transactions_unverified',
  'live_sample_instruction_share_unmeasured',
  'program_loader_unverified',
  'program_source_build_unbound',
  'programdata_source_unbound',
  'token_cashflow_semantics_unverified',
  'transaction_account_resolution_unverified',
  'upgrade_epochs_unverified',
  'wallet_attribution_unverified',
] as const

export const DEX_SOLANA_DECODER_REQUIRED_FACTS = [
  'account_keys_with_lookup_tables',
  'failed_transaction_semantics',
  'fee_and_lamport_cashflow',
  'inner_instruction_tree',
  'token_balance_deltas',
  'token_transfer_cashflow',
  'user_wallet_attribution',
  'venue_swap_legs',
] as const

export const DEX_SOLANA_REQUIRED_KNOWN_GAPS = [
  'jupiter_inner_venue_coverage_unmeasured',
  'legacy_orca_v1_v2_not_seeded',
  'non_target_solana_programs_not_profiled',
  'raydium_stable_launchlab_not_seeded',
  'unprofiled_program_hits_not_quantified',
] as const

export const DEX_SOLANA_TARGET_PROTOCOLS = {
  jupiter_swap_v6: {
    family: 'jupiter',
    product: 'swap_v6',
    program_role: 'aggregator_router',
    program_id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  },
  raydium_amm_v4: {
    family: 'raydium',
    product: 'amm_v4',
    program_role: 'liquidity_venue',
    program_id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  },
  raydium_cpmm: {
    family: 'raydium',
    product: 'cpmm',
    program_role: 'liquidity_venue',
    program_id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  },
  raydium_clmm: {
    family: 'raydium',
    product: 'clmm',
    program_role: 'liquidity_venue',
    program_id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  },
  orca_whirlpool: {
    family: 'orca',
    product: 'whirlpool',
    program_role: 'liquidity_venue',
    program_id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  },
  meteora_dlmm: {
    family: 'meteora',
    product: 'dlmm',
    program_role: 'liquidity_venue',
    program_id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  },
  meteora_damm_v1: {
    family: 'meteora',
    product: 'damm_v1',
    program_role: 'liquidity_venue',
    program_id: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  },
  meteora_damm_v2: {
    family: 'meteora',
    product: 'damm_v2',
    program_role: 'liquidity_venue',
    program_id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  },
  meteora_dbc: {
    family: 'meteora',
    product: 'dynamic_bonding_curve',
    program_role: 'liquidity_venue',
    program_id: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  },
} as const

export const DEX_SOLANA_TARGET_PROTOCOL_IDS = Object.keys(
  DEX_SOLANA_TARGET_PROTOCOLS
) as (keyof typeof DEX_SOLANA_TARGET_PROTOCOLS)[]

const LOGICAL_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const DECIMAL_SLOT = /^(?:0|[1-9][0-9]*)$/
const U64_MAX = (1n << 64n) - 1n
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/
const SAFE_REPOSITORY_PATH =
  /^[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*(?:\/[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*)*$/

const OFFICIAL_SOLANA_PROTOCOL_REPOSITORIES = new Set([
  'https://github.com/MeteoraAg/damm-v2',
  'https://github.com/MeteoraAg/dlmm-sdk',
  'https://github.com/MeteoraAg/dynamic-amm-sdk',
  'https://github.com/MeteoraAg/dynamic-bonding-curve',
  'https://github.com/jup-ag/jupiter-amm-implementation',
  'https://github.com/jup-ag/instruction-parser',
  'https://github.com/orca-so/whirlpools',
  'https://github.com/raydium-io/raydium-amm',
  'https://github.com/raydium-io/raydium-clmm',
  'https://github.com/raydium-io/raydium-cp-swap',
  'https://github.com/raydium-io/raydium-idl',
])

const TARGET_PROTOCOL_REPOSITORIES: Record<
  keyof typeof DEX_SOLANA_TARGET_PROTOCOLS,
  readonly string[]
> = {
  jupiter_swap_v6: [
    'https://github.com/jup-ag/jupiter-amm-implementation',
    'https://github.com/jup-ag/instruction-parser',
  ],
  raydium_amm_v4: ['https://github.com/raydium-io/raydium-amm'],
  raydium_cpmm: [
    'https://github.com/raydium-io/raydium-cp-swap',
    'https://github.com/raydium-io/raydium-idl',
  ],
  raydium_clmm: [
    'https://github.com/raydium-io/raydium-clmm',
    'https://github.com/raydium-io/raydium-idl',
  ],
  orca_whirlpool: ['https://github.com/orca-so/whirlpools'],
  meteora_dlmm: ['https://github.com/MeteoraAg/dlmm-sdk'],
  meteora_damm_v1: ['https://github.com/MeteoraAg/dynamic-amm-sdk'],
  meteora_damm_v2: ['https://github.com/MeteoraAg/damm-v2'],
  meteora_dbc: ['https://github.com/MeteoraAg/dynamic-bonding-curve'],
}

const KNOWN_DECLARED_LICENSES: Record<
  string,
  {
    identifier:
      | 'Apache-2.0'
      | 'GPL-3.0-only'
      | 'ISC'
      | 'MIT'
      | 'LicenseRef-Meteora-DAMM-v2-Noncommercial'
      | 'LicenseRef-Meteora-DBC-Noncommercial'
      | 'LicenseRef-Orca-License'
    terms_class: 'osi_approved' | 'custom_restricted'
    scope: 'repository' | 'package_subtree'
    scope_root: string | null
    evidence_path: string
    declared_evidence_sha256: string
    legal_review_required: boolean
  }
> = {
  'https://github.com/raydium-io/raydium-amm@c613c87c41edbe21112c9b8341774a70009c6d7b': {
    identifier: 'Apache-2.0',
    terms_class: 'osi_approved',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'LICENSE',
    declared_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'https://github.com/raydium-io/raydium-cp-swap@78f254e1023751e706df7dc15c453fc3e046697c': {
    identifier: 'Apache-2.0',
    terms_class: 'osi_approved',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'LICENSE',
    declared_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'https://github.com/raydium-io/raydium-clmm@03b44b7ff41014b3fc715d445ee05f08d3815a99': {
    identifier: 'Apache-2.0',
    terms_class: 'osi_approved',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'LICENSE',
    declared_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'https://github.com/orca-so/whirlpools@bab9a1f3e4a4021ca91d0d503132daf64e427486': {
    identifier: 'LicenseRef-Orca-License',
    terms_class: 'custom_restricted',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'LICENSE',
    declared_evidence_sha256: 'ab5facc90fe4f35f0dd07e2ed2ccce9c84b0d5019b782f74c6ce6356624fcffc',
    legal_review_required: true,
  },
  'https://github.com/MeteoraAg/dlmm-sdk@4eaaeaa6b832999db0ec4044cffe620658b4c8d9': {
    identifier: 'ISC',
    terms_class: 'osi_approved',
    scope: 'package_subtree',
    scope_root: 'ts-client',
    evidence_path: 'ts-client/package.json',
    declared_evidence_sha256: 'c6c5854e5a13782e051985e391a798c7edd0fa730bc906763036ed3b9eb8b71f',
    legal_review_required: false,
  },
  'https://github.com/MeteoraAg/dynamic-amm-sdk@02c66a3c13ebabdf71eb29d87996aaa7a06a7c29': {
    identifier: 'MIT',
    terms_class: 'osi_approved',
    scope: 'package_subtree',
    scope_root: 'ts-client',
    evidence_path: 'ts-client/package.json',
    declared_evidence_sha256: '2cef3fcdbb58eb596b300d9b05ba192d19572e6c48c7b811dbc6c874d911e85e',
    legal_review_required: false,
  },
  'https://github.com/MeteoraAg/damm-v2@bdd8a1e355f484b3cff131578a662c560b97b72f': {
    identifier: 'LicenseRef-Meteora-DAMM-v2-Noncommercial',
    terms_class: 'custom_restricted',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'license.md',
    declared_evidence_sha256: 'f5fd01dfb4f78c449fbec7d1fccb3c428a05254c1799287735fba643147ea015',
    legal_review_required: true,
  },
  'https://github.com/MeteoraAg/dynamic-bonding-curve@3b540e94b5b20ba37733de6e25f58522a0cd8961': {
    identifier: 'LicenseRef-Meteora-DBC-Noncommercial',
    terms_class: 'custom_restricted',
    scope: 'repository',
    scope_root: null,
    evidence_path: 'license.md',
    declared_evidence_sha256: '7c18b1ee4004d443bca671bd8ca63c39914add8e0b29a7b6d0d4244ac0701420',
    legal_review_required: true,
  },
}

const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeRepositoryPath(value: string): boolean {
  return SAFE_REPOSITORY_PATH.test(value)
}

function isOfficialSolanaProtocolRepository(value: string): boolean {
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
      OFFICIAL_SOLANA_PROTOCOL_REPOSITORIES.has(value)
    )
  } catch {
    return false
  }
}

function isCanonicalPublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false
  const decoded = decodeBase58(value)
  return decoded?.length === 32 && encodeBase58(decoded) === value
}

function decodeBase58(value: string): Uint8Array | null {
  if (!BASE58_PATTERN.test(value)) return null
  let numeric = 0n
  for (const character of value) {
    const digit = BASE58.indexOf(character)
    if (digit < 0) return null
    numeric = numeric * 58n + BigInt(digit)
  }

  const significant: number[] = []
  while (numeric > 0n) {
    significant.push(Number(numeric & 0xffn))
    numeric >>= 8n
  }
  significant.reverse()
  let leadingZeroes = 0
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1
  return Uint8Array.from([...new Array<number>(leadingZeroes).fill(0), ...significant])
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1
  let numeric = 0n
  for (const byte of bytes) numeric = (numeric << 8n) + BigInt(byte)
  let encoded = ''
  while (numeric > 0n) {
    encoded = BASE58[Number(numeric % 58n)] + encoded
    numeric /= 58n
  }
  return '1'.repeat(leadingZeroes) + encoded
}

const ED25519_PRIME = (1n << 255n) - 19n
const ED25519_D = mod(-121665n * modPow(121666n, ED25519_PRIME - 2n))
const ED25519_SQRT_M1 = modPow(2n, (ED25519_PRIME - 1n) / 4n)

function mod(value: bigint): bigint {
  const result = value % ED25519_PRIME
  return result < 0n ? result + ED25519_PRIME : result
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let factor = mod(base)
  for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
    if ((remaining & 1n) === 1n) result = mod(result * factor)
    factor = mod(factor * factor)
  }
  return result
}

function isEd25519CurvePoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false
  const encoded = Uint8Array.from(bytes)
  const xSign = (encoded[31] & 0x80) !== 0
  encoded[31] &= 0x7f
  let y = 0n
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    y = (y << 8n) + BigInt(encoded[index])
  }
  if (y >= ED25519_PRIME) return false

  const ySquared = mod(y * y)
  const xSquared = mod((ySquared - 1n) * modPow(mod(ED25519_D * ySquared + 1n), ED25519_PRIME - 2n))
  let x = modPow(xSquared, (ED25519_PRIME + 3n) / 8n)
  if (mod(x * x) !== xSquared) x = mod(x * ED25519_SQRT_M1)
  if (mod(x * x) !== xSquared) return false
  return !(x === 0n && xSign)
}

function deriveProgramDataAddressCandidate(programId: string, bumpSeed: number): string | null {
  const program = decodeBase58(programId)
  const loader = decodeBase58(SOLANA_BPF_LOADER_V3)
  if (
    !isCanonicalPublicKey(programId) ||
    program?.length !== 32 ||
    loader?.length !== 32 ||
    !Number.isInteger(bumpSeed) ||
    bumpSeed < 0 ||
    bumpSeed > 255
  ) {
    throw new Error('cannot derive ProgramData address from invalid public keys')
  }
  const digest = createHash('sha256')
    .update(program)
    .update(Uint8Array.of(bumpSeed))
    .update(loader)
    .update('ProgramDerivedAddress', 'utf8')
    .digest()
  return isEd25519CurvePoint(digest) ? null : encodeBase58(digest)
}

export function findSolanaV3ProgramDataAddress(programId: string): {
  address: string
  bump_seed: number
} {
  for (let bumpSeed = 255; bumpSeed >= 0; bumpSeed -= 1) {
    const address = deriveProgramDataAddressCandidate(programId, bumpSeed)
    if (address !== null) return { address, bump_seed: bumpSeed }
  }
  throw new Error('unable to derive an off-curve v3 ProgramData address')
}

function isCanonicalU64Decimal(value: string): boolean {
  return DECIMAL_SLOT.test(value) && value.length <= 20 && BigInt(value) <= U64_MAX
}

const logicalIdSchema = z.string().regex(LOGICAL_ID)
const sha256Schema = z.string().regex(SHA256)
const slotSchema = z.string().refine(isCanonicalU64Decimal, 'must be a canonical u64 decimal')
const publicKeySchema = z.string().refine(isCanonicalPublicKey, 'must be canonical 32-byte base58')

const unassertedLicenseSchema = z
  .object({
    state: z.literal('unasserted'),
    identifier: z.literal('NOASSERTION'),
    terms_class: z.literal('unknown'),
    scope: z.literal('none'),
    scope_root: z.null(),
    evidence_path: z.null(),
    declared_evidence_sha256: z.null(),
    evidence_integrity_state: z.literal('not_available'),
  })
  .strict()

const declaredLicenseSchema = z
  .object({
    state: z.literal('declared'),
    identifier: z.enum([
      'Apache-2.0',
      'GPL-3.0-only',
      'ISC',
      'MIT',
      'LicenseRef-Meteora-DAMM-v2-Noncommercial',
      'LicenseRef-Meteora-DBC-Noncommercial',
      'LicenseRef-Orca-License',
    ]),
    terms_class: z.enum(['osi_approved', 'custom_restricted']),
    scope: z.enum(['repository', 'package_subtree', 'file']),
    scope_root: z.string().nullable(),
    evidence_path: z
      .string()
      .refine(isSafeRepositoryPath, 'license evidence path must be repository-relative'),
    declared_evidence_sha256: sha256Schema,
    evidence_integrity_state: z.literal('declared_not_repository_verified'),
  })
  .strict()

const artifactSchema = z
  .object({
    artifact_id: logicalIdSchema,
    artifact_kind: z.enum(['program_source', 'program_idl', 'program_address_constant']),
    evidence_roles: z
      .array(z.enum(['decoder_reference', 'program_identity_reference', 'source_candidate']))
      .min(1),
    declared_program_ids: z.array(publicKeySchema).min(1),
    program_identity_locator: z.string().trim().min(1).max(300),
    official_url: z.string().url(),
    repository: z
      .string()
      .refine(
        isOfficialSolanaProtocolRepository,
        'repository must be a canonical allowlisted protocol URL'
      ),
    git_commit: z.string().regex(FULL_GIT_SHA),
    path: z.string().refine(isSafeRepositoryPath, 'path must be repository-relative'),
    declared_raw_file_sha256: sha256Schema,
    hash_basis: z.literal('git_file_raw_bytes'),
    integrity_state: z.literal('declared_not_repository_verified'),
    license: z.discriminatedUnion('state', [unassertedLicenseSchema, declaredLicenseSchema]),
    usage: z.literal('reference_only'),
    commercial_reuse_authorized: z.literal(false),
    legal_review_required: z.boolean(),
  })
  .strict()

const observationSourceSchema = z
  .object({
    provider_id: logicalIdSchema,
    endpoint_fingerprint_sha256: sha256Schema,
    response_sha256: sha256Schema,
    response_hash_basis: z.literal('json_rpc_response_raw_bytes'),
    canonical_decoded_observation_sha256: sha256Schema,
    decoded_hash_basis: z.literal('strict_canonical_decoded_program_observation'),
    commitment: z.literal('finalized'),
    observed_finalized_slot: slotSchema,
  })
  .strict()

const observationBase = {
  state: z.literal('provisional_observed'),
  observed_at: z.string().refine(isCanonicalTimestamp, 'observed_at must be canonical ISO'),
  observation_sources: z.array(observationSourceSchema).length(2),
} as const

const singleAccountObservationFields = {
  ...observationBase,
  program_executable: z.literal(true),
  program_account_data_sha256: sha256Schema,
  code_sha256: sha256Schema,
  code_storage: z.literal('program_account_raw_data'),
  deployment_slot: z.null(),
  effective_slot: z.null(),
} as const

const bpfLoaderV1EvidenceSchema = z
  .object({
    ...singleAccountObservationFields,
    loader_kind: z.literal('bpf_loader_v1'),
    loader_program_id: z.literal(SOLANA_BPF_LOADER_V1),
    program_account_owner: z.literal(SOLANA_BPF_LOADER_V1),
  })
  .strict()

const bpfLoaderV2EvidenceSchema = z
  .object({
    ...singleAccountObservationFields,
    loader_kind: z.literal('bpf_loader_v2'),
    loader_program_id: z.literal(SOLANA_BPF_LOADER_V2),
    program_account_owner: z.literal(SOLANA_BPF_LOADER_V2),
  })
  .strict()

const upgradeAuthoritySchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('present'),
      address: publicKeySchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('revoked'),
      address: z.null(),
    })
    .strict(),
])

const upgradeableLoaderEvidenceSchema = z
  .object({
    ...observationBase,
    loader_kind: z.literal('bpf_loader_v3'),
    loader_program_id: z.literal(SOLANA_BPF_LOADER_V3),
    program_account_owner: z.literal(SOLANA_BPF_LOADER_V3),
    program_executable: z.literal(true),
    program_account_data_sha256: sha256Schema,
    program_account_programdata_address: publicKeySchema,
    programdata_address: publicKeySchema,
    programdata_bump_seed: z.number().int().min(0).max(255),
    programdata_owner: z.literal(SOLANA_BPF_LOADER_V3),
    programdata_account_data_sha256: sha256Schema,
    code_sha256: sha256Schema,
    code_storage: z.literal('programdata_account_after_state_header'),
    deployed_slot: slotSchema,
    effective_slot: slotSchema,
    upgrade_authority: upgradeAuthoritySchema,
  })
  .strict()

const loaderV4ControlSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('authority'),
      address: publicKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('next_version'),
      address: publicKeySchema,
    })
    .strict(),
])

const loaderV4EvidenceSchema = z
  .object({
    ...observationBase,
    loader_kind: z.literal('loader_v4'),
    loader_program_id: z.literal(SOLANA_LOADER_V4),
    program_account_owner: z.literal(SOLANA_LOADER_V4),
    program_executable: z.literal(true),
    program_account_data_sha256: sha256Schema,
    code_sha256: sha256Schema,
    code_storage: z.literal('program_account_after_loader_v4_state'),
    deployed_slot: slotSchema,
    effective_slot: slotSchema,
    status: z.enum(['deployed', 'finalized']),
    authority_or_next_version: loaderV4ControlSchema,
  })
  .strict()

const loaderNotVerifiedSchema = z
  .object({
    state: z.literal('not_verified'),
    loader_kind: z.null(),
    loader_program_id: z.null(),
    observed_at: z.null(),
    observation_sources: z.array(z.never()).length(0),
  })
  .strict()

const loaderEvidenceSchema = z.discriminatedUnion('loader_kind', [
  loaderNotVerifiedSchema,
  bpfLoaderV1EvidenceSchema,
  bpfLoaderV2EvidenceSchema,
  upgradeableLoaderEvidenceSchema,
  loaderV4EvidenceSchema,
])

const decoderFactSchema = z.enum([
  ...DEX_SOLANA_DECODER_REQUIRED_FACTS,
  'aggregator_route_attribution',
])

const protocolSchema = z
  .object({
    protocol_id: logicalIdSchema,
    family: z.enum(['jupiter', 'meteora', 'orca', 'raydium']),
    product: logicalIdSchema,
    program_role: z.enum(['aggregator_router', 'liquidity_venue']),
    program_id: publicKeySchema,
    lifecycle_status: z.literal('official_reference_candidate_unverified'),
    selection_basis: z.literal('curated_official_program_seed_not_live_sample'),
    verification_state: z.literal('draft'),
    reference_artifact_ids: z.array(logicalIdSchema).min(1),
    program_address_artifact_id: logicalIdSchema,
    blocking_reasons: z.array(logicalIdSchema),
    loader_evidence: loaderEvidenceSchema,
    code_epochs: z.array(z.never()).length(0),
    decoder: z
      .object({
        owner: z.null(),
        implementation_state: z.literal('not_started'),
        golden_transactions_verified: z.literal(false),
        required_fact_families: z.array(decoderFactSchema).min(1),
      })
      .strict(),
    finality_policy: z.null(),
  })
  .strict()

const manifestSchema = z
  .object({
    schema_version: z.literal(DEX_SOLANA_PROTOCOL_MANIFEST_SCHEMA_VERSION),
    data_contract: z.literal(DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT),
    purpose: z.literal('phase0_solana_protocol_discovery_seed_only'),
    evidence_as_of: z.string().refine(isCanonicalTimestamp, 'evidence_as_of must be canonical ISO'),
    chain: z
      .object({
        namespace: z.literal('solana'),
        network: z.literal('mainnet-beta'),
        source_slug: z.literal('solana_mainnet'),
      })
      .strict(),
    coverage: z
      .object({
        selection_basis: z.literal('curated_nine_program_seed_only'),
        live_wallet_sample_profiled: z.literal(false),
        program_hit_distribution_measured: z.literal(false),
        instruction_share_measured: z.literal(false),
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

export type DexSolanaProtocolArtifact = z.infer<typeof artifactSchema>
export type DexSolanaProtocol = z.infer<typeof protocolSchema>
export type DexSolanaProtocolManifest = z.infer<typeof manifestSchema>

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function assertArtifactInvariants(artifact: DexSolanaProtocolArtifact): void {
  const expectedUrl = `${artifact.repository}/blob/${artifact.git_commit}/${artifact.path}`
  if (artifact.official_url !== expectedUrl) {
    throw new Error(`artifact URL is not pinned to its commit and path: ${artifact.artifact_id}`)
  }
  assertUnique(artifact.evidence_roles, `artifact evidence role in ${artifact.artifact_id}`)
  assertUnique(artifact.declared_program_ids, `declared program id in ${artifact.artifact_id}`)

  const repositoryProgramIds = new Set<string>(
    DEX_SOLANA_TARGET_PROTOCOL_IDS.filter((protocolId) =>
      TARGET_PROTOCOL_REPOSITORIES[protocolId].includes(artifact.repository)
    ).map((protocolId) => DEX_SOLANA_TARGET_PROTOCOLS[protocolId].program_id)
  )
  for (const programId of artifact.declared_program_ids) {
    if (!repositoryProgramIds.has(programId)) {
      throw new Error(
        `declared program id is not owned by artifact repository: ${artifact.artifact_id}`
      )
    }
  }

  if (artifact.artifact_kind === 'program_source') {
    if (!artifact.evidence_roles.includes('source_candidate')) {
      throw new Error(`program source lacks source-candidate role: ${artifact.artifact_id}`)
    }
  } else if (artifact.evidence_roles.includes('source_candidate')) {
    throw new Error(`non-source artifact claims source-candidate role: ${artifact.artifact_id}`)
  }

  const { license } = artifact
  if (license.state === 'unasserted') {
    if (!artifact.legal_review_required) {
      throw new Error(`unasserted artifact requires legal review: ${artifact.artifact_id}`)
    }
    return
  }

  const expectedLicense = KNOWN_DECLARED_LICENSES[`${artifact.repository}@${artifact.git_commit}`]
  if (
    expectedLicense === undefined ||
    license.identifier !== expectedLicense.identifier ||
    license.terms_class !== expectedLicense.terms_class ||
    license.scope !== expectedLicense.scope ||
    license.scope_root !== expectedLicense.scope_root ||
    license.evidence_path !== expectedLicense.evidence_path ||
    license.declared_evidence_sha256 !== expectedLicense.declared_evidence_sha256 ||
    artifact.legal_review_required !== expectedLicense.legal_review_required
  ) {
    throw new Error(
      `declared license does not match the pinned repository policy: ${artifact.artifact_id}`
    )
  }

  const isCustom = license.identifier.startsWith('LicenseRef-')
  if (isCustom !== (license.terms_class === 'custom_restricted')) {
    throw new Error(`license terms class conflicts with identifier: ${artifact.artifact_id}`)
  }
  if (isCustom && !artifact.legal_review_required) {
    throw new Error(`restricted artifact requires legal review: ${artifact.artifact_id}`)
  }
  if (license.identifier === 'GPL-3.0-only' && !artifact.legal_review_required) {
    throw new Error(`copyleft artifact requires legal review: ${artifact.artifact_id}`)
  }

  if (license.scope === 'repository') {
    if (license.scope_root !== null) {
      throw new Error(`repository license scope must have a null root: ${artifact.artifact_id}`)
    }
  } else if (license.scope === 'package_subtree') {
    if (
      license.scope_root === null ||
      !isSafeRepositoryPath(license.scope_root) ||
      !artifact.path.startsWith(`${license.scope_root}/`) ||
      !license.evidence_path.startsWith(`${license.scope_root}/`)
    ) {
      throw new Error(`package license scope does not cover artifact: ${artifact.artifact_id}`)
    }
  } else if (license.scope_root !== artifact.path) {
    throw new Error(`file license scope must name the artifact path: ${artifact.artifact_id}`)
  }
}

function assertObservationSources(
  evidence: Exclude<DexSolanaProtocol['loader_evidence'], { state: 'not_verified' }>,
  minimumVisibleSlot?: bigint
): void {
  assertUnique(
    evidence.observation_sources.map((source) => source.provider_id),
    'RPC provider'
  )
  assertUnique(
    evidence.observation_sources.map((source) => source.endpoint_fingerprint_sha256),
    'RPC endpoint fingerprint'
  )
  const decodedObservationHashes = new Set(
    evidence.observation_sources.map((source) => source.canonical_decoded_observation_sha256)
  )
  if (decodedObservationHashes.size !== 1) {
    throw new Error('independent RPC sources disagree on the canonical decoded observation')
  }
  if (
    minimumVisibleSlot !== undefined &&
    evidence.observation_sources.some(
      (source) => BigInt(source.observed_finalized_slot) < minimumVisibleSlot
    )
  ) {
    throw new Error('RPC observation predates the effective program slot')
  }
}

function assertLoaderEvidence(program: DexSolanaProtocol): void {
  const evidence = program.loader_evidence
  if (evidence.state === 'not_verified') return
  assertObservationSources(evidence)

  if (evidence.loader_kind === 'bpf_loader_v1' || evidence.loader_kind === 'bpf_loader_v2') {
    const expectedLoader =
      evidence.loader_kind === 'bpf_loader_v1' ? SOLANA_BPF_LOADER_V1 : SOLANA_BPF_LOADER_V2
    if (
      evidence.loader_program_id !== expectedLoader ||
      evidence.program_account_owner !== expectedLoader
    ) {
      throw new Error(`${evidence.loader_kind} owner conflicts with loader program`)
    }
    if (evidence.program_account_data_sha256 !== evidence.code_sha256) {
      throw new Error(`${evidence.loader_kind} raw program data must equal stored code bytes`)
    }
    return
  }

  if (BigInt(evidence.effective_slot) !== BigInt(evidence.deployed_slot) + 1n) {
    throw new Error(`${evidence.loader_kind} effective slot must equal deployed slot plus one`)
  }
  assertObservationSources(evidence, BigInt(evidence.effective_slot))

  if (evidence.loader_kind === 'bpf_loader_v3') {
    if (evidence.program_account_programdata_address !== evidence.programdata_address) {
      throw new Error('v3 Program account pointer does not match the ProgramData account')
    }
    const expectedProgramData = findSolanaV3ProgramDataAddress(program.program_id)
    if (
      evidence.programdata_address !== expectedProgramData.address ||
      evidence.programdata_bump_seed !== expectedProgramData.bump_seed
    ) {
      throw new Error(`v3 ProgramData address is not the program-derived address`)
    }
    if (
      evidence.upgrade_authority.state === 'present' &&
      evidence.upgrade_authority.address === DEFAULT_PUBLIC_KEY
    ) {
      throw new Error('v3 upgrade authority cannot be the default public key')
    }
    return
  }

  const expectedControlKind = evidence.status === 'finalized' ? 'next_version' : 'authority'
  if (evidence.authority_or_next_version.kind !== expectedControlKind) {
    throw new Error(`loader v4 status conflicts with authority-or-next-version semantics`)
  }
  if (evidence.authority_or_next_version.address === DEFAULT_PUBLIC_KEY) {
    throw new Error('loader v4 control address cannot be the default public key')
  }
}

function assertRequiredBlockers(
  protocol: DexSolanaProtocol,
  artifacts: ReadonlyMap<string, DexSolanaProtocolArtifact>
): void {
  assertUnique(protocol.blocking_reasons, `blocking reason in ${protocol.protocol_id}`)
  const actual = new Set(protocol.blocking_reasons)
  for (const required of DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS) {
    if (!actual.has(required)) {
      throw new Error(`missing required blocker in ${protocol.protocol_id}: ${required}`)
    }
  }
  if (
    protocol.program_role === 'aggregator_router' &&
    !actual.has('inner_venue_program_coverage_unverified')
  ) {
    throw new Error(`aggregator is missing its inner-venue coverage blocker`)
  }
  const hasLegalRisk = protocol.reference_artifact_ids.some((artifactId) => {
    const artifact = artifacts.get(artifactId)
    return artifact?.legal_review_required === true
  })
  if (hasLegalRisk && !actual.has('commercial_decoder_legal_clearance_required')) {
    throw new Error(`protocol with legal risk lacks commercial decoder clearance blocker`)
  }
}

function assertDecoderFacts(protocol: DexSolanaProtocol): void {
  assertUnique(
    protocol.decoder.required_fact_families,
    `decoder fact family in ${protocol.protocol_id}`
  )
  const actual = new Set(protocol.decoder.required_fact_families)
  for (const required of DEX_SOLANA_DECODER_REQUIRED_FACTS) {
    if (!actual.has(required)) {
      throw new Error(`decoder fact contract is incomplete in ${protocol.protocol_id}: ${required}`)
    }
  }
  if (
    protocol.program_role === 'aggregator_router' &&
    !actual.has('aggregator_route_attribution')
  ) {
    throw new Error('aggregator decoder must retain route attribution')
  }
}

function assertManifestInvariants(manifest: DexSolanaProtocolManifest): void {
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
  assertUnique(
    manifest.protocols.map((protocol) => protocol.program_id),
    'program id'
  )
  assertUnique(manifest.known_gaps, 'known gap')

  for (const artifact of manifest.artifacts) assertArtifactInvariants(artifact)
  const artifacts = new Map(
    manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact] as const)
  )
  const knownGaps = new Set(manifest.known_gaps)
  for (const requiredGap of DEX_SOLANA_REQUIRED_KNOWN_GAPS) {
    if (!knownGaps.has(requiredGap)) {
      throw new Error(`Solana source seed is missing required known gap: ${requiredGap}`)
    }
  }

  const protocols = new Map(
    manifest.protocols.map((protocol) => [protocol.protocol_id, protocol] as const)
  )
  for (const targetId of DEX_SOLANA_TARGET_PROTOCOL_IDS) {
    const missingGap = `${targetId}_not_seeded`
    if (!protocols.has(targetId) && !knownGaps.has(missingGap)) {
      throw new Error(`Solana source seed must disclose missing target protocol: ${targetId}`)
    }
    if (protocols.has(targetId) && knownGaps.has(missingGap)) {
      throw new Error(`Solana source seed contradicts seeded target protocol: ${targetId}`)
    }
  }

  for (const protocol of manifest.protocols) {
    const protocolId = protocol.protocol_id as keyof typeof DEX_SOLANA_TARGET_PROTOCOLS
    const target = DEX_SOLANA_TARGET_PROTOCOLS[protocolId]
    if (
      target === undefined ||
      protocol.family !== target.family ||
      protocol.product !== target.product ||
      protocol.program_role !== target.program_role ||
      protocol.program_id !== target.program_id
    ) {
      throw new Error(
        `protocol identity does not match the target program map: ${protocol.protocol_id}`
      )
    }
    assertUnique(protocol.reference_artifact_ids, `reference artifact in ${protocol.protocol_id}`)
    for (const artifactId of protocol.reference_artifact_ids) {
      const artifact = artifacts.get(artifactId)
      if (artifact === undefined) {
        throw new Error(`protocol references a missing artifact: ${protocol.protocol_id}`)
      }
      if (!TARGET_PROTOCOL_REPOSITORIES[protocolId].includes(artifact.repository)) {
        throw new Error(
          `artifact repository does not belong to target protocol: ${protocol.protocol_id}`
        )
      }
      if (!artifact.declared_program_ids.includes(protocol.program_id)) {
        throw new Error(
          `referenced artifact does not declare the target program id: ${protocol.protocol_id}`
        )
      }
    }
    if (
      !protocol.reference_artifact_ids.includes(protocol.program_address_artifact_id) ||
      !artifacts
        .get(protocol.program_address_artifact_id)
        ?.evidence_roles.includes('program_identity_reference') ||
      !artifacts
        .get(protocol.program_address_artifact_id)
        ?.declared_program_ids.includes(protocol.program_id)
    ) {
      throw new Error(
        `program address artifact is not an identity reference: ${protocol.protocol_id}`
      )
    }
    assertRequiredBlockers(protocol, artifacts)
    assertDecoderFacts(protocol)
    assertLoaderEvidence(protocol)
  }
}

export function parseDexSolanaProtocolManifest(input: unknown): DexSolanaProtocolManifest {
  const manifest = manifestSchema.parse(input)
  assertManifestInvariants(manifest)
  return manifest
}

export function normalizeDexSolanaProtocolManifest(input: unknown): DexSolanaProtocolManifest {
  const manifest = parseDexSolanaProtocolManifest(input)
  return {
    ...manifest,
    artifacts: [...manifest.artifacts]
      .map((artifact) => ({
        ...artifact,
        evidence_roles: [...artifact.evidence_roles].sort(compareText),
        declared_program_ids: [...artifact.declared_program_ids].sort(compareText),
      }))
      .sort((left, right) => compareText(left.artifact_id, right.artifact_id)),
    known_gaps: [...manifest.known_gaps].sort(compareText),
    protocols: manifest.protocols
      .map((protocol) => ({
        ...protocol,
        reference_artifact_ids: [...protocol.reference_artifact_ids].sort(compareText),
        blocking_reasons: [...protocol.blocking_reasons].sort(compareText),
        loader_evidence:
          protocol.loader_evidence.state === 'not_verified'
            ? protocol.loader_evidence
            : {
                ...protocol.loader_evidence,
                observation_sources: [...protocol.loader_evidence.observation_sources].sort(
                  (left, right) => compareText(left.provider_id, right.provider_id)
                ),
              },
        decoder: {
          ...protocol.decoder,
          required_fact_families: [...protocol.decoder.required_fact_families].sort(compareText),
        },
      }))
      .sort((left, right) => compareText(left.protocol_id, right.protocol_id)),
  }
}

export function dexSolanaProtocolManifestSha256(input: unknown): string {
  return strictCanonicalSha256(normalizeDexSolanaProtocolManifest(input))
}
