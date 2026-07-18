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
import { strictCanonicalJson } from '../lib/dex-contract-hash'
import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_SOLANA_GOLDEN_RPC_LANES,
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcEvidenceSha256,
  dexGoldenRpcParamsSha256,
  parseDexGoldenRpcEvidence,
} from '../lib/dex-golden-rpc-evidence'
import {
  compileDexSolanaGoldenRpcMetadata,
  compileDexSolanaGoldenRpcMetadataWithProgramHits,
  type DexSolanaGoldenRpcMetadataCaptureInput,
  type DexSolanaGoldenRpcMetadataInput,
  type DexSolanaGoldenRpcMetadataWithProgramHitsInput,
} from '../lib/dex-solana-golden-rpc-metadata'
import {
  dexSolanaProgramHitProjectionSha256,
  parseDexSolanaProgramHitProjection,
} from '../lib/dex-solana-program-hit-projection'

const CAPTURED_AT = '2026-07-18T09:00:00.000Z'
const GENERATED_AT = '2026-07-18T09:01:00.000Z'
const ROOT_SLOT = 1_000
const ANCHOR_SLOT = 999
const TRANSACTION_SLOT = 900
const BLOCK_TIME = Math.floor(Date.parse(CAPTURED_AT) / 1_000) - 60
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

type FixtureEndpointId =
  | 'alchemy_solana_mainnet'
  | 'publicnode_solana_mainnet'
  | 'solana_official_mainnet'

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
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) result += '1'
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

const SIGNATURE = syntheticBase58(64, 'shared-public-signature')
const OTHER_SIGNATURE = syntheticBase58(64, 'other-block-signature')
const THIRD_SIGNATURE = syntheticBase58(64, 'third-block-signature')
const DIFFERENT_TARGET_SIGNATURE = syntheticBase58(64, 'different-target-signature')
const ANCHOR_BLOCK_HASH = syntheticBase58(32, 'anchor-block')
const ANCHOR_PARENT_HASH = syntheticBase58(32, 'anchor-parent')
const MEMBERSHIP_BLOCK_HASH = syntheticBase58(32, 'membership-block')
const MEMBERSHIP_PARENT_HASH = syntheticBase58(32, 'membership-parent')
const PAYER = syntheticBase58(32, 'program-hit-payer')
const TARGET_PROGRAM_ID = syntheticBase58(32, 'program-hit-target')
const OTHER_PROGRAM_ID = syntheticBase58(32, 'program-hit-other')

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
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const response = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result,
  })}\n`
  return {
    chain: 'solana',
    trustBoundary: 'json_rpc_result_transport_only_semantic_lane_not_yet_verified',
    lane: laneName,
    method,
    endpoint: { ...identity },
    httpStatus: 200,
    completedAt: CAPTURED_AT,
    request: bodyEvidence(request, 'request'),
    response: bodyEvidence(response, 'response'),
  }
}

interface CaptureOptions {
  signature?: string
  membershipBlockHash?: string
  programHitTransaction?: boolean
  providerExtension?: unknown
}

function providerCapture(
  endpointId: FixtureEndpointId,
  options: CaptureOptions = {}
): DexSolanaGoldenRpcMetadataCaptureInput {
  const identity = endpoint(endpointId)
  const signature = options.signature ?? SIGNATURE
  const membershipBlockHash = options.membershipBlockHash ?? MEMBERSHIP_BLOCK_HASH
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
    blockhash: membershipBlockHash,
    previousBlockhash: MEMBERSHIP_PARENT_HASH,
    parentSlot: TRANSACTION_SLOT - 1,
    blockTime: BLOCK_TIME - 30,
    blockHeight: TRANSACTION_SLOT - 40,
    signatures: [OTHER_SIGNATURE, signature, THIRD_SIGNATURE],
  }
  const normalizedTransaction = {
    slot: TRANSACTION_SLOT,
    blockTime: membershipBlock.blockTime,
    version: 0 as const,
    signatures: [signature],
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
    signature,
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
        signature,
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
          message: options.programHitTransaction
            ? {
                header: {
                  numRequiredSignatures: 1,
                  numReadonlySignedAccounts: 0,
                  numReadonlyUnsignedAccounts: 2,
                },
                accountKeys: [PAYER, TARGET_PROGRAM_ID, OTHER_PROGRAM_ID],
                addressTableLookups: [],
                instructions: [
                  {
                    programIdIndex: 1,
                    accounts: [0],
                    data: '11111111',
                  },
                ],
              }
            : { providerOnly: true },
        },
        meta: {
          err: normalizedTransaction.err,
          status: normalizedTransaction.status,
          fee: 5_000,
          ...(options.programHitTransaction
            ? {
                loadedAddresses: { writable: [], readonly: [] },
                preBalances: [10_000, 0, 0],
                postBalances: [5_000, 0, 0],
                preTokenBalances: [],
                postTokenBalances: [],
                innerInstructions: [],
                logMessages: ['synthetic same-lifecycle fixture'],
              }
            : {}),
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
      [[signature], { searchTransactionHistory: true }],
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

function compilerInput(
  first = providerCapture('solana_official_mainnet'),
  second = providerCapture('publicnode_solana_mainnet')
): DexSolanaGoldenRpcMetadataInput {
  return {
    generated_at: GENERATED_AT,
    captures: [first, second],
  }
}

function programHitCompilerInput(
  first = providerCapture('solana_official_mainnet', { programHitTransaction: true }),
  second = providerCapture('publicnode_solana_mainnet', { programHitTransaction: true })
): DexSolanaGoldenRpcMetadataWithProgramHitsInput {
  return {
    metadata_input: compilerInput(first, second),
    target_program_id: TARGET_PROGRAM_ID,
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

function setRequest(
  exchange: SolanaRawRpcEvidenceExchange,
  method: string,
  params: unknown[]
): void {
  setBody(exchange.request, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
}

function mutateResponse(
  exchange: SolanaRawRpcEvidenceExchange,
  mutate: (payload: Record<string, unknown>) => void
): void {
  const payload = JSON.parse(new TextDecoder().decode(exchange.response.bytes)) as Record<
    string,
    unknown
  >
  mutate(payload)
  setBody(exchange.response, JSON.stringify(payload))
}

function strictDocumentMetadata(value: unknown) {
  const text = strictCanonicalJson(value)
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    byte_length: Buffer.byteLength(text),
  }
}

function expectFailureAndZeroing(input: DexSolanaGoldenRpcMetadataInput, message?: string): void {
  const bytes = allRawBytes(input)
  if (message) {
    expect(() => compileDexSolanaGoldenRpcMetadata(input)).toThrow(message)
  } else {
    expect(() => compileDexSolanaGoldenRpcMetadata(input)).toThrow()
  }
  expectZeroed(bytes)
}

function aliasedRequestBytes(input: DexSolanaGoldenRpcMetadataInput) {
  const first = input.captures[0].anchor.rawExchanges[0].request
  const second = input.captures[1].anchor.rawExchanges[0].request
  second.bytes = first.bytes
  second.sha256 = first.sha256
  second.byteLength = first.byteLength
  return first.bytes
}

function propertyNames(value: unknown, names = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) return names
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, names)
    return names
  }
  for (const [key, child] of Object.entries(value)) {
    names.add(key)
    propertyNames(child, names)
  }
  return names
}

describe('Solana in-memory golden RPC metadata compiler', () => {
  it('builds a canonical parseable metadata-only v3 envelope and zeroes every raw byte', () => {
    const input = compilerInput()
    const bytes = allRawBytes(input)
    const expectedRaw = input.captures.map((capture) =>
      [...capture.anchor.rawExchanges, ...capture.transaction.rawExchanges].map((exchange) => ({
        lane: exchange.lane,
        requestSha256: exchange.request.sha256,
        requestLength: exchange.request.byteLength,
        responseSha256: exchange.response.sha256,
        responseLength: exchange.response.byteLength,
        paramsSha256: dexGoldenRpcParamsSha256(
          exchange.method,
          (
            JSON.parse(new TextDecoder().decode(exchange.request.bytes)) as {
              params: unknown[]
            }
          ).params
        ),
      }))
    )
    const expectedDocuments = new Map(
      input.captures.map((capture) => [
        capture.anchor.verified.endpoint.endpointId,
        {
          anchor: strictDocumentMetadata(capture.anchor.evidence),
          membership: strictDocumentMetadata(capture.transaction.evidence),
          verified: strictDocumentMetadata(
            requireSolanaVerifiedTransactionFinality(
              capture.transaction.evidence,
              capture.anchor.evidence
            )
          ),
        },
      ])
    )

    const evidence = compileDexSolanaGoldenRpcMetadata(input)

    expect(parseDexGoldenRpcEvidence(evidence)).toEqual(evidence)
    expect(evidence.data_contract).toBe(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT)
    expect(dexGoldenRpcEvidenceSha256(evidence)).toBe(
      'bdd5a82e8db3c9f7d85e202b205cd1cd3527779e9ea724acc331d1b291fe0d45'
    )
    expect(evidence.captures.map((capture) => capture.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    expect(evidence.required_blockers).toEqual([
      'decoder_facts_unverified',
      'normalized_documents_not_replayed',
      'protocol_invocation_unverified',
      'provider_independence_not_attested',
      'raw_and_normalized_bodies_not_persisted',
      'raw_blob_persistence_not_authorized',
    ])
    expect(Object.values(evidence.claims).every((value) => value === false)).toBe(true)
    expect(Object.values(evidence.authorization).every((value) => value === false)).toBe(true)
    expect(evidence.verification_state).toBe('declared_not_replayed')
    const names = propertyNames(evidence)
    expect(names.has('bytes')).toBe(false)
    expect(names.has('body')).toBe(false)
    expect(names.has('text')).toBe(false)
    expect(names.has('raw_body')).toBe(false)
    expect(names.has('normalized_body')).toBe(false)
    expect(names.has('blob_locator')).toBe(false)

    for (const capture of evidence.captures) {
      const inputIndex = input.captures.findIndex(
        (value) => value.anchor.verified.endpoint.endpointId === capture.endpoint.endpoint_id
      )
      const raw = expectedRaw[inputIndex]
      expect(capture.rpc_exchanges).toHaveLength(DEX_SOLANA_GOLDEN_RPC_LANES.length)
      capture.rpc_exchanges.forEach((exchange, index) => {
        expect(exchange).toMatchObject({
          lane: raw[index].lane,
          params_sha256: raw[index].paramsSha256,
          request: {
            sha256: raw[index].requestSha256,
            byte_length: raw[index].requestLength,
            persistence_state: 'not_persisted',
            content_available_for_replay: false,
          },
          response: {
            sha256: raw[index].responseSha256,
            byte_length: raw[index].responseLength,
            persistence_state: 'not_persisted',
            content_available_for_replay: false,
          },
        })
      })
      const documents = expectedDocuments.get(capture.endpoint.endpoint_id)
      expect(capture.normalized_documents.chain_anchor).toMatchObject(documents?.anchor ?? {})
      expect(capture.normalized_documents.transaction_membership).toMatchObject(
        documents?.membership ?? {}
      )
      expect(capture.normalized_documents.verified_finality).toMatchObject(
        documents?.verified ?? {}
      )
      for (const document of Object.values(capture.normalized_documents)) {
        expect(document.persistence_state).toBe('not_persisted')
        expect(document.content_available_for_replay).toBe(false)
      }
      expect(capture.provider_finality_witness).toMatchObject({
        policy: 'solana_verified_transaction_finality_semantics_v2',
        semantic_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    }
    expectZeroed(bytes)
  })

  it.each([
    ['success', false],
    ['final envelope rejection', true],
  ] as const)('zeroes compiler-derived canonical UTF-8 bytes on %s', (_label, rejectEnvelope) => {
    const input = compilerInput()
    const rawBytes = allRawBytes(input)
    if (rejectEnvelope) input.generated_at = '2026-07-18T08:59:59.000Z'

    const derivedBytes: Uint8Array[] = []
    const originalEncode = TextEncoder.prototype.encode
    const encodeSpy = jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      value?: string
    ) {
      const bytes = Reflect.apply(originalEncode, this, [value]) as Uint8Array
      derivedBytes.push(bytes)
      return bytes
    })
    try {
      if (rejectEnvelope) {
        expect(() => compileDexSolanaGoldenRpcMetadata(input)).toThrow(
          'cannot be generated before a capture completes'
        )
      } else {
        expect(() => compileDexSolanaGoldenRpcMetadata(input)).not.toThrow()
      }
    } finally {
      encodeSpy.mockRestore()
    }

    expect(derivedBytes).toHaveLength(6)
    for (const bytes of derivedBytes) {
      expect([...bytes].every((byte) => byte === 0)).toBe(true)
    }
    expectZeroed(rawBytes)
  })

  it.each(['success', 'strict verifier failure'] as const)(
    'zeroes an aliased raw Uint8Array on %s',
    (outcome) => {
      const input = compilerInput()
      const aliasedBytes = aliasedRequestBytes(input)
      const bytes = allRawBytes(input)
      if (outcome === 'strict verifier failure') {
        Object.defineProperty(input.captures[0].anchor.evidence, 'unexpected', {
          configurable: true,
          enumerable: true,
          value: true,
          writable: true,
        })
        expect(() => compileDexSolanaGoldenRpcMetadata(input)).toThrow(
          'Solana chain anchor is not fully verified'
        )
      } else {
        expect(() => compileDexSolanaGoldenRpcMetadata(input)).not.toThrow()
      }
      for (let index = 0; index < aliasedBytes.byteLength; index += 1) {
        expect(aliasedBytes[index]).toBe(0)
      }
      expectZeroed(bytes)
    }
  )

  it('bypasses forged instance fill and iterator methods with TypedArray intrinsics', () => {
    const input = compilerInput()
    const bytes = input.captures[0].anchor.rawExchanges[0].request.bytes
    const byteLength = bytes.byteLength
    const forgedFill = jest.fn(() => bytes)
    const forgedIterator = jest.fn(function* () {
      yield 0
    })
    Object.defineProperty(bytes, 'fill', {
      configurable: true,
      value: forgedFill,
    })
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      value: forgedIterator,
    })

    expect(() => compileDexSolanaGoldenRpcMetadata(input)).not.toThrow()
    expect(forgedFill).not.toHaveBeenCalled()
    expect(forgedIterator).not.toHaveBeenCalled()
    for (let index = 0; index < byteLength; index += 1) {
      expect(bytes[index]).toBe(0)
    }
  })

  it('ignores forged embedded verified fields and reconstructs both strict verifiers', () => {
    const input = compilerInput()
    ;(input.captures[0].anchor as { verified: unknown }).verified = { forged: true }
    ;(input.captures[0].transaction as { verified: unknown }).verified = { forged: true }
    const bytes = allRawBytes(input)

    expect(() => compileDexSolanaGoldenRpcMetadata(input)).not.toThrow()
    expectZeroed(bytes)
  })

  it('rejects stable provider-neutral fact disagreement', () => {
    const input = compilerInput(
      providerCapture('solana_official_mainnet'),
      providerCapture('publicnode_solana_mainnet', {
        membershipBlockHash: syntheticBase58(32, 'provider-drifted-membership-block'),
      })
    )
    expectFailureAndZeroing(input, 'disagree on stable transaction facts')
  })

  it('requires the exact two approved credential-free public endpoints', () => {
    const duplicated = compilerInput(
      providerCapture('solana_official_mainnet'),
      providerCapture('solana_official_mainnet')
    )
    expectFailureAndZeroing(duplicated, 'official and PublicNode')

    const credentialEndpoint = compilerInput(
      providerCapture('publicnode_solana_mainnet'),
      providerCapture('alchemy_solana_mainnet')
    )
    expectFailureAndZeroing(credentialEndpoint, 'credential-free public Solana endpoints')
  })

  it('rejects a raw endpoint that is not the endpoint bound into its anchor', () => {
    const input = compilerInput()
    input.captures[0].anchor.rawExchanges[0].endpoint = endpoint('publicnode_solana_mainnet')
    expectFailureAndZeroing(input, 'raw RPC endpoint does not match')
  })

  it('rejects a raw response result that disagrees with strict normalized evidence', () => {
    const input = compilerInput()
    mutateResponse(input.captures[0].anchor.rawExchanges[1], (payload) => {
      payload.result = ROOT_SLOT + 1
    })
    expectFailureAndZeroing(input, 'finalized root result does not match evidence')
  })

  it.each(['reordered lane', 'wrong lane', 'wrong method', 'wrong params'] as const)(
    'rejects %s while preserving the exact lane contract',
    (fault) => {
      const input = compilerInput()
      const exchanges = input.captures[0].anchor.rawExchanges
      if (fault === 'reordered lane') {
        ;[exchanges[0], exchanges[1]] = [exchanges[1], exchanges[0]]
      } else if (fault === 'wrong lane') {
        exchanges[0].lane = 'finalized_anchor_slot'
      } else if (fault === 'wrong method') {
        exchanges[0].method = 'getSlot'
      } else {
        setRequest(exchanges[1], 'getSlot', [{ commitment: 'processed' }])
      }
      expectFailureAndZeroing(input)
    }
  )

  it.each(['request hash', 'request length', 'response hash', 'response length'] as const)(
    'rejects a forged raw %s',
    (fault) => {
      const input = compilerInput()
      const exchange = input.captures[0].anchor.rawExchanges[0]
      if (fault === 'request hash') exchange.request.sha256 = 'a'.repeat(64)
      if (fault === 'request length') exchange.request.byteLength += 1
      if (fault === 'response hash') exchange.response.sha256 = 'b'.repeat(64)
      if (fault === 'response length') exchange.response.byteLength += 1
      expectFailureAndZeroing(input, 'hash or byte length is forged')
    }
  )

  it('rejects normalized evidence that no longer passes the strict verifier', () => {
    const input = compilerInput()
    Object.defineProperty(input.captures[0].anchor.evidence, 'unexpected', {
      configurable: true,
      enumerable: true,
      value: 'forged',
      writable: true,
    })
    expectFailureAndZeroing(input, 'Solana chain anchor is not fully verified')
  })

  it('requires generated_at to follow every completed capture', () => {
    const input = compilerInput()
    input.generated_at = '2026-07-18T08:59:59.000Z'
    expectFailureAndZeroing(input, 'cannot be generated before a capture completes')
  })

  it('requires both verified captures to name the same public signature', () => {
    const input = compilerInput(
      providerCapture('solana_official_mainnet'),
      providerCapture('publicnode_solana_mainnet', {
        signature: DIFFERENT_TARGET_SIGNATURE,
      })
    )
    expectFailureAndZeroing(input, 'same public transaction signature')
  })

  it('rejects credential-named JSON keys and still zeroes every byte', () => {
    const input = compilerInput()
    mutateResponse(input.captures[0].anchor.rawExchanges[0], (payload) => {
      payload.api_key = 'not-allowed-in-ephemeral-evidence'
    })
    expectFailureAndZeroing(input, 'credential-named keys')
  })

  it.each(['request', 'response'] as const)(
    'requires an exact successful JSON-RPC %s envelope',
    (kind) => {
      const input = compilerInput()
      const exchange = input.captures[0].anchor.rawExchanges[0]
      if (kind === 'request') {
        setBody(
          exchange.request,
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getGenesisHash',
            params: [],
            trace: 'benign-but-unbound',
          })
        )
      } else {
        mutateResponse(exchange, (payload) => {
          payload.trace = 'benign-but-unbound'
        })
      }
      expectFailureAndZeroing(input, 'unexpected shape')
    }
  )

  it.each([
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123',
    'sk_live_1234567890abcdef',
    'https://rpc.example.invalid/?api-key=supersecret',
  ])('rejects credential-like text %s and zeroes every byte', (secret) => {
    const input = compilerInput()
    mutateResponse(input.captures[0].anchor.rawExchanges[0], (payload) => {
      payload.providerNote = secret
    })
    expectFailureAndZeroing(input, 'credential-like text')
  })

  it.each(['invalid UTF-8', 'duplicate-key JSON'] as const)(
    'rejects %s before metadata can be emitted',
    (fault) => {
      const input = compilerInput()
      const request = input.captures[0].anchor.rawExchanges[0].request
      if (fault === 'invalid UTF-8') {
        request.bytes = Uint8Array.from([0xc3, 0x28])
        request.sha256 = sha256(request.bytes)
        request.byteLength = request.bytes.byteLength
      } else {
        setBody(
          request,
          '{"jsonrpc":"2.0","jsonrpc":"2.0","id":1,"method":"getGenesisHash","params":[]}'
        )
      }
      expectFailureAndZeroing(input)
    }
  )
})

describe('Solana same-lifecycle metadata and program-hit compiler', () => {
  it('derives one closed common projection before zeroing every owned byte', () => {
    const input = programHitCompilerInput(
      providerCapture('solana_official_mainnet', { programHitTransaction: true }),
      providerCapture('publicnode_solana_mainnet', {
        programHitTransaction: true,
        providerExtension: { apiVersion: 'provider-specific-v2' },
      })
    )
    const rawBytes = allRawBytes(input.metadata_input)
    const derivedBytes: Uint8Array[] = []
    const originalEncode = TextEncoder.prototype.encode
    const encodeSpy = jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      value?: string
    ) {
      const bytes = Reflect.apply(originalEncode, this, [value]) as Uint8Array
      derivedBytes.push(bytes)
      return bytes
    })
    let compiled: ReturnType<typeof compileDexSolanaGoldenRpcMetadataWithProgramHits>
    try {
      compiled = compileDexSolanaGoldenRpcMetadataWithProgramHits(input)
    } finally {
      encodeSpy.mockRestore()
    }

    expect(parseDexGoldenRpcEvidence(compiled.golden_rpc_evidence)).toEqual(
      compiled.golden_rpc_evidence
    )
    expect(compiled.common_transaction_membership).toEqual({
      stable_transaction_facts_sha256: compiled.golden_rpc_evidence.stable_transaction_facts_sha256,
      canonical_blockhash: MEMBERSHIP_BLOCK_HASH,
      transaction_index: 1,
    })
    expect(parseDexSolanaProgramHitProjection(compiled.common_program_hit_projection)).toEqual(
      compiled.common_program_hit_projection
    )
    expect(compiled.common_program_hit_projection).toMatchObject({
      signature: SIGNATURE,
      slot_decimal: String(TRANSACTION_SLOT),
      transaction_version: 0,
      execution_status: 'succeeded',
      target_program_id: TARGET_PROGRAM_ID,
      target_hit_count: 1,
      inner_instructions_state: 'verified_empty',
    })
    expect(compiled.common_program_hit_projection_sha256).toBe(
      dexSolanaProgramHitProjectionSha256(compiled.common_program_hit_projection)
    )
    expect(compiled.common_program_hit_projection_sha256).toBe(
      '5c6172bddcd782d59622a1dc789868bcc474c8a09c12ab336158eff80771456c'
    )
    expect(compiled.source_derivations.map((source) => source.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    for (const source of compiled.source_derivations) {
      expect(source.program_hit_projection_sha256).toBe(
        compiled.common_program_hit_projection_sha256
      )
      const capture = compiled.golden_rpc_evidence.captures.find(
        (candidate) => candidate.endpoint.endpoint_id === source.endpoint.endpoint_id
      )
      const transactionExchange = capture?.rpc_exchanges.find(
        (exchange) => exchange.lane === 'transaction'
      )
      expect(source).toMatchObject({
        endpoint: capture?.endpoint,
        capture_completed_at: capture?.capture_completed_at,
        transaction_exchange_binding_sha256: transactionExchange?.exchange_binding_sha256,
        transaction_response_sha256: transactionExchange?.response.sha256,
      })
    }
    expect(compiled.source_derivations[0].transaction_response_sha256).not.toBe(
      compiled.source_derivations[1].transaction_response_sha256
    )

    const names = propertyNames(compiled)
    for (const forbiddenName of [
      'transaction_result',
      'dataBase58',
      'staticAccountKeys',
      'accountKeys',
      'instructions',
      'bytes',
      'text',
      'raw_body',
      'normalized_body',
      'blob_locator',
    ]) {
      expect(names.has(forbiddenName)).toBe(false)
    }
    expectZeroed(rawBytes)
    expect(derivedBytes).toHaveLength(6)
    for (const bytes of derivedBytes) {
      expect([...bytes].every((byte) => byte === 0)).toBe(true)
    }
  })

  it('is deterministic when the two capture inputs arrive in reverse order', () => {
    const first = programHitCompilerInput()
    const second = programHitCompilerInput(
      providerCapture('publicnode_solana_mainnet', { programHitTransaction: true }),
      providerCapture('solana_official_mainnet', { programHitTransaction: true })
    )
    const firstBytes = allRawBytes(first.metadata_input)
    const secondBytes = allRawBytes(second.metadata_input)

    const firstCompiled = compileDexSolanaGoldenRpcMetadataWithProgramHits(first)
    const secondCompiled = compileDexSolanaGoldenRpcMetadataWithProgramHits(second)

    expect(secondCompiled).toEqual(firstCompiled)
    expectZeroed(firstBytes)
    expectZeroed(secondBytes)
  })

  it('rejects complete projection drift and zeroes both providers before throwing', () => {
    const input = programHitCompilerInput()
    mutateResponse(input.metadata_input.captures[1].transaction.rawExchanges[0], (payload) => {
      const result = payload.result as {
        transaction: { message: { instructions: Array<{ data: string }> } }
      }
      result.transaction.message.instructions[0].data = '2'
    })
    const rawBytes = allRawBytes(input.metadata_input)
    const derivedBytes: Uint8Array[] = []
    const originalEncode = TextEncoder.prototype.encode
    const encodeSpy = jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      value?: string
    ) {
      const bytes = Reflect.apply(originalEncode, this, [value]) as Uint8Array
      derivedBytes.push(bytes)
      return bytes
    })

    try {
      expect(() => compileDexSolanaGoldenRpcMetadataWithProgramHits(input)).toThrow(
        'disagree on the complete program-hit projection'
      )
    } finally {
      encodeSpy.mockRestore()
    }
    expectZeroed(rawBytes)
    expect(derivedBytes).toHaveLength(6)
    for (const bytes of derivedBytes) {
      expect([...bytes].every((byte) => byte === 0)).toBe(true)
    }
  })

  it.each(['incomplete transaction result', 'target-free transaction result'] as const)(
    'fails closed for a %s and zeroes every raw request and response',
    (fault) => {
      const input =
        fault === 'incomplete transaction result'
          ? {
              metadata_input: compilerInput(),
              target_program_id: TARGET_PROGRAM_ID,
            }
          : programHitCompilerInput()
      if (fault === 'target-free transaction result') {
        input.target_program_id = syntheticBase58(32, 'absent-program')
      }
      const rawBytes = allRawBytes(input.metadata_input)

      expect(() => compileDexSolanaGoldenRpcMetadataWithProgramHits(input)).toThrow()
      expectZeroed(rawBytes)
    }
  )

  it('uses captured TypedArray fill intrinsics for projection and raw-byte cleanup', () => {
    const input = programHitCompilerInput()
    const rawBytes = allRawBytes(input.metadata_input)
    const fillSpy = jest.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array
    ) {
      return this
    })
    try {
      expect(() => compileDexSolanaGoldenRpcMetadataWithProgramHits(input)).not.toThrow()
    } finally {
      fillSpy.mockRestore()
    }

    expect(fillSpy).not.toHaveBeenCalled()
    expectZeroed(rawBytes)
  })

  it('rejects extra compiler envelope fields without leaking owned bytes', () => {
    const input = {
      ...programHitCompilerInput(),
      callback: () => 'forbidden',
    }
    const rawBytes = allRawBytes(input.metadata_input)

    expect(() => compileDexSolanaGoldenRpcMetadataWithProgramHits(input as never)).toThrow(
      'program-hit compiler input has an unexpected shape'
    )
    expectZeroed(rawBytes)
  })
})
