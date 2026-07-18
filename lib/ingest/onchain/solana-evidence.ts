/**
 * Strict, shadow-only Solana mainnet chain evidence.
 *
 * A verified value from this module is a same-provider rooted RPC assertion;
 * it is not an independently replayed ledger or proof-of-history proof.
 */

import { createHash } from 'node:crypto'

import { hasBase58DecodedByteLength } from '@/lib/utils/base58'

import {
  DEFAULT_SOLANA_EVIDENCE_TIMEOUT_MS,
  canonicalTimestampMs,
  dependencyUnavailableLane,
  endpointCopy,
  exactDataRecord,
  isRecord,
  parseAvailableLane,
  parseOptsOrThrow,
  resolveEndpoint,
  safeNonNegativeInteger,
  sameEndpoint,
  solanaEvidenceRpc,
  unconfiguredLane,
  unavailableFromRpc,
  unavailableFromSuccess,
  type SolanaEvidenceEndpointIdentity,
  type SolanaEvidenceLane,
  type SolanaEvidenceRpcOpts,
  type SolanaRawRpcEvidenceExchange,
  type SolanaRpcResult,
} from './solana-evidence-core'

export type {
  SolanaEvidenceAvailable,
  SolanaEvidenceEndpointId,
  SolanaEvidenceEndpointIdentity,
  SolanaEvidenceLane,
  SolanaEvidenceProvider,
  SolanaEvidenceProviderId,
  SolanaEvidenceRpcOpts,
  SolanaEvidenceUnavailable,
  SolanaEvidenceUnavailableReason,
  SolanaRawRpcEvidenceExchange,
  SolanaRawRpcEvidenceLane,
} from './solana-evidence-core'

export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' as const

const MAX_FUTURE_BLOCK_SKEW_MS = 60_000
const MAX_CURRENT_ANCHOR_LAG_MS = 900_000
const SOLANA_BLOCK_UNAVAILABLE_RPC_CODES = new Set([
  -32_001, // block cleaned up
  -32_004, // block not available
  -32_007, // slot skipped
  -32_009, // long-term storage slot skipped
  -32_011, // transaction history unavailable
  -32_014, // block status not available yet
  -32_019, // long-term storage unreachable
])

export interface SolanaFinalizedBlockEvidence {
  /** Requested finalized slot; getBlock does not repeat it in the result. */
  slot: number
  blockhash: string
  previousBlockhash: string
  parentSlot: number
  /** Officially nullable stake-weighted estimate. */
  blockTime: number | null
  /** Officially nullable ledger block height. */
  blockHeight: number | null
}

export interface SolanaChainAnchorEvidence {
  chain: {
    cluster: 'mainnet-beta'
    genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  }
  /** Local capture completion time; never presented as chain time. */
  observedAt: string
  anchorPolicy: {
    version: 'solana_current_finalized_block_v1'
    genesisMethod: 'getGenesisHash'
    slotMethod: 'getSlot'
    blockMethod: 'getBlock'
    commitment: 'finalized'
    encoding: 'json'
    transactionDetails: 'none'
    maxSupportedTransactionVersion: 0
    rewards: false
    maxFutureBlockSkewMs: 60_000
    maxCurrentAnchorLagMs: 900_000
  }
  genesisHash: SolanaEvidenceLane<typeof SOLANA_MAINNET_GENESIS_HASH>
  finalizedSlot: SolanaEvidenceLane<number>
  finalizedBlock: SolanaEvidenceLane<SolanaFinalizedBlockEvidence>
}

export interface SolanaVerifiedChainAnchor {
  chain: {
    cluster: 'mainnet-beta'
    genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  }
  anchorPolicy: SolanaChainAnchorEvidence['anchorPolicy']
  endpoint: SolanaEvidenceEndpointIdentity
  observedAt: string
  genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  finalizedSlot: number
  finalizedBlock: SolanaFinalizedBlockEvidence
  semanticHashPolicy: 'solana_verified_anchor_semantics_v1'
  semanticHash: string
}

function genesisLane(
  result: SolanaRpcResult
): SolanaEvidenceLane<typeof SOLANA_MAINNET_GENESIS_HASH> {
  if (!result.ok) return unavailableFromRpc(result)
  if (typeof result.result !== 'string' || !hasBase58DecodedByteLength(result.result, 32)) {
    return unavailableFromSuccess(result, 'malformed_response')
  }
  if (result.result !== SOLANA_MAINNET_GENESIS_HASH) {
    return unavailableFromSuccess(result, 'wrong_genesis')
  }
  return {
    status: 'available',
    value: SOLANA_MAINNET_GENESIS_HASH,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function slotLane(result: SolanaRpcResult): SolanaEvidenceLane<number> {
  if (!result.ok) return unavailableFromRpc(result)
  const slot = safeNonNegativeInteger(result.result)
  if (slot === null) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: slot,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function parseFinalizedBlock(value: unknown, slot: number): SolanaFinalizedBlockEvidence | null {
  if (!isRecord(value)) return null
  const blockhash = value.blockhash
  const previousBlockhash = value.previousBlockhash
  const parentSlot = safeNonNegativeInteger(value.parentSlot)
  const blockTime = value.blockTime === null ? null : safeNonNegativeInteger(value.blockTime)
  const blockHeight = value.blockHeight === null ? null : safeNonNegativeInteger(value.blockHeight)
  if (
    typeof blockhash !== 'string' ||
    !hasBase58DecodedByteLength(blockhash, 32) ||
    typeof previousBlockhash !== 'string' ||
    !hasBase58DecodedByteLength(previousBlockhash, 32) ||
    blockhash === previousBlockhash ||
    parentSlot === null ||
    parentSlot >= slot ||
    !Object.hasOwn(value, 'blockTime') ||
    (value.blockTime !== null && blockTime === null) ||
    !Object.hasOwn(value, 'blockHeight') ||
    (value.blockHeight !== null && blockHeight === null)
  ) {
    return null
  }
  return { slot, blockhash, previousBlockhash, parentSlot, blockTime, blockHeight }
}

function blockLane(
  result: SolanaRpcResult,
  slot: number
): SolanaEvidenceLane<SolanaFinalizedBlockEvidence> {
  if (!result.ok) {
    const unavailable = unavailableFromRpc(result)
    return result.rpcCode !== null && SOLANA_BLOCK_UNAVAILABLE_RPC_CODES.has(result.rpcCode)
      ? { ...unavailable, reason: 'not_found_or_unavailable' }
      : unavailable
  }
  if (result.result === null) {
    return unavailableFromSuccess(result, 'not_found_or_unavailable')
  }
  const block = parseFinalizedBlock(result.result, slot)
  if (!block) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: block,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function parseExactFinalizedBlock(value: unknown): SolanaFinalizedBlockEvidence | null {
  const block = exactDataRecord(value, [
    'slot',
    'blockhash',
    'previousBlockhash',
    'parentSlot',
    'blockTime',
    'blockHeight',
  ])
  if (!block) return null
  const slot = safeNonNegativeInteger(block.slot)
  if (slot === null) return null
  const parsed = parseFinalizedBlock(block, slot)
  if (
    !parsed ||
    block.slot !== parsed.slot ||
    block.blockhash !== parsed.blockhash ||
    block.previousBlockhash !== parsed.previousBlockhash ||
    block.parentSlot !== parsed.parentSlot ||
    block.blockTime !== parsed.blockTime ||
    block.blockHeight !== parsed.blockHeight
  ) {
    return null
  }
  return parsed
}

function unixTimestampMs(value: number | null): number | null {
  if (value === null) return null
  const milliseconds = BigInt(value) * 1000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null
}

function copyFinalizedBlock(block: SolanaFinalizedBlockEvidence): SolanaFinalizedBlockEvidence {
  return {
    slot: block.slot,
    blockhash: block.blockhash,
    previousBlockhash: block.previousBlockhash,
    parentSlot: block.parentSlot,
    blockTime: block.blockTime,
    blockHeight: block.blockHeight,
  }
}

function solanaAnchorSemanticHash(
  endpoint: SolanaEvidenceEndpointIdentity,
  observedAt: string,
  block: SolanaFinalizedBlockEvidence
): string {
  const fields = [
    'solana_verified_anchor_semantics_v1',
    'mainnet-beta',
    SOLANA_MAINNET_GENESIS_HASH,
    'solana_current_finalized_block_v1',
    'getGenesisHash',
    'getSlot',
    'getBlock',
    'finalized',
    'json',
    'none',
    0,
    false,
    MAX_FUTURE_BLOCK_SKEW_MS,
    MAX_CURRENT_ANCHOR_LAG_MS,
    endpoint.providerId,
    endpoint.endpointId,
    endpoint.connectionHash,
    observedAt,
    block.slot,
    block.blockhash,
    block.previousBlockhash,
    block.parentSlot,
    block.blockTime,
    block.blockHeight,
  ]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function invalidVerifiedAnchor(): never {
  throw new TypeError('Solana chain anchor is not fully verified')
}

function requireSolanaVerifiedChainAnchorInternal(evidence: unknown): SolanaVerifiedChainAnchor {
  const root = exactDataRecord(evidence, [
    'chain',
    'observedAt',
    'anchorPolicy',
    'genesisHash',
    'finalizedSlot',
    'finalizedBlock',
  ])
  if (!root) return invalidVerifiedAnchor()
  const chain = exactDataRecord(root.chain, ['cluster', 'genesisHash'])
  const policy = exactDataRecord(root.anchorPolicy, [
    'version',
    'genesisMethod',
    'slotMethod',
    'blockMethod',
    'commitment',
    'encoding',
    'transactionDetails',
    'maxSupportedTransactionVersion',
    'rewards',
    'maxFutureBlockSkewMs',
    'maxCurrentAnchorLagMs',
  ])
  const genesisLaneValue = parseAvailableLane(root.genesisHash)
  const slotLaneValue = parseAvailableLane(root.finalizedSlot)
  const blockLaneValue = parseAvailableLane(root.finalizedBlock)
  const finalizedSlot = slotLaneValue ? safeNonNegativeInteger(slotLaneValue.value) : null
  const finalizedBlock = blockLaneValue ? parseExactFinalizedBlock(blockLaneValue.value) : null
  const observedAtMs = canonicalTimestampMs(root.observedAt)
  const blockTimeMs = unixTimestampMs(finalizedBlock?.blockTime ?? null)
  if (
    !chain ||
    chain.cluster !== 'mainnet-beta' ||
    chain.genesisHash !== SOLANA_MAINNET_GENESIS_HASH ||
    !policy ||
    policy.version !== 'solana_current_finalized_block_v1' ||
    policy.genesisMethod !== 'getGenesisHash' ||
    policy.slotMethod !== 'getSlot' ||
    policy.blockMethod !== 'getBlock' ||
    policy.commitment !== 'finalized' ||
    policy.encoding !== 'json' ||
    policy.transactionDetails !== 'none' ||
    policy.maxSupportedTransactionVersion !== 0 ||
    policy.rewards !== false ||
    policy.maxFutureBlockSkewMs !== MAX_FUTURE_BLOCK_SKEW_MS ||
    policy.maxCurrentAnchorLagMs !== MAX_CURRENT_ANCHOR_LAG_MS ||
    !genesisLaneValue ||
    genesisLaneValue.value !== SOLANA_MAINNET_GENESIS_HASH ||
    !slotLaneValue ||
    finalizedSlot === null ||
    finalizedSlot <= 0 ||
    !blockLaneValue ||
    !finalizedBlock ||
    finalizedBlock.slot !== finalizedSlot ||
    (finalizedBlock.blockHeight !== null && finalizedBlock.blockHeight > finalizedSlot) ||
    observedAtMs === null ||
    blockTimeMs === null ||
    blockTimeMs > observedAtMs + MAX_FUTURE_BLOCK_SKEW_MS ||
    observedAtMs - blockTimeMs > MAX_CURRENT_ANCHOR_LAG_MS ||
    !sameEndpoint(genesisLaneValue.endpoint, slotLaneValue.endpoint) ||
    !sameEndpoint(genesisLaneValue.endpoint, blockLaneValue.endpoint)
  ) {
    return invalidVerifiedAnchor()
  }
  const endpoint = endpointCopy(genesisLaneValue.endpoint)
  const observedAt = new Date(observedAtMs).toISOString()
  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    anchorPolicy: {
      version: 'solana_current_finalized_block_v1',
      genesisMethod: 'getGenesisHash',
      slotMethod: 'getSlot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    },
    endpoint,
    observedAt,
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    finalizedSlot,
    finalizedBlock: copyFinalizedBlock(finalizedBlock),
    semanticHashPolicy: 'solana_verified_anchor_semantics_v1',
    semanticHash: solanaAnchorSemanticHash(endpoint, observedAt, finalizedBlock),
  }
}

/**
 * Deterministically revalidate capture-time freshness. This deliberately does
 * not consult Date.now(); callers needing present-time freshness must compare
 * observedAt with their own trusted clock before using a stored anchor.
 */
export function requireSolanaVerifiedChainAnchor(evidence: unknown): SolanaVerifiedChainAnchor {
  try {
    return requireSolanaVerifiedChainAnchorInternal(evidence)
  } catch {
    return invalidVerifiedAnchor()
  }
}

/**
 * Capture one mainnet identity + highest finalized slot/block observation from
 * one resolved endpoint. Provider failover requires restarting this function.
 * Never expose the local-node endpoint option directly to untrusted callers.
 */
async function fetchSolanaChainAnchorEvidenceInternal(
  opts: SolanaEvidenceRpcOpts,
  captureRaw: boolean
): Promise<{
  evidence: SolanaChainAnchorEvidence
  rawExchanges: SolanaRawRpcEvidenceExchange[]
}> {
  const parsedOpts = parseOptsOrThrow(opts)
  const endpoint = resolveEndpoint(parsedOpts)
  const base = {
    chain: {
      cluster: 'mainnet-beta',
      genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    } as const,
    anchorPolicy: {
      version: 'solana_current_finalized_block_v1',
      genesisMethod: 'getGenesisHash',
      slotMethod: 'getSlot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    } as const,
  }
  if (!endpoint) {
    return {
      evidence: {
        ...base,
        observedAt: new Date().toISOString(),
        genesisHash: unconfiguredLane(),
        finalizedSlot: unconfiguredLane(),
        finalizedBlock: unconfiguredLane(),
      },
      rawExchanges: [],
    }
  }

  const timeoutMs = parsedOpts.timeoutMs ?? DEFAULT_SOLANA_EVIDENCE_TIMEOUT_MS
  const [genesisResult, slotResult] = await Promise.all([
    solanaEvidenceRpc(
      endpoint,
      'getGenesisHash',
      [],
      timeoutMs,
      captureRaw ? { lane: 'genesis_hash' } : undefined
    ),
    solanaEvidenceRpc(
      endpoint,
      'getSlot',
      [{ commitment: 'finalized' }],
      timeoutMs,
      captureRaw ? { lane: 'finalized_anchor_slot' } : undefined
    ),
  ])
  const genesisHash = genesisLane(genesisResult)
  const finalizedSlot = slotLane(slotResult)
  let finalizedBlock: SolanaEvidenceLane<SolanaFinalizedBlockEvidence> = dependencyUnavailableLane()
  let blockResult: SolanaRpcResult | null = null
  if (finalizedSlot.status === 'available') {
    blockResult = await solanaEvidenceRpc(
      endpoint,
      'getBlock',
      [
        finalizedSlot.value,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'none',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        },
      ],
      timeoutMs,
      captureRaw ? { lane: 'finalized_anchor_block' } : undefined
    )
    finalizedBlock = blockLane(blockResult, finalizedSlot.value)
  }

  return {
    evidence: {
      ...base,
      observedAt: new Date().toISOString(),
      genesisHash,
      finalizedSlot,
      finalizedBlock,
    },
    rawExchanges: captureRaw
      ? [genesisResult, slotResult, blockResult]
          .map((result) => (result?.ok ? result.rawExchange : undefined))
          .filter((exchange): exchange is SolanaRawRpcEvidenceExchange => exchange !== undefined)
      : [],
  }
}

export async function fetchSolanaChainAnchorEvidence(
  opts: SolanaEvidenceRpcOpts = {}
): Promise<SolanaChainAnchorEvidence> {
  return (await fetchSolanaChainAnchorEvidenceInternal(opts, false)).evidence
}

export interface SolanaVerifiedChainAnchorRawCapture {
  evidence: SolanaChainAnchorEvidence
  verified: SolanaVerifiedChainAnchor
  rawExchanges: SolanaRawRpcEvidenceExchange[]
}

/**
 * Capture the exact same response bytes consumed by the strict anchor
 * verifier. Nothing is persisted here; callers must separately scan and
 * authorize any raw artifact storage.
 */
export async function captureSolanaVerifiedChainAnchorEvidence(
  opts: SolanaEvidenceRpcOpts = {}
): Promise<SolanaVerifiedChainAnchorRawCapture> {
  const captured = await fetchSolanaChainAnchorEvidenceInternal(opts, true)
  const verified = requireSolanaVerifiedChainAnchor(captured.evidence)
  const expectedLanes = ['genesis_hash', 'finalized_anchor_slot', 'finalized_anchor_block'] as const
  if (
    captured.rawExchanges.length !== expectedLanes.length ||
    captured.rawExchanges.some((exchange, index) => exchange.lane !== expectedLanes[index])
  ) {
    throw new TypeError('Solana anchor raw evidence capture is incomplete')
  }
  return { evidence: captured.evidence, verified, rawExchanges: captured.rawExchanges }
}
