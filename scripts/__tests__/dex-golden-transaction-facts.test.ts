import type {
  BscBlockHeaderEvidence,
  BscEvidenceEndpointIdentity,
  BscVerifiedTransactionFinality,
} from '../../lib/ingest/onchain/bsc-evidence'
import { BSC_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/bsc-evidence'
import type { SolanaVerifiedTransactionFinality } from '../../lib/ingest/onchain/solana-transaction-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import {
  DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
  buildDexBscStableTransactionFacts,
  buildDexSolanaStableTransactionFacts,
  dexBscStableTransactionFactsSha256,
  dexSolanaStableTransactionFactsSha256,
} from '../lib/dex-golden-transaction-facts'

const HASH_A = `0x${'11'.repeat(32)}`
const HASH_B = `0x${'22'.repeat(32)}`
const HASH_C = `0x${'33'.repeat(32)}`
const HASH_D = `0x${'44'.repeat(32)}`
const TX_HASH = `0x${'55'.repeat(32)}`
const ADDRESS_A = `0x${'aa'.repeat(20)}`
const ADDRESS_B = `0x${'bb'.repeat(20)}`
const SIGNATURE_A = '2'.repeat(88)
const SIGNATURE_B = '3'.repeat(88)

function bscBlock(overrides: Partial<BscBlockHeaderEvidence> = {}): BscBlockHeaderEvidence {
  return {
    number: '0x10',
    hash: HASH_A,
    parentHash: HASH_B,
    timestamp: '0x60000000',
    stateRoot: HASH_C,
    transactionsRoot: HASH_D,
    receiptsRoot: `0x${'66'.repeat(32)}`,
    ...overrides,
  }
}

function bscEndpoint(
  providerId: BscEvidenceEndpointIdentity['providerId'],
  endpointId: string,
  connectionHash: string
): BscEvidenceEndpointIdentity {
  return { providerId, endpointId, connectionHash }
}

function bscVerified(
  endpoint = bscEndpoint('bnb_chain', 'bnb_official_public_seed', '1'.repeat(64))
): BscVerifiedTransactionFinality {
  const block = {
    ...bscBlock(),
    transactions: [HASH_B, TX_HASH, HASH_C],
  }
  const transaction = {
    hash: TX_HASH,
    from: ADDRESS_A,
    to: ADDRESS_B,
    input: '0x1234',
    value: '0x0',
    blockNumber: block.number,
    blockHash: block.hash,
    transactionIndex: '0x1',
  }
  return {
    chain: { namespace: 'eip155', reference: '56' },
    txHash: TX_HASH,
    capturedAt: '2026-07-17T00:00:01.000Z',
    membershipPolicy: {
      version: 'bsc_transaction_membership_v1',
      transactionMethod: 'eth_getTransactionByHash',
      receiptMethod: 'eth_getTransactionReceipt',
      blockMethod: 'eth_getBlockByNumber',
      indexedTransactionMethod: 'eth_getTransactionByBlockNumberAndIndex',
      fullTransactions: false,
    },
    anchor: {
      endpoint,
      verifiedAnchorHash: '2'.repeat(64),
      verifiedAnchorHashPolicy: 'bsc_verified_anchor_semantics_v1',
      observedAt: '2026-07-17T00:00:00.000Z',
      finalityPolicy: {
        version: 'bsc_standard_finalized_current_v1',
        method: 'eth_getBlockByNumber',
        blockTag: 'finalized',
        headBlockTag: 'latest',
        fullTransactions: false,
        maxFutureBlockSkewMs: 60_000,
        maxCurrentAnchorLagMs: 900_000,
      },
      finalizedBlock: bscBlock({ number: '0x20', hash: HASH_D }),
    },
    transaction,
    receipt: {
      transactionHash: TX_HASH,
      transactionIndex: '0x1',
      blockNumber: block.number,
      blockHash: block.hash,
      from: ADDRESS_A,
      to: ADDRESS_B,
      status: '0x1',
      logs: [
        {
          address: ADDRESS_B,
          topics: [HASH_C],
          data: '0x01',
          blockNumber: block.number,
          transactionHash: TX_HASH,
          transactionIndex: '0x1',
          blockHash: block.hash,
          logIndex: '0x2',
          removed: false,
        },
      ],
    },
    canonicalBlock: block,
    indexedTransaction: { ...transaction },
  }
}

function solanaVerified(): SolanaVerifiedTransactionFinality {
  const transaction = {
    slot: 100,
    blockTime: 1_700_000_000,
    version: 0 as const,
    signatures: [SIGNATURE_A],
    reportedTransactionIndex: 1,
    err: null,
    status: { Ok: null } as const,
  }
  const block = {
    slot: 100,
    blockhash: '4'.repeat(44),
    previousBlockhash: '5'.repeat(44),
    parentSlot: 99,
    blockTime: 1_700_000_000,
    blockHeight: 90,
    signatures: [SIGNATURE_B, SIGNATURE_A],
  }
  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    signature: SIGNATURE_A,
    capturedAt: '2026-07-17T00:00:01.000Z',
    membershipPolicy: {
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
      maxFutureBlockSkewMs: 60_000,
    },
    anchor: {
      endpoint: {
        providerId: 'solana_foundation',
        endpointId: 'solana_official_mainnet',
        connectionHash: '3'.repeat(64),
      },
      verifiedAnchorHashPolicy: 'solana_verified_anchor_semantics_v1',
      verifiedAnchorHash: '4'.repeat(64),
      observedAt: '2026-07-17T00:00:00.000Z',
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
        maxFutureBlockSkewMs: 60_000,
        maxCurrentAnchorLagMs: 900_000,
      },
      finalizedSlot: 110,
      finalizedBlock: {
        slot: 110,
        blockhash: '6'.repeat(44),
        previousBlockhash: '7'.repeat(44),
        parentSlot: 109,
        blockTime: 1_700_000_010,
        blockHeight: 100,
      },
    },
    transaction,
    signatureStatus: {
      contextSlot: 111,
      slot: 100,
      confirmations: null,
      confirmationStatus: 'finalized',
      err: null,
      status: { Ok: null },
    },
    canonicalBlock: block,
    transactionIndex: 1,
    executionStatus: 'succeeded',
    candidateHitEligible: true,
    semanticHashPolicy: 'solana_verified_transaction_finality_semantics_v1',
    semanticHash: '5'.repeat(64),
  }
}

describe('provider-neutral DEX golden transaction facts', () => {
  it('keeps BSC transaction, receipt, ordered logs, and block membership', () => {
    const verified = bscVerified()
    const facts = buildDexBscStableTransactionFacts(verified)

    expect(facts).toMatchObject({
      data_contract: DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
      chain: {
        namespace: 'eip155',
        reference: '56',
        genesis_hash: BSC_MAINNET_GENESIS_HASH,
      },
      tx_hash: TX_HASH,
      execution_status: 'succeeded',
      transaction: verified.transaction,
      receipt: verified.receipt,
      canonical_block: verified.canonicalBlock,
      indexed_transaction: verified.indexedTransaction,
    })
  })

  it('ignores BSC capture endpoint and moving anchor but detects stable fact drift', () => {
    const first = bscVerified()
    const second = bscVerified(bscEndpoint('publicnode', 'publicnode_bsc_mainnet', '6'.repeat(64)))
    second.capturedAt = '2026-07-17T00:02:00.000Z'
    second.anchor.observedAt = '2026-07-17T00:01:59.000Z'
    second.anchor.verifiedAnchorHash = '7'.repeat(64)
    second.anchor.finalizedBlock = bscBlock({ number: '0x30', hash: HASH_C })

    expect(dexBscStableTransactionFactsSha256(second)).toBe(
      dexBscStableTransactionFactsSha256(first)
    )

    second.receipt.logs[0].data = '0x02'
    expect(dexBscStableTransactionFactsSha256(second)).not.toBe(
      dexBscStableTransactionFactsSha256(first)
    )
  })

  it('normalizes Solana provider context and optional reported index', () => {
    const first = solanaVerified()
    const second = solanaVerified()
    second.capturedAt = '2026-07-17T00:02:00.000Z'
    second.anchor.endpoint = {
      providerId: 'helius',
      endpointId: 'helius_mainnet',
      connectionHash: '8'.repeat(64),
    }
    second.anchor.observedAt = '2026-07-17T00:01:59.000Z'
    second.anchor.verifiedAnchorHash = '9'.repeat(64)
    second.signatureStatus.contextSlot = 120
    second.transaction.reportedTransactionIndex = null
    second.semanticHash = 'a'.repeat(64)

    const facts = buildDexSolanaStableTransactionFacts(second)
    expect(facts.data_contract).toBe(DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT)
    expect(facts.transaction).not.toHaveProperty('reportedTransactionIndex')
    expect(facts.signature_status).not.toHaveProperty('contextSlot')
    expect(dexSolanaStableTransactionFactsSha256(second)).toBe(
      dexSolanaStableTransactionFactsSha256(first)
    )
  })

  it('detects Solana membership, execution, and canonical block drift', () => {
    const baseline = solanaVerified()

    const membershipDrift = solanaVerified()
    membershipDrift.canonicalBlock.signatures.reverse()
    membershipDrift.transactionIndex = 0
    expect(dexSolanaStableTransactionFactsSha256(membershipDrift)).not.toBe(
      dexSolanaStableTransactionFactsSha256(baseline)
    )

    const executionDrift = solanaVerified()
    executionDrift.transaction.err = 'AccountNotFound'
    executionDrift.transaction.status = { Err: 'AccountNotFound' }
    executionDrift.signatureStatus.err = 'AccountNotFound'
    executionDrift.signatureStatus.status = { Err: 'AccountNotFound' }
    executionDrift.executionStatus = 'failed'
    executionDrift.candidateHitEligible = false
    expect(dexSolanaStableTransactionFactsSha256(executionDrift)).not.toBe(
      dexSolanaStableTransactionFactsSha256(baseline)
    )
  })
})
