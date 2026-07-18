import { createHash } from 'node:crypto'

import {
  captureSolanaVerifiedChainAnchorEvidence,
  type SolanaEvidenceEndpointId,
  type SolanaEvidenceRpcOpts,
  type SolanaVerifiedChainAnchorRawCapture,
} from '../../lib/ingest/onchain/solana-evidence'
import {
  captureSolanaVerifiedTransactionFinalityEvidence,
  type SolanaVerifiedTransactionFinalityRawCapture,
} from '../../lib/ingest/onchain/solana-transaction-evidence'
import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { hasBase58DecodedByteLength } from '../../lib/utils/base58'
import manifestJson from '../fixtures/dex-solana-protocol-manifest.v1.json'
import { dexGoldenRpcEvidenceSha256, parseDexGoldenRpcEvidence } from './dex-golden-rpc-evidence'
import {
  buildDexSolanaGoldenProtocolCaseV2Bundle,
  parseDexSolanaGoldenProtocolCaseV2,
  type DexSolanaGoldenProtocolCaseV2Bundle,
} from './dex-solana-golden-protocol-case-v2'
import {
  disposeDexSolanaGoldenRpcMetadataInputBytes,
  type DexSolanaGoldenRpcMetadataCaptureInput,
} from './dex-solana-golden-rpc-metadata'

export const DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID = 'jupiter_swap_v6' as const
export const DEX_SOLANA_JUPITER_WITNESS_PROGRAM_ID =
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as const
export const DEX_SOLANA_JUPITER_WITNESS_MANIFEST_SHA256 =
  '10e000a4b625c90da571374bdc3567e86ac01a632d1a7803da69018677d77f9a' as const

export const DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_ARGUMENTS: 64,
  WITNESS_REJECTED: 65,
  OUTPUT_UNAVAILABLE: 70,
} as const)

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'api_key',
  'apikey',
  'blob_locator',
  'body',
  'bytes',
  'client_secret',
  'credential',
  'headers',
  'password',
  'private_key',
  'rpc_url',
  'secret',
  'token',
  'url',
])

const FORBIDDEN_OUTPUT_TEXT = [
  /https?:\/\//iu,
  /\bbearer\s+[a-z0-9._~+/-]{8,}=*/iu,
  /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/iu,
  /\b(?:pk|rk|sk)_live_[a-z0-9]{8,}\b/iu,
] as const

type WitnessExitCode =
  (typeof DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES)[keyof typeof DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES]

type WitnessExpectedBinding = Readonly<{
  signature: string
  generatedAt: string
  caseId: string
}>

type WitnessEndpoint = Readonly<{
  endpointId: Extract<
    SolanaEvidenceEndpointId,
    'publicnode_solana_mainnet' | 'solana_official_mainnet'
  >
  rpcUrl: string
}>

const WITNESS_ENDPOINTS: readonly [WitnessEndpoint, WitnessEndpoint] = Object.freeze([
  Object.freeze({
    endpointId: 'publicnode_solana_mainnet',
    rpcUrl: 'https://solana-rpc.publicnode.com',
  }),
  Object.freeze({
    endpointId: 'solana_official_mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
  }),
])

export type DexSolanaJupiterWitnessCliIo = Readonly<{
  writeStdout: (line: string) => void
  writeStderr: (line: string) => void
}>

export type DexSolanaJupiterWitnessDependencies = Readonly<{
  now: () => Date
  captureAnchor: (opts: SolanaEvidenceRpcOpts) => Promise<SolanaVerifiedChainAnchorRawCapture>
  captureTransaction: (
    signature: string,
    anchorEvidence: unknown,
    opts: SolanaEvidenceRpcOpts
  ) => Promise<SolanaVerifiedTransactionFinalityRawCapture>
  buildBundle: typeof buildDexSolanaGoldenProtocolCaseV2Bundle
  parseRpcEvidence: typeof parseDexGoldenRpcEvidence
  parseProtocolCase: typeof parseDexSolanaGoldenProtocolCaseV2
  rpcEvidenceSha256: typeof dexGoldenRpcEvidenceSha256
  disposeBytes: (input: unknown) => void
}>

const DEFAULT_DEPENDENCIES: DexSolanaJupiterWitnessDependencies = Object.freeze({
  now: () => new Date(),
  captureAnchor: captureSolanaVerifiedChainAnchorEvidence,
  captureTransaction: captureSolanaVerifiedTransactionFinalityEvidence,
  buildBundle: buildDexSolanaGoldenProtocolCaseV2Bundle,
  parseRpcEvidence: parseDexGoldenRpcEvidence,
  parseProtocolCase: parseDexSolanaGoldenProtocolCaseV2,
  rpcEvidenceSha256: dexGoldenRpcEvidenceSha256,
  disposeBytes: disposeDexSolanaGoldenRpcMetadataInputBytes,
})

function parseSignatureArgument(args: unknown): string | null {
  if (
    !Array.isArray(args) ||
    args.length !== 2 ||
    args[0] !== '--signature' ||
    typeof args[1] !== 'string' ||
    !hasBase58DecodedByteLength(args[1], 64)
  ) {
    return null
  }
  return args[1]
}

function witnessCaseId(signature: string): string {
  return `solana-jupiter-explicit-${createHash('sha256').update(signature).digest('hex').slice(0, 24)}`
}

function canonicalNow(dependencies: DexSolanaJupiterWitnessDependencies): string {
  const now = dependencies.now()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('witness clock did not return a valid date')
  }
  return now.toISOString()
}

function normalizeOutputKey(key: string): string {
  return key.replace(/[-\s]/gu, '_').toLowerCase()
}

function assertMetadataOnlyOutput(value: unknown, seen = new Set<object>()): void {
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new TypeError('witness output contains a non-JSON value')
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_OUTPUT_TEXT.some((pattern) => pattern.test(value))) {
      throw new TypeError('witness output contains forbidden transport or credential text')
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('witness output contains a non-canonical number')
    }
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('witness output contains binary data')
  }
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('witness output contains a sparse array or accessor')
      }
      assertMetadataOnlyOutput(descriptor.value, seen)
    }
    const allowedKeys = new Set([...value.keys()].map(String).concat('length'))
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
      throw new TypeError('witness output contains non-canonical array fields')
    }
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('witness output contains a non-plain object')
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('witness output contains symbol keys')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('witness output contains accessors or hidden fields')
    }
    if (FORBIDDEN_OUTPUT_KEYS.has(normalizeOutputKey(key))) {
      throw new TypeError('witness output contains forbidden raw transport fields')
    }
    assertMetadataOnlyOutput(descriptor.value, seen)
  }
}

function assertAllAuthorizationsClosed(bundle: DexSolanaGoldenProtocolCaseV2Bundle): void {
  const expectedKeys = [
    'decoder_fixture',
    'network_execution',
    'rank',
    'raw_blob_persistence',
    'score',
    'serving',
  ]
  const authorizations = [
    bundle.golden_rpc_evidence.authorization,
    bundle.golden_protocol_case.authorization,
  ]
  for (const authorization of authorizations) {
    const keys = Object.keys(authorization).sort()
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      expectedKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(authorization, key)
        return (
          !descriptor ||
          !descriptor.enumerable ||
          !('value' in descriptor) ||
          descriptor.value !== false
        )
      })
    ) {
      throw new TypeError('witness output attempted to authorize a downstream capability')
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertBundleClosure(
  bundle: DexSolanaGoldenProtocolCaseV2Bundle,
  dependencies: DexSolanaJupiterWitnessDependencies,
  expected: WitnessExpectedBinding
): void {
  const evidence = bundle.golden_rpc_evidence
  const protocolCase = bundle.golden_protocol_case
  const binding = protocolCase.golden_rpc_evidence
  const evidenceSha256 = dependencies.rpcEvidenceSha256(evidence)
  if (
    evidence.transaction_id !== expected.signature ||
    evidence.generated_at !== expected.generatedAt ||
    protocolCase.generated_at !== expected.generatedAt ||
    protocolCase.case.case_id !== expected.caseId ||
    binding.canonical_sha256 !== evidenceSha256 ||
    binding.generated_at !== evidence.generated_at ||
    binding.verification_state !== evidence.verification_state ||
    binding.transaction_id !== evidence.transaction_id ||
    binding.stable_facts_contract !== evidence.stable_transaction_facts_contract ||
    binding.stable_facts_sha256 !== evidence.stable_transaction_facts_sha256 ||
    !sameStrings(binding.source_evidence_blockers, evidence.required_blockers) ||
    protocolCase.common_transaction_membership.stable_transaction_facts_sha256 !==
      evidence.stable_transaction_facts_sha256 ||
    protocolCase.common_program_hit_projection.signature !== evidence.transaction_id ||
    protocolCase.chain.namespace !== evidence.chain.namespace ||
    protocolCase.chain.cluster !== evidence.chain.cluster ||
    protocolCase.chain.genesis_hash !== evidence.chain.genesis_hash ||
    protocolCase.chain.product_source_slug !== evidence.chain.product_source_slug ||
    protocolCase.chain.chain_stream_slug !== evidence.chain.chain_stream_slug ||
    protocolCase.protocol_manifest.protocol_id !== DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID ||
    protocolCase.protocol_manifest.canonical_sha256 !==
      DEX_SOLANA_JUPITER_WITNESS_MANIFEST_SHA256 ||
    protocolCase.protocol_manifest.manifest_declared_program_id !==
      DEX_SOLANA_JUPITER_WITNESS_PROGRAM_ID ||
    protocolCase.source_derivations.some(
      (source) => source.golden_rpc_evidence_sha256 !== evidenceSha256
    )
  ) {
    throw new TypeError('witness bundle documents do not form one closed evidence pair')
  }
}

function normalizeSafeBundle(
  bundle: DexSolanaGoldenProtocolCaseV2Bundle,
  dependencies: DexSolanaJupiterWitnessDependencies,
  expected: WitnessExpectedBinding
): DexSolanaGoldenProtocolCaseV2Bundle {
  assertMetadataOnlyOutput(bundle)
  const normalized = {
    golden_rpc_evidence: dependencies.parseRpcEvidence(bundle.golden_rpc_evidence),
    golden_protocol_case: dependencies.parseProtocolCase(bundle.golden_protocol_case),
  }
  assertBundleClosure(normalized, dependencies, expected)
  assertAllAuthorizationsClosed(normalized)
  assertMetadataOnlyOutput(normalized)
  return normalized
}

function serializeSafeBundle(
  bundle: DexSolanaGoldenProtocolCaseV2Bundle,
  dependencies: DexSolanaJupiterWitnessDependencies,
  expected: WitnessExpectedBinding
): string {
  const normalized = normalizeSafeBundle(bundle, dependencies, expected)
  const serialized = JSON.stringify(normalized)
  const reparsed = parseStrictJson(serialized)
  assertMetadataOnlyOutput(reparsed)
  return `${serialized}\n`
}

async function captureEndpoint(
  endpoint: WitnessEndpoint,
  signature: string,
  dependencies: DexSolanaJupiterWitnessDependencies
): Promise<DexSolanaGoldenRpcMetadataCaptureInput> {
  const opts: SolanaEvidenceRpcOpts = {
    rpcUrl: endpoint.rpcUrl,
    endpointId: endpoint.endpointId,
  }
  let anchor: SolanaVerifiedChainAnchorRawCapture | undefined
  try {
    anchor = await dependencies.captureAnchor(opts)
    const transaction = await dependencies.captureTransaction(signature, anchor.evidence, opts)
    return { anchor, transaction }
  } catch (error) {
    if (anchor !== undefined) dependencies.disposeBytes(anchor)
    throw error
  }
}

async function captureBothEndpoints(
  signature: string,
  dependencies: DexSolanaJupiterWitnessDependencies
): Promise<
  readonly [DexSolanaGoldenRpcMetadataCaptureInput, DexSolanaGoldenRpcMetadataCaptureInput]
> {
  const settled = await Promise.allSettled(
    WITNESS_ENDPOINTS.map((endpoint) => captureEndpoint(endpoint, signature, dependencies))
  )
  const captures = settled
    .filter(
      (result): result is PromiseFulfilledResult<DexSolanaGoldenRpcMetadataCaptureInput> =>
        result.status === 'fulfilled'
    )
    .map((result) => result.value)
  if (settled.some((result) => result.status === 'rejected')) {
    dependencies.disposeBytes(captures)
    throw new Error('one or more pinned Solana witness sources rejected the request')
  }
  if (captures.length !== 2) {
    dependencies.disposeBytes(captures)
    throw new Error('both pinned Solana witness sources are required')
  }
  return captures as [
    DexSolanaGoldenRpcMetadataCaptureInput,
    DexSolanaGoldenRpcMetadataCaptureInput,
  ]
}

export async function runDexSolanaJupiterWitnessCli(
  args: unknown,
  io: DexSolanaJupiterWitnessCliIo,
  dependencies: DexSolanaJupiterWitnessDependencies = DEFAULT_DEPENDENCIES
): Promise<WitnessExitCode> {
  const signature = parseSignatureArgument(args)
  if (signature === null) {
    io.writeStderr('jupiter_witness_invalid_arguments\n')
    return DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.INVALID_ARGUMENTS
  }

  let captures:
    | readonly [DexSolanaGoldenRpcMetadataCaptureInput, DexSolanaGoldenRpcMetadataCaptureInput]
    | undefined
  try {
    captures = await captureBothEndpoints(signature, dependencies)
    const generatedAt = canonicalNow(dependencies)
    const caseId = witnessCaseId(signature)
    const bundle = dependencies.buildBundle({
      generated_at: generatedAt,
      case_id: caseId,
      protocol_id: DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID,
      manifest_input: manifestJson,
      metadata_input: {
        generated_at: generatedAt,
        captures,
      },
    })
    const line = serializeSafeBundle(bundle, dependencies, {
      signature,
      generatedAt,
      caseId,
    })
    // The bundle compiler already clears its owned raw arrays. Re-run the
    // destructive verifier before stdout so a future builder regression can
    // never publish a document while capture bytes remain live.
    dependencies.disposeBytes(captures)
    io.writeStdout(line)
    return DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.SUCCESS
  } catch {
    io.writeStderr('jupiter_witness_rejected\n')
    return DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED
  } finally {
    if (captures !== undefined) dependencies.disposeBytes(captures)
  }
}
