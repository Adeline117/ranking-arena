import type {
  BscBlockMembershipEvidence,
  BscMinedTransactionEvidence,
  BscReceiptLogEvidence,
  BscTransactionReceiptEvidence,
  BscVerifiedTransactionFinality,
} from '../../lib/ingest/onchain/bsc-evidence'
import { BSC_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/bsc-evidence'
import type {
  SolanaBlockSignatureMembershipEvidence,
  SolanaCanonicalInstructionError,
  SolanaCanonicalTransactionError,
  SolanaCanonicalTransactionStatus,
  SolanaFinalizedSignatureStatusEvidence,
  SolanaFinalizedTransactionEvidence,
  SolanaVerifiedTransactionFinality,
} from '../../lib/ingest/onchain/solana-transaction-evidence'
import { dexContractSha256 } from './dex-contract-hash'

export const DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT =
  'arena.dex.bsc-stable-transaction-facts@1' as const
export const DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT =
  'arena.dex.solana-stable-transaction-facts@1' as const

const NON_CRYPTOGRAPHIC_PROOF_BOUNDARY =
  'same_provider_rpc_finality_and_membership_assertion_not_cryptographic_inclusion_proof' as const

function copyBscTransaction(transaction: BscMinedTransactionEvidence): BscMinedTransactionEvidence {
  return { ...transaction }
}

function copyBscReceiptLog(log: BscReceiptLogEvidence): BscReceiptLogEvidence {
  return { ...log, topics: [...log.topics] }
}

function copyBscReceipt(receipt: BscTransactionReceiptEvidence): BscTransactionReceiptEvidence {
  return {
    ...receipt,
    logs: receipt.logs.map(copyBscReceiptLog),
  }
}

function copyBscBlock(block: BscBlockMembershipEvidence): BscBlockMembershipEvidence {
  return { ...block, transactions: [...block.transactions] }
}

function copySolanaInstructionError(
  error: SolanaCanonicalInstructionError
): SolanaCanonicalInstructionError {
  return typeof error === 'string' ? error : { Custom: error.Custom }
}

function copySolanaTransactionError(
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
        copySolanaInstructionError(error.InstructionError[1]),
      ],
    }
  }
  if ('InsufficientFundsForRent' in error) {
    return {
      InsufficientFundsForRent: {
        account_index: error.InsufficientFundsForRent.account_index,
      },
    }
  }
  return {
    ProgramExecutionTemporarilyRestricted: {
      account_index: error.ProgramExecutionTemporarilyRestricted.account_index,
    },
  }
}

function copyNullableSolanaTransactionError(
  error: SolanaCanonicalTransactionError | null
): SolanaCanonicalTransactionError | null {
  return error === null ? null : copySolanaTransactionError(error)
}

function copySolanaStatus(
  status: SolanaCanonicalTransactionStatus
): SolanaCanonicalTransactionStatus {
  return 'Ok' in status ? { Ok: null } : { Err: copySolanaTransactionError(status.Err) }
}

function copySolanaTransactionWithoutReportedIndex(
  transaction: SolanaFinalizedTransactionEvidence
): Omit<SolanaFinalizedTransactionEvidence, 'reportedTransactionIndex'> {
  return {
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    version: transaction.version,
    signatures: [...transaction.signatures],
    err: copyNullableSolanaTransactionError(transaction.err),
    status: copySolanaStatus(transaction.status),
  }
}

function copySolanaStatusWithoutContext(
  status: SolanaFinalizedSignatureStatusEvidence
): Omit<SolanaFinalizedSignatureStatusEvidence, 'contextSlot'> {
  return {
    slot: status.slot,
    confirmations: null,
    confirmationStatus: 'finalized',
    err: copyNullableSolanaTransactionError(status.err),
    status: copySolanaStatus(status.status),
  }
}

function copySolanaBlock(
  block: SolanaBlockSignatureMembershipEvidence
): SolanaBlockSignatureMembershipEvidence {
  return { ...block, signatures: [...block.signatures] }
}

/**
 * Provider-neutral facts for one BSC transaction after the existing strict
 * same-provider verifier has accepted it.
 *
 * Current finalized/head anchors, endpoint identity, and capture time are
 * deliberately absent: those are valid provider witnesses but unstable
 * cross-provider comparison fields.
 */
export function buildDexBscStableTransactionFacts(verified: BscVerifiedTransactionFinality) {
  return {
    data_contract: DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
    proof_boundary: NON_CRYPTOGRAPHIC_PROOF_BOUNDARY,
    chain: {
      namespace: 'eip155' as const,
      reference: '56' as const,
      genesis_hash: BSC_MAINNET_GENESIS_HASH,
    },
    tx_hash: verified.txHash,
    membership_policy: { ...verified.membershipPolicy },
    execution_status:
      verified.receipt.status === '0x1' ? ('succeeded' as const) : ('failed' as const),
    transaction: copyBscTransaction(verified.transaction),
    receipt: copyBscReceipt(verified.receipt),
    canonical_block: copyBscBlock(verified.canonicalBlock),
    indexed_transaction: copyBscTransaction(verified.indexedTransaction),
  }
}

/**
 * Provider-neutral facts for one Solana transaction after the existing strict
 * same-provider verifier has accepted it.
 *
 * signatureStatus.contextSlot and transaction.reportedTransactionIndex are
 * provider/capture dependent. The strict verifier already proves that a
 * reported index agrees with its independently derived transactionIndex, so
 * only that derived index belongs in the stable projection.
 */
export function buildDexSolanaStableTransactionFacts(verified: SolanaVerifiedTransactionFinality) {
  return {
    data_contract: DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
    proof_boundary: NON_CRYPTOGRAPHIC_PROOF_BOUNDARY,
    chain: { ...verified.chain },
    signature: verified.signature,
    membership_policy: { ...verified.membershipPolicy },
    execution_status: verified.executionStatus,
    transaction: copySolanaTransactionWithoutReportedIndex(verified.transaction),
    signature_status: copySolanaStatusWithoutContext(verified.signatureStatus),
    canonical_block: copySolanaBlock(verified.canonicalBlock),
    transaction_index: verified.transactionIndex,
  }
}

export function dexBscStableTransactionFactsSha256(
  verified: BscVerifiedTransactionFinality
): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.bsc-stable-transaction-facts',
      schema_id: DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
      schema_version: 1,
    },
    buildDexBscStableTransactionFacts(verified)
  )
}

export function dexSolanaStableTransactionFactsSha256(
  verified: SolanaVerifiedTransactionFinality
): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-stable-transaction-facts',
      schema_id: DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
      schema_version: 1,
    },
    buildDexSolanaStableTransactionFacts(verified)
  )
}
