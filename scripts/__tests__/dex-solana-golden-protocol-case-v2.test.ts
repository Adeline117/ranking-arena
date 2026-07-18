import { createHash } from 'node:crypto'

import {
  SOLANA_MAINNET_GENESIS_HASH,
  requireSolanaVerifiedChainAnchor,
  type SolanaChainAnchorEvidence,
  type SolanaEvidenceEndpointId,
  type SolanaEvidenceEndpointIdentity,
  type SolanaEvidenceProviderId,
  type SolanaRawRpcEvidenceExchange,
  type SolanaVerifiedChainAnchorRawCapture,
} from '../../lib/ingest/onchain/solana-evidence'
import {
  requireSolanaVerifiedTransactionFinality,
  type SolanaTransactionMembershipEvidence,
  type SolanaVerifiedTransactionFinalityRawCapture,
} from '../../lib/ingest/onchain/solana-transaction-evidence'
import manifestJson from '../fixtures/dex-solana-protocol-manifest.v1.json'
import { dexGoldenRemoteEndpointIdentity } from '../lib/dex-golden-rpc-evidence'
import type {
  DexSolanaGoldenRpcMetadataCaptureInput,
  DexSolanaGoldenRpcMetadataInput,
} from '../lib/dex-solana-golden-rpc-metadata'
import {
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT,
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION,
  buildDexSolanaGoldenProtocolCaseV2,
  dexSolanaGoldenProtocolCaseV2Sha256,
  dexSolanaProgramHitSourceDerivationV2Sha256,
  parseDexSolanaGoldenProtocolCaseV2,
  parseDexSolanaGoldenProtocolCaseV2Json,
  verifyDexSolanaGoldenProtocolCaseV2,
  type DexSolanaGoldenProtocolCaseV2BuildInput,
  type DexSolanaGoldenProtocolCaseV2VerifyInput,
} from '../lib/dex-solana-golden-protocol-case-v2'
import { dexSolanaProgramHitProjectionSha256 } from '../lib/dex-solana-program-hit-projection'

const CAPTURED_AT = '2026-07-18T09:00:00.000Z'
const METADATA_GENERATED_AT = '2026-07-18T09:01:00.000Z'
const CASE_GENERATED_AT = '2026-07-18T09:02:00.000Z'
const ROOT_SLOT = 1_000
const ANCHOR_SLOT = 999
const TRANSACTION_SLOT = 900
const BLOCK_TIME = Math.floor(Date.parse(CAPTURED_AT) / 1_000) - 60
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

type FixtureEndpointId = 'publicnode_solana_mainnet' | 'solana_official_mainnet'

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry
      digits[index] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let result = ''
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) {
    result += '1'
  }
  return (
    result +
    digits
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit])
      .join('')
  )
}

function syntheticBase58(byteLength: number, label: string): string {
  const bytes = new Uint8Array(byteLength)
  bytes[0] = 1
  for (const [index, character] of [...label].entries()) {
    if (index + 1 >= bytes.length) break
    bytes[index + 1] = character.charCodeAt(0)
  }
  return encodeBase58(bytes)
}

const SIGNATURE = syntheticBase58(64, 'v2-shared-public-signature')
const OTHER_SIGNATURE = syntheticBase58(64, 'v2-other-block-signature')
const THIRD_SIGNATURE = syntheticBase58(64, 'v2-third-block-signature')
const ANCHOR_BLOCK_HASH = syntheticBase58(32, 'v2-anchor-block')
const ANCHOR_PARENT_HASH = syntheticBase58(32, 'v2-anchor-parent')
const MEMBERSHIP_BLOCK_HASH = syntheticBase58(32, 'v2-membership-block')
const MEMBERSHIP_PARENT_HASH = syntheticBase58(32, 'v2-membership-parent')
const PAYER = syntheticBase58(32, 'v2-program-hit-payer')
const OTHER_PROGRAM_ID = syntheticBase58(32, 'v2-program-hit-other')
const LOOKUP_TABLE = syntheticBase58(32, 'v2-program-hit-lookup')
const LOADED_WRITABLE = syntheticBase58(32, 'v2-loaded-writable')
const LOADED_READONLY = syntheticBase58(32, 'v2-loaded-readonly')
const DRIFTED_LOADED_WRITABLE = syntheticBase58(32, 'v2-drifted-writable')

function endpoint(id: FixtureEndpointId): SolanaEvidenceEndpointIdentity {
  const golden = dexGoldenRemoteEndpointIdentity(id)
  return {
    providerId: golden.provider_id as SolanaEvidenceProviderId,
    endpointId: id as SolanaEvidenceEndpointId,
    connectionHash: golden.connection_hash,
  }
}

function provider(identity: SolanaEvidenceEndpointIdentity) {
  return {
    servedBy: { ...identity },
    attempted: [{ ...identity }],
  }
}

function lane<T>(value: T, identity: SolanaEvidenceEndpointIdentity) {
  return {
    status: 'available' as const,
    value,
    provider: provider(identity),
    httpStatus: 200,
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bodyEvidence(text: string, kind: 'request' | 'response') {
  const bytes = new TextEncoder().encode(text)
  return {
    bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    hashBasis:
      kind === 'request'
        ? ('utf8_json_rpc_request_body_bytes' as const)
        : ('fetch_content_decoded_http_entity_body_bytes_before_utf8' as const),
  }
}

function rawExchange(
  identity: SolanaEvidenceEndpointIdentity,
  laneName: SolanaRawRpcEvidenceExchange['lane'],
  method: string,
  params: unknown[],
  result: unknown
): SolanaRawRpcEvidenceExchange {
  return {
    chain: 'solana',
    trustBoundary: 'json_rpc_result_transport_only_semantic_lane_not_yet_verified',
    lane: laneName,
    method,
    endpoint: { ...identity },
    httpStatus: 200,
    completedAt: CAPTURED_AT,
    request: bodyEvidence(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'request'),
    response: bodyEvidence(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`, 'response'),
  }
}

interface CaptureOptions {
  instructionData?: string
  providerExtension?: unknown
}

interface MutableFixtureInstruction {
  programIdIndex: number
  accounts: number[]
  data: string
  stackHeight?: number
}

interface MutableFixtureTransactionResult {
  transaction: {
    message: {
      instructions: MutableFixtureInstruction[]
    }
  }
  meta: {
    loadedAddresses: {
      writable: string[]
      readonly: string[]
    }
    innerInstructions: Array<{
      index: number
      instructions: MutableFixtureInstruction[]
    }>
  }
}

function providerCapture(
  endpointId: FixtureEndpointId,
  options: CaptureOptions = {}
): DexSolanaGoldenRpcMetadataCaptureInput {
  const identity = endpoint(endpointId)
  const anchorBlock = {
    slot: ANCHOR_SLOT,
    blockhash: ANCHOR_BLOCK_HASH,
    previousBlockhash: ANCHOR_PARENT_HASH,
    parentSlot: ANCHOR_SLOT - 1,
    blockTime: BLOCK_TIME,
    blockHeight: ANCHOR_SLOT - 50,
  }
  const producedSlots = [ANCHOR_SLOT - 1, ANCHOR_SLOT]
  const anchorEvidence: SolanaChainAnchorEvidence = {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    observedAt: CAPTURED_AT,
    anchorPolicy: {
      version: 'solana_current_finalized_produced_block_v2',
      genesisMethod: 'getGenesisHash',
      rootSlotMethod: 'getSlot',
      producedSlotsMethod: 'getBlocks',
      producedSlotLookback: 512,
      minContextSlotPolicy: 'finalized_root_slot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: 60_000,
      maxCurrentAnchorLagMs: 900_000,
    },
    genesisHash: lane(SOLANA_MAINNET_GENESIS_HASH, identity),
    finalizedRootSlot: lane(ROOT_SLOT, identity),
    producedSlotResolution: lane(
      {
        rangeStartSlot: ROOT_SLOT - 512,
        rangeEndSlot: ROOT_SLOT,
        producedSlots,
        selectedSlot: ANCHOR_SLOT,
        selectionPolicy: 'highest_returned_finalized_produced_slot_v1',
      },
      identity
    ),
    finalizedBlock: lane(anchorBlock, identity),
  }
  const verifiedAnchor = requireSolanaVerifiedChainAnchor(anchorEvidence)
  const membershipBlock = {
    slot: TRANSACTION_SLOT,
    blockhash: MEMBERSHIP_BLOCK_HASH,
    previousBlockhash: MEMBERSHIP_PARENT_HASH,
    parentSlot: TRANSACTION_SLOT - 1,
    blockTime: BLOCK_TIME - 30,
    blockHeight: TRANSACTION_SLOT - 40,
    signatures: [OTHER_SIGNATURE, SIGNATURE, THIRD_SIGNATURE],
  }
  const normalizedTransaction = {
    slot: TRANSACTION_SLOT,
    blockTime: membershipBlock.blockTime,
    version: 0 as const,
    signatures: [SIGNATURE],
    reportedTransactionIndex: 1,
    err: null,
    status: { Ok: null } as const,
  }
  const normalizedStatus = {
    contextSlot: TRANSACTION_SLOT + 10,
    slot: TRANSACTION_SLOT,
    confirmations: null,
    confirmationStatus: 'finalized' as const,
    err: null,
    status: { Ok: null } as const,
  }
  const transactionEvidence: SolanaTransactionMembershipEvidence = {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    signature: SIGNATURE,
    capturedAt: CAPTURED_AT,
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
      endpoint: { ...verifiedAnchor.endpoint },
      verifiedAnchorHashPolicy: 'solana_verified_anchor_semantics_v2',
      verifiedAnchorHash: verifiedAnchor.semanticHash,
      observedAt: verifiedAnchor.observedAt,
      anchorPolicy: { ...verifiedAnchor.anchorPolicy },
      finalizedRootSlot: verifiedAnchor.finalizedRootSlot,
      producedSlotResolution: {
        ...verifiedAnchor.producedSlotResolution,
        producedSlots: [...verifiedAnchor.producedSlotResolution.producedSlots],
      },
      finalizedSlot: verifiedAnchor.finalizedSlot,
      finalizedBlock: { ...verifiedAnchor.finalizedBlock },
    },
    transaction: lane(normalizedTransaction, identity),
    signatureStatus: lane(normalizedStatus, identity),
    canonicalBlock: lane(membershipBlock, identity),
  }
  const verifiedTransaction = requireSolanaVerifiedTransactionFinality(
    transactionEvidence,
    anchorEvidence
  )

  const anchorRawExchanges = [
    rawExchange(identity, 'genesis_hash', 'getGenesisHash', [], SOLANA_MAINNET_GENESIS_HASH),
    rawExchange(
      identity,
      'finalized_anchor_slot',
      'getSlot',
      [{ commitment: 'finalized' }],
      ROOT_SLOT
    ),
    rawExchange(
      identity,
      'finalized_anchor_produced_slots',
      'getBlocks',
      [ROOT_SLOT - 512, ROOT_SLOT, { commitment: 'finalized', minContextSlot: ROOT_SLOT }],
      producedSlots
    ),
    rawExchange(
      identity,
      'finalized_anchor_block',
      'getBlock',
      [
        ANCHOR_SLOT,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'none',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        },
      ],
      {
        blockhash: anchorBlock.blockhash,
        previousBlockhash: anchorBlock.previousBlockhash,
        parentSlot: anchorBlock.parentSlot,
        blockTime: anchorBlock.blockTime,
        blockHeight: anchorBlock.blockHeight,
      }
    ),
  ] satisfies SolanaRawRpcEvidenceExchange[]
  const transactionRawExchanges = [
    rawExchange(
      identity,
      'transaction',
      'getTransaction',
      [
        SIGNATURE,
        {
          commitment: 'finalized',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        },
      ],
      {
        slot: normalizedTransaction.slot,
        blockTime: normalizedTransaction.blockTime,
        version: normalizedTransaction.version,
        transactionIndex: normalizedTransaction.reportedTransactionIndex,
        transaction: {
          signatures: normalizedTransaction.signatures,
          message: {
            header: {
              numRequiredSignatures: 1,
              numReadonlySignedAccounts: 0,
              numReadonlyUnsignedAccounts: 2,
            },
            accountKeys: [PAYER, JUPITER_PROGRAM_ID, OTHER_PROGRAM_ID],
            addressTableLookups: [
              {
                accountKey: LOOKUP_TABLE,
                writableIndexes: [4],
                readonlyIndexes: [9],
              },
            ],
            instructions: [
              {
                programIdIndex: 1,
                accounts: [0, 3],
                data: options.instructionData ?? '11111111',
              },
              {
                programIdIndex: 2,
                accounts: [4],
                data: '2',
              },
            ],
          },
        },
        meta: {
          err: normalizedTransaction.err,
          status: normalizedTransaction.status,
          fee: 5_000,
          loadedAddresses: {
            writable: [LOADED_WRITABLE],
            readonly: [LOADED_READONLY],
          },
          preBalances: [10_000, 0, 0, 0, 0],
          postBalances: [5_000, 0, 0, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
          innerInstructions: [
            {
              index: 1,
              instructions: [
                {
                  programIdIndex: 1,
                  accounts: [3, 4],
                  data: '2',
                  stackHeight: 2,
                },
              ],
            },
          ],
          logMessages: ['synthetic v2 same-lifecycle fixture'],
        },
        ...(options.providerExtension === undefined
          ? {}
          : { providerExtension: options.providerExtension }),
      }
    ),
    rawExchange(
      identity,
      'signature_status',
      'getSignatureStatuses',
      [[SIGNATURE], { searchTransactionHistory: true }],
      {
        context: { apiVersion: '4.0.0', slot: normalizedStatus.contextSlot },
        value: [
          {
            slot: normalizedStatus.slot,
            confirmations: null,
            confirmationStatus: 'finalized',
            err: normalizedStatus.err,
            status: normalizedStatus.status,
          },
        ],
      }
    ),
    rawExchange(
      identity,
      'membership_block',
      'getBlock',
      [
        TRANSACTION_SLOT,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'signatures',
          rewards: false,
        },
      ],
      {
        blockhash: membershipBlock.blockhash,
        previousBlockhash: membershipBlock.previousBlockhash,
        parentSlot: membershipBlock.parentSlot,
        blockTime: membershipBlock.blockTime,
        blockHeight: membershipBlock.blockHeight,
        signatures: membershipBlock.signatures,
      }
    ),
  ] satisfies SolanaRawRpcEvidenceExchange[]

  const anchor: SolanaVerifiedChainAnchorRawCapture = {
    evidence: anchorEvidence,
    verified: verifiedAnchor,
    rawExchanges: anchorRawExchanges,
  }
  const transaction: SolanaVerifiedTransactionFinalityRawCapture = {
    evidence: transactionEvidence,
    verified: verifiedTransaction,
    rawExchanges: transactionRawExchanges,
  }
  return { anchor, transaction }
}

function metadataInput(
  first = providerCapture('solana_official_mainnet'),
  second = providerCapture('publicnode_solana_mainnet')
): DexSolanaGoldenRpcMetadataInput {
  return {
    generated_at: METADATA_GENERATED_AT,
    captures: [first, second],
  }
}

function buildInput(metadata = metadataInput()): DexSolanaGoldenProtocolCaseV2BuildInput {
  return {
    generated_at: CASE_GENERATED_AT,
    case_id: 'solana-jupiter-program-hit-same-lifecycle-001',
    protocol_id: 'jupiter_swap_v6',
    manifest_input: manifestJson,
    metadata_input: metadata,
  }
}

function allRawBytes(input: DexSolanaGoldenRpcMetadataInput): Uint8Array[] {
  return input.captures.flatMap((capture) =>
    [...capture.anchor.rawExchanges, ...capture.transaction.rawExchanges].flatMap((exchange) => [
      exchange.request.bytes,
      exchange.response.bytes,
    ])
  )
}

function expectZeroed(bytes: readonly Uint8Array[]): void {
  expect(bytes).toHaveLength(28)
  for (const value of bytes) {
    expect([...value].every((byte) => byte === 0)).toBe(true)
  }
}

function setBody(
  body: SolanaRawRpcEvidenceExchange['request'] | SolanaRawRpcEvidenceExchange['response'],
  text: string
): void {
  const bytes = new TextEncoder().encode(text)
  body.bytes = bytes
  body.sha256 = sha256(bytes)
  body.byteLength = bytes.byteLength
}

function mutateTransactionData(input: DexSolanaGoldenRpcMetadataInput, data: string): void {
  for (const capture of input.captures) {
    const exchange = capture.transaction.rawExchanges[0]
    const payload = JSON.parse(new TextDecoder().decode(exchange.response.bytes)) as {
      result: { transaction: { message: { instructions: Array<{ data: string }> } } }
    }
    payload.result.transaction.message.instructions[0].data = data
    setBody(exchange.response, JSON.stringify(payload))
  }
}

function mutateOneTransactionResult(
  input: DexSolanaGoldenRpcMetadataInput,
  mutate: (result: MutableFixtureTransactionResult) => void
): void {
  const exchange = input.captures[0].transaction.rawExchanges[0]
  const payload: {
    result: MutableFixtureTransactionResult
  } = JSON.parse(new TextDecoder().decode(exchange.response.bytes))
  mutate(payload.result)
  setBody(exchange.response, JSON.stringify(payload))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function propertyNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) propertyNames(child, names)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      names.add(key)
      propertyNames(child, names)
    }
  }
  return names
}

describe('Solana same-lifecycle golden protocol case v2', () => {
  it('builds and recompiles a closed @2 case while every raw byte remains ephemeral', () => {
    const input = buildInput(
      metadataInput(
        providerCapture('solana_official_mainnet'),
        providerCapture('publicnode_solana_mainnet', {
          providerExtension: { providerVersion: 'different-but-unconsumed' },
        })
      )
    )
    const buildBytes = allRawBytes(input.metadata_input)
    const value = buildDexSolanaGoldenProtocolCaseV2(input)

    expect(parseDexSolanaGoldenProtocolCaseV2(value)).toEqual(value)
    expect(value).toMatchObject({
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION,
      data_contract: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT,
      verification_state: 'same_lifecycle_derived_not_persistently_replayable',
      protocol_manifest: {
        protocol_id: 'jupiter_swap_v6',
        manifest_declared_program_id: JUPITER_PROGRAM_ID,
      },
      golden_rpc_evidence: {
        transaction_id: SIGNATURE,
      },
      common_transaction_membership: {
        canonical_blockhash: MEMBERSHIP_BLOCK_HASH,
        transaction_index: 1,
      },
      common_program_hit_projection: {
        signature: SIGNATURE,
        target_program_id: JUPITER_PROGRAM_ID,
        transaction_version: 0,
        address_lookup_table_count: 1,
        resolved_account_keys_count: 5,
        inner_instructions_state: 'present',
        outer_instruction_count: 2,
        instruction_count: 3,
        target_hit_count: 2,
        hits: [
          {
            outer_index: 0,
            inner_index: null,
            program_id: JUPITER_PROGRAM_ID,
          },
          {
            outer_index: 1,
            inner_index: 0,
            program_id: JUPITER_PROGRAM_ID,
          },
        ],
      },
    })
    expect(value.required_blockers).toEqual([
      ...DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS,
    ])
    expect(
      Object.entries(value.claims)
        .filter(([key]) => key.endsWith('_same_lifecycle'))
        .every(([, enabled]) => enabled)
    ).toBe(true)
    expect(
      Object.entries(value.claims)
        .filter(([key]) => !key.endsWith('_same_lifecycle'))
        .every(([, enabled]) => enabled === false)
    ).toBe(true)
    expect(Object.values(value.authorization).every((enabled) => enabled === false)).toBe(true)
    for (const source of value.source_derivations) {
      expect(source.golden_rpc_evidence_sha256).toBe(value.golden_rpc_evidence.canonical_sha256)
      expect(source.stable_transaction_facts_sha256).toBe(
        value.common_transaction_membership.stable_transaction_facts_sha256
      )
      expect(source.program_hit_projection_sha256).toBe(value.common_program_hit_projection_sha256)
    }
    for (const forbidden of [
      'bytes',
      'body',
      'text',
      'raw_body',
      'normalized_body',
      'transaction_result',
      'dataBase58',
      'accountKeys',
      'instructions',
      'blob_locator',
    ]) {
      expect(propertyNames(value).has(forbidden)).toBe(false)
    }
    expectZeroed(buildBytes)

    const verifyInput = buildInput(
      metadataInput(
        providerCapture('solana_official_mainnet'),
        providerCapture('publicnode_solana_mainnet', {
          providerExtension: { providerVersion: 'different-but-unconsumed' },
        })
      )
    )
    const verifyBytes = allRawBytes(verifyInput.metadata_input)
    expect(
      verifyDexSolanaGoldenProtocolCaseV2({
        case_input: value,
        manifest_input: manifestJson,
        metadata_input: verifyInput.metadata_input,
      })
    ).toEqual(value)
    expectZeroed(verifyBytes)
  })

  it('pins every versioned binding and complete case hash', () => {
    const input = buildInput()
    const bytes = allRawBytes(input.metadata_input)
    const value = buildDexSolanaGoldenProtocolCaseV2(input)

    expect({
      projection_sha256: dexSolanaProgramHitProjectionSha256(value.common_program_hit_projection),
      first_source_binding_sha256: value.source_derivations[0].source_binding_sha256,
      second_source_binding_sha256: value.source_derivations[1].source_binding_sha256,
      source_closure_sha256: value.source_derivation_closure_sha256,
      case_sha256: dexSolanaGoldenProtocolCaseV2Sha256(value),
    }).toEqual({
      projection_sha256: 'ecba723b5a3f537ffd3fd3fbab633cc298b33c8ae8db9d32f6fdd33dabe78406',
      first_source_binding_sha256:
        'cb5b3581cf483f8749cc4feb0da806666c5ec7d7090c59237f56ef295d5e143c',
      second_source_binding_sha256:
        '9dadee4d67ceca09ead994414f22fdecb8c6f9c10a9a4c68a2549f92556a40d3',
      source_closure_sha256: 'de1e71a5096a9910272633fc49fd3dffe422fed66d851913a544780ef27272b8',
      case_sha256: 'af4db7553b4cbcff3927dc643674c299623836ab368fe8b3b6849c0cb4e5ecd1',
    })
    expectZeroed(bytes)
  })

  it('canonicalizes reversed capture order into the same complete case', () => {
    const firstInput = buildInput()
    const secondInput = buildInput(
      metadataInput(
        providerCapture('publicnode_solana_mainnet'),
        providerCapture('solana_official_mainnet')
      )
    )
    const firstBytes = allRawBytes(firstInput.metadata_input)
    const secondBytes = allRawBytes(secondInput.metadata_input)

    expect(buildDexSolanaGoldenProtocolCaseV2(secondInput)).toEqual(
      buildDexSolanaGoldenProtocolCaseV2(firstInput)
    )
    expectZeroed(firstBytes)
    expectZeroed(secondBytes)
  })

  it('rejects parser-level projection, membership, source, order, and claim tampering', () => {
    const baseline = buildDexSolanaGoldenProtocolCaseV2(buildInput())

    const projection = clone(baseline)
    projection.common_program_hit_projection.hits[0].data_sha256 = sha256(
      new TextEncoder().encode('forged instruction')
    )
    expect(() => parseDexSolanaGoldenProtocolCaseV2(projection)).toThrow(
      'common program-hit projection SHA'
    )

    const membership = clone(baseline)
    membership.common_transaction_membership.transaction_index += 1
    expect(() => parseDexSolanaGoldenProtocolCaseV2(membership)).toThrow(
      'source derivation does not close'
    )

    const source = clone(baseline)
    source.source_derivations[0].transaction_response_sha256 = sha256(
      new TextEncoder().encode('forged response')
    )
    expect(() => parseDexSolanaGoldenProtocolCaseV2(source)).toThrow(
      'source derivation binding SHA'
    )

    const closure = clone(baseline)
    closure.source_derivations[0].transaction_response_sha256 = sha256(
      new TextEncoder().encode('valid binding but stale closure')
    )
    const { source_binding_sha256: _binding, ...core } = closure.source_derivations[0]
    closure.source_derivations[0].source_binding_sha256 =
      dexSolanaProgramHitSourceDerivationV2Sha256(core)
    expect(() => parseDexSolanaGoldenProtocolCaseV2(closure)).toThrow(
      'source derivation closure SHA'
    )

    const reordered = clone(baseline)
    reordered.source_derivations.reverse()
    expect(() => parseDexSolanaGoldenProtocolCaseV2(reordered)).toThrow('canonically sorted')

    const overclaim = clone(baseline)
    Object.defineProperty(overclaim.claims, 'provider_independence_verified', {
      value: true,
      configurable: true,
      enumerable: true,
      writable: true,
    })
    expect(() => parseDexSolanaGoldenProtocolCaseV2(overclaim)).toThrow()

    const raw = clone(baseline)
    Object.defineProperty(raw.source_derivations[0], 'transaction_result', {
      value: { forbidden: true },
      configurable: true,
      enumerable: true,
      writable: true,
    })
    expect(() => parseDexSolanaGoldenProtocolCaseV2(raw)).toThrow()
  })

  it('verify recompiles raw sources and rejects valid-but-different projection or manifest drift', () => {
    const baseline = buildDexSolanaGoldenProtocolCaseV2(buildInput())

    const projectionDrift = buildInput()
    mutateTransactionData(projectionDrift.metadata_input, '2')
    const projectionBytes = allRawBytes(projectionDrift.metadata_input)
    expect(() =>
      verifyDexSolanaGoldenProtocolCaseV2({
        case_input: baseline,
        manifest_input: manifestJson,
        metadata_input: projectionDrift.metadata_input,
      })
    ).toThrow('conflicts with its recompiled sources')
    expectZeroed(projectionBytes)

    const manifestDrift = clone(manifestJson)
    manifestDrift.evidence_as_of = '2026-07-18T08:08:47.000Z'
    const manifestInput = buildInput()
    const manifestBytes = allRawBytes(manifestInput.metadata_input)
    expect(() =>
      verifyDexSolanaGoldenProtocolCaseV2({
        case_input: baseline,
        manifest_input: manifestDrift,
        metadata_input: manifestInput.metadata_input,
      })
    ).toThrow('conflicts with its recompiled sources')
    expectZeroed(manifestBytes)
  })

  it.each([
    [
      'instruction data',
      (result: MutableFixtureTransactionResult) => {
        result.transaction.message.instructions[0].data = '2'
      },
    ],
    [
      'program id',
      (result: MutableFixtureTransactionResult) => {
        result.meta.innerInstructions[0].instructions[0].programIdIndex = 2
      },
    ],
    [
      'instruction path',
      (result: MutableFixtureTransactionResult) => {
        result.meta.innerInstructions[0].index = 0
      },
    ],
    [
      'loaded address',
      (result: MutableFixtureTransactionResult) => {
        result.meta.loadedAddresses.writable[0] = DRIFTED_LOADED_WRITABLE
      },
    ],
  ] as const)('rejects one-source %s drift and zeroes every raw byte', (_label, mutate) => {
    const input = buildInput()
    mutateOneTransactionResult(input.metadata_input, mutate)
    const bytes = allRawBytes(input.metadata_input)

    expect(() => buildDexSolanaGoldenProtocolCaseV2(input)).toThrow(
      'disagree on the complete program-hit projection'
    )
    expectZeroed(bytes)
  })

  it.each(['manifest rejection', 'protocol rejection', 'outer-envelope rejection'] as const)(
    'zeroes every raw byte on early %s',
    (failure) => {
      const input = buildInput()
      const bytes = allRawBytes(input.metadata_input)
      if (failure === 'manifest rejection') {
        input.manifest_input = { ...manifestJson, unexpected: true }
      } else if (failure === 'protocol rejection') {
        input.protocol_id = 'missing_protocol'
      } else {
        Object.defineProperty(input, 'unexpected', {
          value: true,
          configurable: true,
          enumerable: true,
          writable: true,
        })
      }

      expect(() => buildDexSolanaGoldenProtocolCaseV2(input)).toThrow()
      expectZeroed(bytes)
    }
  )

  it('verify zeroes raw bytes even when the case parser fails before recompilation', () => {
    const input = buildInput()
    const bytes = allRawBytes(input.metadata_input)

    expect(() =>
      verifyDexSolanaGoldenProtocolCaseV2({
        case_input: { schema_version: 2 },
        manifest_input: manifestJson,
        metadata_input: input.metadata_input,
      })
    ).toThrow()
    expectZeroed(bytes)
  })

  it('rejects extra verify envelope fields, zeroes only metadata bytes, and preserves foreign bytes', () => {
    const baseline = buildDexSolanaGoldenProtocolCaseV2(buildInput())
    const input = buildInput()
    const bytes = allRawBytes(input.metadata_input)
    const foreignBytes = Uint8Array.of(7, 8, 9)
    const verifyInput: DexSolanaGoldenProtocolCaseV2VerifyInput = {
      case_input: baseline,
      manifest_input: { ...manifestJson, foreignBytes },
      metadata_input: input.metadata_input,
    }
    Object.defineProperty(verifyInput, 'callback', {
      value: () => baseline,
      configurable: true,
      enumerable: true,
      writable: true,
    })

    expect(() => verifyDexSolanaGoldenProtocolCaseV2(verifyInput)).toThrow(
      'verify input has an unexpected shape'
    )
    expectZeroed(bytes)
    expect([...foreignBytes]).toEqual([7, 8, 9])
  })

  it('rejects @1, duplicate JSON keys, noncanonical timestamps, and extra fields', () => {
    const baseline = buildDexSolanaGoldenProtocolCaseV2(buildInput())

    const legacy = clone(baseline)
    Object.defineProperty(legacy, 'schema_version', {
      value: 1,
      configurable: true,
      enumerable: true,
      writable: true,
    })
    Object.defineProperty(legacy, 'data_contract', {
      value: 'arena.dex.solana-golden-protocol-case@1',
      configurable: true,
      enumerable: true,
      writable: true,
    })
    expect(() => parseDexSolanaGoldenProtocolCaseV2(legacy)).toThrow()

    const duplicate = JSON.stringify(baseline).replace(
      '"schema_version":2',
      '"schema_version":2,"schema_version":2'
    )
    expect(() => parseDexSolanaGoldenProtocolCaseV2Json(duplicate)).toThrow('invalid strict JSON')

    const timestamp = clone(baseline)
    timestamp.generated_at = '2026-07-18T09:02:00Z'
    expect(() => parseDexSolanaGoldenProtocolCaseV2(timestamp)).toThrow('canonical ISO')

    const extra = clone(baseline)
    Object.defineProperty(extra.common_transaction_membership, 'block_time', {
      value: BLOCK_TIME,
      configurable: true,
      enumerable: true,
      writable: true,
    })
    expect(() => parseDexSolanaGoldenProtocolCaseV2(extra)).toThrow()
  })
})
