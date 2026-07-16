/**
 * Strict, shadow-only Solana transaction finality evidence.
 *
 * A verified value is a same-provider rooted RPC assertion. It binds one
 * finalized getTransaction response to the matching finalized signature
 * status, the transaction's unique position in a block signature projection,
 * and a separately verified Solana chain anchor. It is not an independently
 * replayed ledger, proof-of-history proof, or cryptographic inclusion proof.
 */

import { createHash } from 'node:crypto'

import { hasBase58DecodedByteLength } from '@/lib/utils/base58'

import {
  DEFAULT_SOLANA_EVIDENCE_TIMEOUT_MS,
  canonicalTimestampMs,
  dependencyUnavailableLane,
  endpointCopy,
  exactDataRecord,
  exactDenseArray,
  isRecord,
  parseApprovedEndpoint,
  parseAvailableLane,
  parseOptsOrThrow,
  resolveEndpoint,
  sameEndpoint,
  solanaEvidenceRpc,
  unavailableFromRpc,
  unavailableFromSuccess,
  type SolanaEvidenceEndpointIdentity,
  type SolanaEvidenceLane,
  type SolanaEvidenceRpcOpts,
  type SolanaRpcFailure,
  type SolanaRpcResult,
} from './solana-evidence-core'
import {
  SOLANA_MAINNET_GENESIS_HASH,
  requireSolanaVerifiedChainAnchor,
  type SolanaFinalizedBlockEvidence,
  type SolanaVerifiedChainAnchor,
} from './solana-evidence'

const MAX_FUTURE_BLOCK_SKEW_MS = 60_000
const MAX_TRANSACTION_SIGNATURES = 255
const MAX_BLOCK_SIGNATURES = 32_768
const MAX_U8 = 255
const MAX_U32 = 4_294_967_295
const SOLANA_HISTORY_UNAVAILABLE_RPC_CODES = new Set([-32_011, -32_019])
const SOLANA_BLOCK_UNAVAILABLE_RPC_CODES = new Set([
  -32_001, -32_004, -32_007, -32_009, -32_011, -32_014, -32_019,
])

const TRANSACTION_ERROR_UNITS = new Set([
  'AccountInUse',
  'AccountLoadedTwice',
  'AccountNotFound',
  'ProgramAccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'AlreadyProcessed',
  'BlockhashNotFound',
  'CallChainTooDeep',
  'MissingSignatureForFee',
  'InvalidAccountIndex',
  'SignatureFailure',
  'InvalidProgramForExecution',
  'SanitizeFailure',
  'ClusterMaintenance',
  'AccountBorrowOutstanding',
  'WouldExceedMaxBlockCostLimit',
  'UnsupportedVersion',
  'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks',
  'AddressLookupTableNotFound',
  'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex',
  'InvalidRentPayingAccount',
  'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataTotalLimit',
  'MaxLoadedAccountsDataSizeExceeded',
  'InvalidLoadedAccountsDataSizeLimit',
  'ResanitizationNeeded',
  'UnbalancedTransaction',
  'ProgramCacheHitMaxLimit',
  'CommitCancelled',
])

const INSTRUCTION_ERROR_UNITS = new Set([
  'GenericError',
  'InvalidArgument',
  'InvalidInstructionData',
  'InvalidAccountData',
  'AccountDataTooSmall',
  'InsufficientFunds',
  'IncorrectProgramId',
  'MissingRequiredSignature',
  'AccountAlreadyInitialized',
  'UninitializedAccount',
  'UnbalancedInstruction',
  'ModifiedProgramId',
  'ExternalAccountLamportSpend',
  'ExternalAccountDataModified',
  'ReadonlyLamportChange',
  'ReadonlyDataModified',
  'DuplicateAccountIndex',
  'ExecutableModified',
  'RentEpochModified',
  'NotEnoughAccountKeys',
  'AccountDataSizeChanged',
  'AccountNotExecutable',
  'AccountBorrowFailed',
  'AccountBorrowOutstanding',
  'DuplicateAccountOutOfSync',
  'InvalidError',
  'ExecutableDataModified',
  'ExecutableLamportChange',
  'ExecutableAccountNotRentExempt',
  'UnsupportedProgramId',
  'CallDepth',
  'MissingAccount',
  'ReentrancyNotAllowed',
  'MaxSeedLengthExceeded',
  'InvalidSeeds',
  'InvalidRealloc',
  'ComputationalBudgetExceeded',
  'PrivilegeEscalation',
  'ProgramEnvironmentSetupFailure',
  'ProgramFailedToComplete',
  'ProgramFailedToCompile',
  'Immutable',
  'IncorrectAuthority',
  'BorshIoError',
  'AccountNotRentExempt',
  'InvalidAccountOwner',
  'ArithmeticOverflow',
  'UnsupportedSysvar',
  'IllegalOwner',
  'MaxAccountsDataAllocationsExceeded',
  'MaxAccountsExceeded',
  'MaxInstructionTraceLengthExceeded',
  'BuiltinProgramsMustConsumeComputeUnits',
])

export type SolanaCanonicalInstructionError = string | { Custom: number }

export type SolanaCanonicalTransactionError =
  | string
  | { DuplicateInstruction: number }
  | { InstructionError: [number, SolanaCanonicalInstructionError] }
  | { InsufficientFundsForRent: { account_index: number } }
  | { ProgramExecutionTemporarilyRestricted: { account_index: number } }

export type SolanaCanonicalTransactionStatus =
  | { Ok: null }
  | { Err: SolanaCanonicalTransactionError }

export interface SolanaFinalizedTransactionEvidence {
  slot: number
  blockTime: number | null
  version: 'legacy' | 0
  signatures: string[]
  /** Agave v4 supplies this; older validators legitimately omit it. */
  reportedTransactionIndex: number | null
  err: SolanaCanonicalTransactionError | null
  status: SolanaCanonicalTransactionStatus
}

export interface SolanaFinalizedSignatureStatusEvidence {
  contextSlot: number
  slot: number
  confirmations: null
  confirmationStatus: 'finalized'
  err: SolanaCanonicalTransactionError | null
  status: SolanaCanonicalTransactionStatus
}

export interface SolanaBlockSignatureMembershipEvidence extends SolanaFinalizedBlockEvidence {
  signatures: string[]
}

export interface SolanaTransactionMembershipPolicy {
  version: 'solana_transaction_membership_v1'
  transactionMethod: 'getTransaction'
  signatureStatusMethod: 'getSignatureStatuses'
  blockMethod: 'getBlock'
  commitment: 'finalized'
  encoding: 'json'
  maxSupportedTransactionVersion: 0
  searchTransactionHistory: true
  blockTransactionDetails: 'signatures'
  /** Intentionally omitted from the signature-only block request. */
  blockMaxSupportedTransactionVersion: null
  rewards: false
  maxFutureBlockSkewMs: 60_000
}

export interface SolanaTransactionAnchorBinding {
  endpoint: SolanaEvidenceEndpointIdentity
  verifiedAnchorHashPolicy: 'solana_verified_anchor_semantics_v1'
  verifiedAnchorHash: string
  observedAt: string
  anchorPolicy: SolanaVerifiedChainAnchor['anchorPolicy']
  finalizedSlot: number
  finalizedBlock: SolanaFinalizedBlockEvidence
}

export interface SolanaTransactionMembershipEvidence {
  chain: {
    cluster: 'mainnet-beta'
    genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  }
  signature: string
  /** Local capture completion time; never presented as chain time. */
  capturedAt: string
  membershipPolicy: SolanaTransactionMembershipPolicy
  anchor: SolanaTransactionAnchorBinding
  transaction: SolanaEvidenceLane<SolanaFinalizedTransactionEvidence>
  signatureStatus: SolanaEvidenceLane<SolanaFinalizedSignatureStatusEvidence>
  canonicalBlock: SolanaEvidenceLane<SolanaBlockSignatureMembershipEvidence>
}

export interface SolanaVerifiedTransactionFinality {
  chain: SolanaTransactionMembershipEvidence['chain']
  signature: string
  capturedAt: string
  membershipPolicy: SolanaTransactionMembershipPolicy
  anchor: SolanaTransactionAnchorBinding
  transaction: SolanaFinalizedTransactionEvidence
  signatureStatus: SolanaFinalizedSignatureStatusEvidence
  canonicalBlock: SolanaBlockSignatureMembershipEvidence
  /** Unique zero-based position in canonicalBlock.signatures. */
  transactionIndex: number
  executionStatus: 'succeeded' | 'failed'
  /** Execution/finality gate only; it does not prove a DEX protocol hit. */
  candidateHitEligible: boolean
  semanticHashPolicy: 'solana_verified_transaction_finality_semantics_v1'
  semanticHash: string
}

type ParsedTransactionResult =
  | { status: 'available'; value: SolanaFinalizedTransactionEvidence }
  | { status: 'metadata_unavailable' }
  | { status: 'unsupported_transaction_version' }
  | { status: 'malformed_response' }

function canonicalUnsigned(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0) &&
    value <= maximum
    ? value
    : null
}

function isSignature(value: unknown): value is string {
  return hasBase58DecodedByteLength(value, 64)
}

function isBlockHash(value: unknown): value is string {
  return hasBase58DecodedByteLength(value, 32)
}

function parseInstructionError(value: unknown): SolanaCanonicalInstructionError | null {
  if (typeof value === 'string') return INSTRUCTION_ERROR_UNITS.has(value) ? value : null
  const custom = exactDataRecord(value, ['Custom'])
  if (custom) {
    const code = canonicalUnsigned(custom.Custom, MAX_U32)
    return code === null ? null : { Custom: code }
  }
  const legacyBorsh = exactDataRecord(value, ['BorshIoError'])
  return legacyBorsh && typeof legacyBorsh.BorshIoError === 'string' ? 'BorshIoError' : null
}

function parseAccountIndexError(
  value: unknown,
  key: 'InsufficientFundsForRent' | 'ProgramExecutionTemporarilyRestricted'
): SolanaCanonicalTransactionError | null {
  const outer = exactDataRecord(value, [key])
  const inner = outer ? exactDataRecord(outer[key], ['account_index']) : null
  const accountIndex = inner ? canonicalUnsigned(inner.account_index, MAX_U8) : null
  if (accountIndex === null) return null
  return key === 'InsufficientFundsForRent'
    ? { InsufficientFundsForRent: { account_index: accountIndex } }
    : { ProgramExecutionTemporarilyRestricted: { account_index: accountIndex } }
}

function parseTransactionError(value: unknown): SolanaCanonicalTransactionError | null {
  if (typeof value === 'string') return TRANSACTION_ERROR_UNITS.has(value) ? value : null

  const duplicate = exactDataRecord(value, ['DuplicateInstruction'])
  if (duplicate) {
    const index = canonicalUnsigned(duplicate.DuplicateInstruction, MAX_U8)
    return index === null ? null : { DuplicateInstruction: index }
  }

  const instruction = exactDataRecord(value, ['InstructionError'])
  const instructionTuple = instruction ? exactDenseArray(instruction.InstructionError) : null
  if (instructionTuple?.length === 2) {
    const index = canonicalUnsigned(instructionTuple[0], MAX_U8)
    const error = parseInstructionError(instructionTuple[1])
    if (index !== null && error !== null) return { InstructionError: [index, error] }
  }

  return (
    parseAccountIndexError(value, 'InsufficientFundsForRent') ??
    parseAccountIndexError(value, 'ProgramExecutionTemporarilyRestricted')
  )
}

function parseNullableTransactionError(
  value: unknown
): { valid: true; value: SolanaCanonicalTransactionError | null } | { valid: false } {
  if (value === null) return { valid: true, value: null }
  const parsed = parseTransactionError(value)
  return parsed === null ? { valid: false } : { valid: true, value: parsed }
}

function parseTransactionStatus(value: unknown): SolanaCanonicalTransactionStatus | null {
  const ok = exactDataRecord(value, ['Ok'])
  if (ok) return ok.Ok === null ? { Ok: null } : null
  const failed = exactDataRecord(value, ['Err'])
  if (!failed) return null
  const error = parseTransactionError(failed.Err)
  return error === null ? null : { Err: error }
}

function errorFingerprint(error: SolanaCanonicalTransactionError | null): string {
  return JSON.stringify(error)
}

function statusMatchesError(
  status: SolanaCanonicalTransactionStatus,
  error: SolanaCanonicalTransactionError | null
): boolean {
  if (error === null) return 'Ok' in status && status.Ok === null
  return 'Err' in status && errorFingerprint(status.Err) === errorFingerprint(error)
}

function parseSignatureArray(value: unknown, minimum: number, maximum: number): string[] | null {
  const values = exactDenseArray(value)
  if (!values || values.length < minimum || values.length > maximum) return null
  const signatures: string[] = []
  const seen = new Set<string>()
  for (const signature of values) {
    if (!isSignature(signature) || seen.has(signature)) return null
    signatures.push(signature)
    seen.add(signature)
  }
  return signatures
}

function parseRawTransactionResult(value: unknown, signature: string): ParsedTransactionResult {
  if (!isRecord(value)) return { status: 'malformed_response' }
  if (!Object.hasOwn(value, 'version')) return { status: 'malformed_response' }
  if (Object.is(value.version, -0)) return { status: 'malformed_response' }
  if (
    typeof value.version === 'number' &&
    canonicalUnsigned(value.version) !== null &&
    value.version !== 0
  ) {
    return { status: 'unsupported_transaction_version' }
  }
  if (value.version !== 'legacy' && value.version !== 0) {
    return { status: 'malformed_response' }
  }
  if (!Object.hasOwn(value, 'meta')) return { status: 'malformed_response' }
  if (value.meta === null) return { status: 'metadata_unavailable' }
  if (!isRecord(value.meta) || !isRecord(value.transaction)) {
    return { status: 'malformed_response' }
  }

  const slot = canonicalUnsigned(value.slot)
  const blockTime = value.blockTime === null ? null : canonicalUnsigned(value.blockTime)
  const signatures = parseSignatureArray(
    value.transaction.signatures,
    1,
    MAX_TRANSACTION_SIGNATURES
  )
  const reportedTransactionIndex = Object.hasOwn(value, 'transactionIndex')
    ? canonicalUnsigned(value.transactionIndex, MAX_U32)
    : null
  const error = parseNullableTransactionError(value.meta.err)
  const status = parseTransactionStatus(value.meta.status)
  if (
    slot === null ||
    !Object.hasOwn(value, 'blockTime') ||
    (value.blockTime !== null && blockTime === null) ||
    !signatures ||
    signatures[0] !== signature ||
    (Object.hasOwn(value, 'transactionIndex') && reportedTransactionIndex === null) ||
    !Object.hasOwn(value.meta, 'err') ||
    !Object.hasOwn(value.meta, 'status') ||
    !error.valid ||
    !status ||
    !statusMatchesError(status, error.value)
  ) {
    return { status: 'malformed_response' }
  }
  return {
    status: 'available',
    value: {
      slot,
      blockTime,
      version: value.version,
      signatures,
      reportedTransactionIndex,
      err: error.value,
      status,
    },
  }
}

function unavailableForRpcCodes(
  result: SolanaRpcFailure,
  codes: ReadonlySet<number>
): ReturnType<typeof unavailableFromRpc> {
  const unavailable = unavailableFromRpc(result)
  return result.reason === 'rpc_error' && result.rpcCode !== null && codes.has(result.rpcCode)
    ? { ...unavailable, reason: 'not_found_or_unavailable' }
    : unavailable
}

function transactionLane(
  result: SolanaRpcResult,
  signature: string
): SolanaEvidenceLane<SolanaFinalizedTransactionEvidence> {
  if (!result.ok) {
    if (result.reason === 'rpc_error' && result.rpcCode === -32_015) {
      return { ...unavailableFromRpc(result), reason: 'unsupported_transaction_version' }
    }
    return unavailableForRpcCodes(result, SOLANA_HISTORY_UNAVAILABLE_RPC_CODES)
  }
  if (result.result === null) {
    return unavailableFromSuccess(result, 'not_found_or_unavailable')
  }
  const parsed = parseRawTransactionResult(result.result, signature)
  if (parsed.status !== 'available') return unavailableFromSuccess(result, parsed.status)
  return {
    status: 'available',
    value: parsed.value,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function parseRawSignatureStatus(
  value: unknown
): SolanaFinalizedSignatureStatusEvidence | 'not_found_or_unavailable' | null {
  if (!isRecord(value) || !isRecord(value.context)) return null
  const contextSlot = canonicalUnsigned(value.context.slot)
  if (contextSlot === null) return null
  if (
    Object.hasOwn(value.context, 'apiVersion') &&
    (typeof value.context.apiVersion !== 'string' || value.context.apiVersion.length > 128)
  ) {
    return null
  }
  const values = exactDenseArray(value.value)
  if (!values || values.length !== 1) return null
  if (values[0] === null) return 'not_found_or_unavailable'
  if (!isRecord(values[0])) return null
  const row = values[0]
  const slot = canonicalUnsigned(row.slot)
  const error = parseNullableTransactionError(row.err)
  const status = parseTransactionStatus(row.status)
  if (
    slot === null ||
    contextSlot < slot ||
    !Object.hasOwn(row, 'confirmations') ||
    row.confirmations !== null ||
    row.confirmationStatus !== 'finalized' ||
    !Object.hasOwn(row, 'err') ||
    !Object.hasOwn(row, 'status') ||
    !error.valid ||
    !status ||
    !statusMatchesError(status, error.value)
  ) {
    return null
  }
  return {
    contextSlot,
    slot,
    confirmations: null,
    confirmationStatus: 'finalized',
    err: error.value,
    status,
  }
}

function signatureStatusLane(
  result: SolanaRpcResult
): SolanaEvidenceLane<SolanaFinalizedSignatureStatusEvidence> {
  if (!result.ok) return unavailableForRpcCodes(result, SOLANA_HISTORY_UNAVAILABLE_RPC_CODES)
  const parsed = parseRawSignatureStatus(result.result)
  if (parsed === 'not_found_or_unavailable') {
    return unavailableFromSuccess(result, 'not_found_or_unavailable')
  }
  if (!parsed) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: parsed,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function parseRawBlockHeader(value: unknown, slot: number): SolanaFinalizedBlockEvidence | null {
  if (!isRecord(value)) return null
  const parentSlot = canonicalUnsigned(value.parentSlot)
  const blockTime = value.blockTime === null ? null : canonicalUnsigned(value.blockTime)
  const blockHeight = value.blockHeight === null ? null : canonicalUnsigned(value.blockHeight)
  if (
    !isBlockHash(value.blockhash) ||
    !isBlockHash(value.previousBlockhash) ||
    value.blockhash === value.previousBlockhash ||
    parentSlot === null ||
    parentSlot >= slot ||
    !Object.hasOwn(value, 'blockTime') ||
    (value.blockTime !== null && blockTime === null) ||
    !Object.hasOwn(value, 'blockHeight') ||
    (value.blockHeight !== null && blockHeight === null) ||
    (blockHeight !== null && blockHeight > slot)
  ) {
    return null
  }
  return {
    slot,
    blockhash: value.blockhash,
    previousBlockhash: value.previousBlockhash,
    parentSlot,
    blockTime,
    blockHeight,
  }
}

function parseRawBlockMembership(
  value: unknown,
  slot: number
): SolanaBlockSignatureMembershipEvidence | null {
  if (!isRecord(value) || Object.hasOwn(value, 'transactions') || Object.hasOwn(value, 'rewards')) {
    return null
  }
  if (Object.hasOwn(value, 'numRewardPartitions')) {
    const partitions = value.numRewardPartitions
    if (partitions !== null && canonicalUnsigned(partitions) === null) return null
  }
  const header = parseRawBlockHeader(value, slot)
  const signatures = parseSignatureArray(value.signatures, 0, MAX_BLOCK_SIGNATURES)
  return header && signatures ? { ...header, signatures } : null
}

function blockMembershipLane(
  result: SolanaRpcResult,
  slot: number
): SolanaEvidenceLane<SolanaBlockSignatureMembershipEvidence> {
  if (!result.ok) return unavailableForRpcCodes(result, SOLANA_BLOCK_UNAVAILABLE_RPC_CODES)
  if (result.result === null) {
    return unavailableFromSuccess(result, 'not_found_or_unavailable')
  }
  const parsed = parseRawBlockMembership(result.result, slot)
  if (!parsed) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: parsed,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function copyBlock(block: SolanaFinalizedBlockEvidence): SolanaFinalizedBlockEvidence {
  return {
    slot: block.slot,
    blockhash: block.blockhash,
    previousBlockhash: block.previousBlockhash,
    parentSlot: block.parentSlot,
    blockTime: block.blockTime,
    blockHeight: block.blockHeight,
  }
}

function membershipPolicy(): SolanaTransactionMembershipPolicy {
  return {
    version: 'solana_transaction_membership_v1',
    transactionMethod: 'getTransaction',
    signatureStatusMethod: 'getSignatureStatuses',
    blockMethod: 'getBlock',
    commitment: 'finalized',
    encoding: 'json',
    maxSupportedTransactionVersion: 0,
    searchTransactionHistory: true,
    blockTransactionDetails: 'signatures',
    blockMaxSupportedTransactionVersion: null,
    rewards: false,
    maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
  }
}

function copyAnchorPolicy(
  policy: SolanaVerifiedChainAnchor['anchorPolicy']
): SolanaVerifiedChainAnchor['anchorPolicy'] {
  return {
    version: policy.version,
    genesisMethod: policy.genesisMethod,
    slotMethod: policy.slotMethod,
    blockMethod: policy.blockMethod,
    commitment: policy.commitment,
    encoding: policy.encoding,
    transactionDetails: policy.transactionDetails,
    maxSupportedTransactionVersion: policy.maxSupportedTransactionVersion,
    rewards: policy.rewards,
    maxFutureBlockSkewMs: policy.maxFutureBlockSkewMs,
    maxCurrentAnchorLagMs: policy.maxCurrentAnchorLagMs,
  }
}

function anchorBinding(anchor: SolanaVerifiedChainAnchor): SolanaTransactionAnchorBinding {
  return {
    endpoint: endpointCopy(anchor.endpoint),
    verifiedAnchorHashPolicy: 'solana_verified_anchor_semantics_v1',
    verifiedAnchorHash: anchor.semanticHash,
    observedAt: anchor.observedAt,
    anchorPolicy: copyAnchorPolicy(anchor.anchorPolicy),
    finalizedSlot: anchor.finalizedSlot,
    finalizedBlock: copyBlock(anchor.finalizedBlock),
  }
}

/**
 * Capture the three same-endpoint observations needed for transaction
 * finality. Provider failover requires restarting from a fresh chain anchor.
 */
export async function fetchSolanaTransactionMembershipEvidence(
  signature: string,
  anchorEvidence: unknown,
  opts: SolanaEvidenceRpcOpts = {}
): Promise<SolanaTransactionMembershipEvidence> {
  if (!isSignature(signature)) {
    throw new TypeError('signature must be a base58-encoded 64-byte signature')
  }
  const anchor = requireSolanaVerifiedChainAnchor(anchorEvidence)
  const parsedOpts = parseOptsOrThrow(opts)
  const endpoint = resolveEndpoint(parsedOpts)
  if (!endpoint) throw new TypeError('Solana transaction membership endpoint is unavailable')
  if (!sameEndpoint(endpoint.identity, anchor.endpoint)) {
    throw new TypeError('Solana transaction membership endpoint does not match anchor')
  }

  const timeoutMs = parsedOpts.timeoutMs ?? DEFAULT_SOLANA_EVIDENCE_TIMEOUT_MS
  const transactionResult = await solanaEvidenceRpc(
    endpoint,
    'getTransaction',
    [
      signature,
      {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      },
    ],
    timeoutMs
  )
  const transaction = transactionLane(transactionResult, signature)
  let signatureStatus: SolanaEvidenceLane<SolanaFinalizedSignatureStatusEvidence> =
    dependencyUnavailableLane()
  let canonicalBlock: SolanaEvidenceLane<SolanaBlockSignatureMembershipEvidence> =
    dependencyUnavailableLane()
  if (transaction.status === 'available') {
    const [statusResult, blockResult] = await Promise.all([
      solanaEvidenceRpc(
        endpoint,
        'getSignatureStatuses',
        [[signature], { searchTransactionHistory: true }],
        timeoutMs
      ),
      solanaEvidenceRpc(
        endpoint,
        'getBlock',
        [
          transaction.value.slot,
          {
            commitment: 'finalized',
            encoding: 'json',
            transactionDetails: 'signatures',
            rewards: false,
          },
        ],
        timeoutMs
      ),
    ])
    signatureStatus = signatureStatusLane(statusResult)
    canonicalBlock = blockMembershipLane(blockResult, transaction.value.slot)
  }

  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    signature,
    capturedAt: new Date().toISOString(),
    membershipPolicy: membershipPolicy(),
    anchor: anchorBinding(anchor),
    transaction,
    signatureStatus,
    canonicalBlock,
  }
}

function parseExactBlock(value: unknown): SolanaFinalizedBlockEvidence | null {
  const block = exactDataRecord(value, [
    'slot',
    'blockhash',
    'previousBlockhash',
    'parentSlot',
    'blockTime',
    'blockHeight',
  ])
  if (!block) return null
  const slot = canonicalUnsigned(block.slot)
  return slot === null ? null : parseRawBlockHeader(block, slot)
}

function parseExactBlockMembership(value: unknown): SolanaBlockSignatureMembershipEvidence | null {
  const block = exactDataRecord(value, [
    'slot',
    'blockhash',
    'previousBlockhash',
    'parentSlot',
    'blockTime',
    'blockHeight',
    'signatures',
  ])
  if (!block) return null
  const slot = canonicalUnsigned(block.slot)
  if (slot === null) return null
  const header = parseRawBlockHeader(block, slot)
  const signatures = parseSignatureArray(block.signatures, 0, MAX_BLOCK_SIGNATURES)
  return header && signatures ? { ...header, signatures } : null
}

function parseExactTransaction(
  value: unknown,
  signature: string
): SolanaFinalizedTransactionEvidence | null {
  const transaction = exactDataRecord(value, [
    'slot',
    'blockTime',
    'version',
    'signatures',
    'reportedTransactionIndex',
    'err',
    'status',
  ])
  if (!transaction) return null
  const slot = canonicalUnsigned(transaction.slot)
  const blockTime = transaction.blockTime === null ? null : canonicalUnsigned(transaction.blockTime)
  const signatures = parseSignatureArray(transaction.signatures, 1, MAX_TRANSACTION_SIGNATURES)
  const reportedTransactionIndex =
    transaction.reportedTransactionIndex === null
      ? null
      : canonicalUnsigned(transaction.reportedTransactionIndex, MAX_U32)
  const error = parseNullableTransactionError(transaction.err)
  const status = parseTransactionStatus(transaction.status)
  if (
    slot === null ||
    (transaction.blockTime !== null && blockTime === null) ||
    Object.is(transaction.version, -0) ||
    (transaction.version !== 'legacy' && transaction.version !== 0) ||
    !signatures ||
    signatures[0] !== signature ||
    (transaction.reportedTransactionIndex !== null && reportedTransactionIndex === null) ||
    !error.valid ||
    !status ||
    !statusMatchesError(status, error.value)
  ) {
    return null
  }
  return {
    slot,
    blockTime,
    version: transaction.version,
    signatures,
    reportedTransactionIndex,
    err: error.value,
    status,
  }
}

function parseExactSignatureStatus(value: unknown): SolanaFinalizedSignatureStatusEvidence | null {
  const row = exactDataRecord(value, [
    'contextSlot',
    'slot',
    'confirmations',
    'confirmationStatus',
    'err',
    'status',
  ])
  if (!row) return null
  const contextSlot = canonicalUnsigned(row.contextSlot)
  const slot = canonicalUnsigned(row.slot)
  const error = parseNullableTransactionError(row.err)
  const status = parseTransactionStatus(row.status)
  if (
    contextSlot === null ||
    slot === null ||
    contextSlot < slot ||
    row.confirmations !== null ||
    row.confirmationStatus !== 'finalized' ||
    !error.valid ||
    !status ||
    !statusMatchesError(status, error.value)
  ) {
    return null
  }
  return {
    contextSlot,
    slot,
    confirmations: null,
    confirmationStatus: 'finalized',
    err: error.value,
    status,
  }
}

function sameBlock(
  left: SolanaFinalizedBlockEvidence,
  right: SolanaFinalizedBlockEvidence
): boolean {
  return (
    left.slot === right.slot &&
    left.blockhash === right.blockhash &&
    left.previousBlockhash === right.previousBlockhash &&
    left.parentSlot === right.parentSlot &&
    left.blockTime === right.blockTime &&
    left.blockHeight === right.blockHeight
  )
}

function policyMatches(value: unknown): value is SolanaTransactionMembershipPolicy {
  const policy = exactDataRecord(value, [
    'version',
    'transactionMethod',
    'signatureStatusMethod',
    'blockMethod',
    'commitment',
    'encoding',
    'maxSupportedTransactionVersion',
    'searchTransactionHistory',
    'blockTransactionDetails',
    'blockMaxSupportedTransactionVersion',
    'rewards',
    'maxFutureBlockSkewMs',
  ])
  return Boolean(
    policy &&
    policy.version === 'solana_transaction_membership_v1' &&
    policy.transactionMethod === 'getTransaction' &&
    policy.signatureStatusMethod === 'getSignatureStatuses' &&
    policy.blockMethod === 'getBlock' &&
    policy.commitment === 'finalized' &&
    policy.encoding === 'json' &&
    policy.maxSupportedTransactionVersion === 0 &&
    policy.searchTransactionHistory === true &&
    policy.blockTransactionDetails === 'signatures' &&
    policy.blockMaxSupportedTransactionVersion === null &&
    policy.rewards === false &&
    policy.maxFutureBlockSkewMs === MAX_FUTURE_BLOCK_SKEW_MS
  )
}

function anchorPolicyMatches(
  value: unknown,
  anchor: SolanaVerifiedChainAnchor
): value is SolanaVerifiedChainAnchor['anchorPolicy'] {
  const policy = exactDataRecord(value, [
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
  return Boolean(
    policy &&
    policy.version === anchor.anchorPolicy.version &&
    policy.genesisMethod === anchor.anchorPolicy.genesisMethod &&
    policy.slotMethod === anchor.anchorPolicy.slotMethod &&
    policy.blockMethod === anchor.anchorPolicy.blockMethod &&
    policy.commitment === anchor.anchorPolicy.commitment &&
    policy.encoding === anchor.anchorPolicy.encoding &&
    policy.transactionDetails === anchor.anchorPolicy.transactionDetails &&
    policy.maxSupportedTransactionVersion === anchor.anchorPolicy.maxSupportedTransactionVersion &&
    policy.rewards === anchor.anchorPolicy.rewards &&
    policy.maxFutureBlockSkewMs === anchor.anchorPolicy.maxFutureBlockSkewMs &&
    policy.maxCurrentAnchorLagMs === anchor.anchorPolicy.maxCurrentAnchorLagMs
  )
}

function unixTimestampMs(value: number | null): number | null {
  if (value === null) return null
  const milliseconds = BigInt(value) * 1000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null
}

function copyInstructionError(
  error: SolanaCanonicalInstructionError
): SolanaCanonicalInstructionError {
  return typeof error === 'string' ? error : { Custom: error.Custom }
}

function copyTransactionError(
  error: SolanaCanonicalTransactionError
): SolanaCanonicalTransactionError {
  if (typeof error === 'string') return error
  if ('DuplicateInstruction' in error) {
    return { DuplicateInstruction: error.DuplicateInstruction }
  }
  if ('InstructionError' in error) {
    return {
      InstructionError: [
        error.InstructionError[0],
        copyInstructionError(error.InstructionError[1]),
      ],
    }
  }
  if ('InsufficientFundsForRent' in error) {
    return {
      InsufficientFundsForRent: { account_index: error.InsufficientFundsForRent.account_index },
    }
  }
  return {
    ProgramExecutionTemporarilyRestricted: {
      account_index: error.ProgramExecutionTemporarilyRestricted.account_index,
    },
  }
}

function copyStatus(status: SolanaCanonicalTransactionStatus): SolanaCanonicalTransactionStatus {
  return 'Ok' in status ? { Ok: null } : { Err: copyTransactionError(status.Err) }
}

function copyTransaction(
  transaction: SolanaFinalizedTransactionEvidence
): SolanaFinalizedTransactionEvidence {
  return {
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    version: transaction.version,
    signatures: transaction.signatures.map((signature) => signature),
    reportedTransactionIndex: transaction.reportedTransactionIndex,
    err: transaction.err === null ? null : copyTransactionError(transaction.err),
    status: copyStatus(transaction.status),
  }
}

function copySignatureStatus(
  status: SolanaFinalizedSignatureStatusEvidence
): SolanaFinalizedSignatureStatusEvidence {
  return {
    contextSlot: status.contextSlot,
    slot: status.slot,
    confirmations: null,
    confirmationStatus: 'finalized',
    err: status.err === null ? null : copyTransactionError(status.err),
    status: copyStatus(status.status),
  }
}

function copyBlockMembership(
  block: SolanaBlockSignatureMembershipEvidence
): SolanaBlockSignatureMembershipEvidence {
  return { ...copyBlock(block), signatures: block.signatures.map((signature) => signature) }
}

function transactionSemanticHash(
  endpoint: SolanaEvidenceEndpointIdentity,
  anchor: SolanaVerifiedChainAnchor,
  capturedAt: string,
  signature: string,
  transaction: SolanaFinalizedTransactionEvidence,
  signatureStatus: SolanaFinalizedSignatureStatusEvidence,
  block: SolanaBlockSignatureMembershipEvidence,
  transactionIndex: number
): string {
  const policy = membershipPolicy()
  const fields = [
    'solana_verified_transaction_finality_semantics_v1',
    'mainnet-beta',
    SOLANA_MAINNET_GENESIS_HASH,
    policy.version,
    policy.transactionMethod,
    policy.signatureStatusMethod,
    policy.blockMethod,
    policy.commitment,
    policy.encoding,
    policy.maxSupportedTransactionVersion,
    policy.searchTransactionHistory,
    policy.blockTransactionDetails,
    policy.blockMaxSupportedTransactionVersion,
    policy.rewards,
    policy.maxFutureBlockSkewMs,
    endpoint.providerId,
    endpoint.endpointId,
    endpoint.connectionHash,
    anchor.semanticHashPolicy,
    anchor.semanticHash,
    anchor.observedAt,
    anchor.finalizedSlot,
    anchor.finalizedBlock.slot,
    anchor.finalizedBlock.blockhash,
    anchor.finalizedBlock.previousBlockhash,
    anchor.finalizedBlock.parentSlot,
    anchor.finalizedBlock.blockTime,
    anchor.finalizedBlock.blockHeight,
    signature,
    capturedAt,
    transaction.slot,
    transaction.blockTime,
    transaction.version,
    transaction.signatures,
    transaction.reportedTransactionIndex,
    transaction.err,
    transaction.status,
    signatureStatus.contextSlot,
    signatureStatus.slot,
    signatureStatus.confirmations,
    signatureStatus.confirmationStatus,
    signatureStatus.err,
    signatureStatus.status,
    block.slot,
    block.blockhash,
    block.previousBlockhash,
    block.parentSlot,
    block.blockTime,
    block.blockHeight,
    block.signatures,
    transactionIndex,
    transaction.err === null,
  ]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function invalidVerifiedTransactionFinality(): never {
  throw new TypeError('Solana transaction finality evidence is not fully verified')
}

function requireSolanaVerifiedTransactionFinalityInternal(
  evidence: unknown,
  anchorEvidence: unknown
): SolanaVerifiedTransactionFinality {
  const anchor = requireSolanaVerifiedChainAnchor(anchorEvidence)
  const root = exactDataRecord(evidence, [
    'chain',
    'signature',
    'capturedAt',
    'membershipPolicy',
    'anchor',
    'transaction',
    'signatureStatus',
    'canonicalBlock',
  ])
  if (!root) return invalidVerifiedTransactionFinality()
  const chain = exactDataRecord(root.chain, ['cluster', 'genesisHash'])
  const boundAnchor = exactDataRecord(root.anchor, [
    'endpoint',
    'verifiedAnchorHashPolicy',
    'verifiedAnchorHash',
    'observedAt',
    'anchorPolicy',
    'finalizedSlot',
    'finalizedBlock',
  ])
  const boundEndpoint = boundAnchor ? parseApprovedEndpoint(boundAnchor.endpoint) : null
  const boundFinalizedSlot = boundAnchor ? canonicalUnsigned(boundAnchor.finalizedSlot) : null
  const boundFinalizedBlock = boundAnchor ? parseExactBlock(boundAnchor.finalizedBlock) : null
  const transactionLaneValue = parseAvailableLane(root.transaction)
  const statusLaneValue = parseAvailableLane(root.signatureStatus)
  const blockLaneValue = parseAvailableLane(root.canonicalBlock)
  const transaction =
    transactionLaneValue && typeof root.signature === 'string'
      ? parseExactTransaction(transactionLaneValue.value, root.signature)
      : null
  const signatureStatus = statusLaneValue ? parseExactSignatureStatus(statusLaneValue.value) : null
  const canonicalBlock = blockLaneValue ? parseExactBlockMembership(blockLaneValue.value) : null
  const capturedAtMs = canonicalTimestampMs(root.capturedAt)
  const anchorObservedAtMs = canonicalTimestampMs(anchor.observedAt)
  const candidateBlockTimeMs = unixTimestampMs(canonicalBlock?.blockTime ?? null)
  const transactionBlockTimeMs = unixTimestampMs(transaction?.blockTime ?? null)
  if (
    !chain ||
    chain.cluster !== 'mainnet-beta' ||
    chain.genesisHash !== SOLANA_MAINNET_GENESIS_HASH ||
    typeof root.signature !== 'string' ||
    !isSignature(root.signature) ||
    capturedAtMs === null ||
    anchorObservedAtMs === null ||
    capturedAtMs + MAX_FUTURE_BLOCK_SKEW_MS < anchorObservedAtMs ||
    !policyMatches(root.membershipPolicy) ||
    !boundAnchor ||
    !boundEndpoint ||
    !sameEndpoint(boundEndpoint, anchor.endpoint) ||
    boundAnchor.verifiedAnchorHashPolicy !== 'solana_verified_anchor_semantics_v1' ||
    boundAnchor.verifiedAnchorHash !== anchor.semanticHash ||
    boundAnchor.observedAt !== anchor.observedAt ||
    !anchorPolicyMatches(boundAnchor.anchorPolicy, anchor) ||
    boundFinalizedSlot === null ||
    boundFinalizedSlot !== anchor.finalizedSlot ||
    !boundFinalizedBlock ||
    !sameBlock(boundFinalizedBlock, anchor.finalizedBlock) ||
    !transactionLaneValue ||
    !statusLaneValue ||
    !blockLaneValue ||
    !transaction ||
    !signatureStatus ||
    !canonicalBlock ||
    !sameEndpoint(transactionLaneValue.endpoint, boundEndpoint) ||
    !sameEndpoint(statusLaneValue.endpoint, boundEndpoint) ||
    !sameEndpoint(blockLaneValue.endpoint, boundEndpoint) ||
    transaction.signatures[0] !== root.signature ||
    transaction.slot !== signatureStatus.slot ||
    transaction.slot !== canonicalBlock.slot ||
    transaction.slot > anchor.finalizedSlot ||
    errorFingerprint(transaction.err) !== errorFingerprint(signatureStatus.err) ||
    JSON.stringify(transaction.status) !== JSON.stringify(signatureStatus.status) ||
    (transaction.blockTime !== null &&
      canonicalBlock.blockTime !== null &&
      transaction.blockTime !== canonicalBlock.blockTime) ||
    (transaction.blockTime !== null && transactionBlockTimeMs === null) ||
    (canonicalBlock.blockTime !== null && candidateBlockTimeMs === null) ||
    (transactionBlockTimeMs !== null &&
      transactionBlockTimeMs > capturedAtMs + MAX_FUTURE_BLOCK_SKEW_MS) ||
    (candidateBlockTimeMs !== null &&
      candidateBlockTimeMs > capturedAtMs + MAX_FUTURE_BLOCK_SKEW_MS) ||
    (canonicalBlock.slot === anchor.finalizedSlot &&
      !sameBlock(canonicalBlock, anchor.finalizedBlock)) ||
    (canonicalBlock.slot < anchor.finalizedSlot &&
      canonicalBlock.blockhash === anchor.finalizedBlock.blockhash)
  ) {
    return invalidVerifiedTransactionFinality()
  }

  const transactionIndex = canonicalBlock.signatures.indexOf(root.signature)
  if (
    transactionIndex < 0 ||
    (transaction.reportedTransactionIndex !== null &&
      transaction.reportedTransactionIndex !== transactionIndex)
  ) {
    return invalidVerifiedTransactionFinality()
  }

  const capturedAt = new Date(capturedAtMs).toISOString()
  const copiedTransaction = copyTransaction(transaction)
  const copiedStatus = copySignatureStatus(signatureStatus)
  const copiedBlock = copyBlockMembership(canonicalBlock)
  const succeeded = copiedTransaction.err === null
  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    signature: root.signature,
    capturedAt,
    membershipPolicy: membershipPolicy(),
    anchor: anchorBinding(anchor),
    transaction: copiedTransaction,
    signatureStatus: copiedStatus,
    canonicalBlock: copiedBlock,
    transactionIndex,
    executionStatus: succeeded ? 'succeeded' : 'failed',
    candidateHitEligible: succeeded,
    semanticHashPolicy: 'solana_verified_transaction_finality_semantics_v1',
    semanticHash: transactionSemanticHash(
      boundEndpoint,
      anchor,
      capturedAt,
      root.signature,
      copiedTransaction,
      copiedStatus,
      copiedBlock,
      transactionIndex
    ),
  }
}

export function requireSolanaVerifiedTransactionFinality(
  evidence: unknown,
  anchorEvidence: unknown
): SolanaVerifiedTransactionFinality {
  try {
    return requireSolanaVerifiedTransactionFinalityInternal(evidence, anchorEvidence)
  } catch {
    return invalidVerifiedTransactionFinality()
  }
}
