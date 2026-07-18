import { createHash } from 'node:crypto'

import { PublicKey } from '@solana/web3.js'

import {
  captureSolanaV3ProgramDeploymentObservation,
  SOLANA_BPF_LOADER_V3,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  type SolanaV3ProgramDeploymentRawCapture,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import type { SolanaRawRpcEvidenceExchange } from '../../lib/ingest/onchain/solana-evidence-core'
import {
  RAW_RPC_REQUEST_HASH_BASIS,
  RAW_RPC_RESPONSE_HASH_BASIS,
} from '../../lib/ingest/onchain/raw-rpc-evidence'
import {
  compileDexSolanaV3CurrentProgramStateEvidence,
  disposeDexSolanaV3ProgramStateCompilerInputBytes,
} from '../lib/dex-solana-program-deployment-metadata'

const PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const PROGRAMDATA_ADDRESS = '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT'
const UPGRADE_AUTHORITY = 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ'
const PUBLICNODE_ROOT_SLOT = 433_666_418
const OFFICIAL_ROOT_SLOT = 433_666_434
const LAST_MODIFIED_SLOT = 433_056_714n
const CAPTURE_NOW = '2026-07-18T00:00:00.000Z'
const GENERATED_AT = '2026-07-18T00:00:20.000Z'
const PUBLICNODE_RPC_URL = 'https://solana-rpc.publicnode.com/'
const OFFICIAL_RPC_URL = 'https://api.mainnet-beta.solana.com/'
const PUBLICNODE_BLOCKHASH = '66VMKCNBU8H2CQsYVFm94vv8Qobz7EgxPTxw7CyystSu'
const OFFICIAL_BLOCKHASH = PROGRAMDATA_ADDRESS
const PREVIOUS_BLOCKHASH = '3kvmuuz5t9rDT3YBdBhhrRwEcn9hnMnVm4nLXNzrro93'

type CapturePair = [SolanaV3ProgramDeploymentRawCapture, SolanaV3ProgramDeploymentRawCapture]

interface RpcRequest {
  jsonrpc: '2.0'
  id: 1
  method: string
  params: unknown[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function programBytes(): Buffer {
  const bytes = Buffer.alloc(36)
  bytes.writeUInt32LE(2, 0)
  new PublicKey(PROGRAMDATA_ADDRESS).toBuffer().copy(bytes, 4)
  return bytes
}

function programDataBytes(codeSeed = 0): Buffer {
  const code = Uint8Array.from({ length: 256 }, (_value, index) => (codeSeed + index * 37) % 256)
  const bytes = Buffer.alloc(SOLANA_V3_PROGRAMDATA_HEADER_BYTES + code.byteLength)
  bytes.writeUInt32LE(3, 0)
  bytes.writeBigUInt64LE(LAST_MODIFIED_SLOT, 4)
  bytes[12] = 1
  new PublicKey(UPGRADE_AUTHORITY).toBuffer().copy(bytes, 13)
  bytes.set(code, SOLANA_V3_PROGRAMDATA_HEADER_BYTES)
  return bytes
}

function rpcAccount(bytes: Uint8Array, executable: boolean) {
  return {
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
    executable,
    lamports: 1_234_567,
    owner: SOLANA_BPF_LOADER_V3,
    rentEpoch: 1,
    space: bytes.byteLength,
  }
}

function endpointFacts(input: RequestInfo | URL) {
  const text = String(input)
  const official = text.includes('api.mainnet-beta.solana.com')
  return {
    rootSlot: official ? OFFICIAL_ROOT_SLOT : PUBLICNODE_ROOT_SLOT,
    blockhash: official ? OFFICIAL_BLOCKHASH : PUBLICNODE_BLOCKHASH,
    apiVersion: official ? '2.2.0' : '2.1.21',
  }
}

function installRpcFetchMock(): void {
  global.fetch = jest.fn(async (input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    const facts = endpointFacts(input)
    const result =
      request.method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS_HASH
        : request.method === 'getSlot'
          ? facts.rootSlot
          : request.method === 'getBlocks'
            ? [facts.rootSlot]
            : request.method === 'getBlock'
              ? {
                  blockhash: facts.blockhash,
                  previousBlockhash: PREVIOUS_BLOCKHASH,
                  parentSlot: facts.rootSlot - 1,
                  blockTime: Math.floor(Date.parse(CAPTURE_NOW) / 1000) - 30,
                  blockHeight: facts.rootSlot - 10,
                }
              : {
                  context: {
                    apiVersion: facts.apiVersion,
                    slot: facts.rootSlot,
                  },
                  value: [rpcAccount(programBytes(), true), rpcAccount(programDataBytes(), false)],
                }
    const sourceBytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let emitted = false
          return {
            read: jest.fn(async () => {
              if (emitted) return { done: true, value: undefined }
              emitted = true
              return { done: false, value: sourceBytes }
            }),
            cancel: jest.fn(async () => undefined),
          }
        },
      },
    } as Response
  }) as jest.MockedFunction<typeof fetch>
}

async function captureEndpoint(
  endpointId: 'publicnode_solana_mainnet' | 'solana_official_mainnet'
): Promise<SolanaV3ProgramDeploymentRawCapture> {
  jest.setSystemTime(new Date(CAPTURE_NOW))
  const pending = captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
    endpointId,
    rpcUrl: endpointId === 'publicnode_solana_mainnet' ? PUBLICNODE_RPC_URL : OFFICIAL_RPC_URL,
    timeoutMs: 20_000,
  })
  if (endpointId === 'publicnode_solana_mainnet') {
    await jest.advanceTimersByTimeAsync(20_000)
  }
  return pending
}

async function capturePair(): Promise<CapturePair> {
  const publicNode = await captureEndpoint('publicnode_solana_mainnet')
  const official = await captureEndpoint('solana_official_mainnet')
  return [publicNode, official]
}

function rawExchanges(captures: readonly SolanaV3ProgramDeploymentRawCapture[]) {
  return captures.flatMap((capture) => [
    ...capture.anchor.rawExchanges,
    capture.programAccountsExchange,
  ])
}

function rawByteReferences(captures: readonly SolanaV3ProgramDeploymentRawCapture[]) {
  return rawExchanges(captures).flatMap((exchange) => [
    exchange.request.bytes,
    exchange.response.bytes,
  ])
}

function expectZeroed(bytes: readonly Uint8Array[]): void {
  expect(bytes).toHaveLength(20)
  expect(bytes.every((body) => body.every((byte) => byte === 0))).toBe(true)
}

function replaceRawBody(
  exchange: SolanaRawRpcEvidenceExchange,
  kind: 'request' | 'response',
  document: unknown
): void {
  exchange[kind].bytes.fill(0)
  const bytes = new TextEncoder().encode(JSON.stringify(document))
  const metadata = {
    bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }
  if (kind === 'request') {
    exchange.request = { ...metadata, hashBasis: RAW_RPC_REQUEST_HASH_BASIS }
  } else {
    exchange.response = { ...metadata, hashBasis: RAW_RPC_RESPONSE_HASH_BASIS }
  }
}

function mutateRawJsonBody(
  exchange: SolanaRawRpcEvidenceExchange,
  kind: 'request' | 'response',
  mutate: (document: any) => void
): void {
  const document = JSON.parse(new TextDecoder().decode(exchange[kind].bytes))
  mutate(document)
  replaceRawBody(exchange, kind, document)
}

function mutateProgramCode(capture: SolanaV3ProgramDeploymentRawCapture): void {
  mutateRawJsonBody(capture.programAccountsExchange, 'response', (document) => {
    const encoded = document.result.value[1].data[0] as string
    const bytes = Buffer.from(encoded, 'base64')
    bytes[SOLANA_V3_PROGRAMDATA_HEADER_BYTES] ^= 0x01
    document.result.value[1].data[0] = bytes.toString('base64')
  })
}

function compile(captures: CapturePair, generatedAt = GENERATED_AT) {
  return compileDexSolanaV3CurrentProgramStateEvidence({
    generated_at: generatedAt,
    captures,
  })
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

describe('Solana dual-source current program-state compiler', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(CAPTURE_NOW))
    installRpcFetchMock()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('replays both five-lane captures, accepts different contexts, and zeroes all raw bytes', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    const expectedCodeSha256 = captures[0].observation.programdata_account.code_sha256
    captures[0].anchor.verified.finalizedRootSlot = 1
    captures[1].observation.programdata_account.code_sha256 = '0'.repeat(64)
    expect(global.fetch).toHaveBeenCalledTimes(10)

    const evidence = compile(captures)

    expect(global.fetch).toHaveBeenCalledTimes(10)
    expect(evidence.captures.map((source) => source.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    expect(evidence.captures.map((source) => source.accounts_context_slot_decimal)).toEqual([
      String(PUBLICNODE_ROOT_SLOT),
      String(OFFICIAL_ROOT_SLOT),
    ])
    expect(evidence.current_state.programdata_account.code_sha256).toBe(expectedCodeSha256)
    expect(evidence.evidence_closure_sha256).toBe(
      '7708e4494d74f8f68513a96d5cbf294fcb781ae58d609cd18650e9d5c8e2bef0'
    )
    expect(evidence.claims).toMatchObject({
      raw_rpc_semantics_replayed_in_memory: true,
      required_fixed_endpoint_set_matched: true,
      current_state_projection_agreed: true,
      provider_independence_verified: false,
      original_deployment_slot_verified: false,
      historical_code_epochs_verified: false,
    })
    expect(evidence.authorization).toEqual({
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    })
    const keys = collectKeys(evidence)
    for (const forbidden of ['bytes', 'base64', 'url', 'origin', 'deployed_slot']) {
      expect(keys).not.toContain(forbidden)
    }
    expectZeroed(bytes)
  })

  it('normalizes provider input order to byte-identical evidence', async () => {
    const firstCaptures = await capturePair()
    const secondCaptures = await capturePair()

    const first = compile(firstCaptures)
    const second = compile([secondCaptures[1], secondCaptures[0]])

    expect(second).toEqual(first)
  })

  it('rejects duplicate endpoint captures and zeroes both sources', async () => {
    const first = await captureEndpoint('publicnode_solana_mainnet')
    const second = await captureEndpoint('publicnode_solana_mainnet')
    const captures: CapturePair = [first, second]
    const bytes = rawByteReferences(captures)

    expect(() => compile(captures)).toThrow('both fixed PublicNode and Solana official')
    expectZeroed(bytes)
  })

  it('rejects two individually valid but disagreeing code states and zeroes all bytes', async () => {
    const captures = await capturePair()
    mutateProgramCode(captures[1])
    const bytes = rawByteReferences(captures)

    expect(() => compile(captures)).toThrow('disagree on the complete stable program state')
    expectZeroed(bytes)
  })

  it('zeroes both sources when the first anchor or second program lane fails replay', async () => {
    const firstFailure = await capturePair()
    mutateRawJsonBody(firstFailure[0].anchor.rawExchanges[1], 'request', (document) => {
      document.params[0].commitment = 'confirmed'
    })
    const firstBytes = rawByteReferences(firstFailure)
    expect(() => compile(firstFailure)).toThrow('does not match the normalized anchor')
    expectZeroed(firstBytes)

    const secondFailure = await capturePair()
    mutateRawJsonBody(secondFailure[1].programAccountsExchange, 'response', (document) => {
      document.result.context.slot = OFFICIAL_ROOT_SLOT - 1
    })
    const secondBytes = rawByteReferences(secondFailure)
    expect(() => compile(secondFailure)).toThrow()
    expectZeroed(secondBytes)
  })

  it('zeroes raw bytes when final envelope validation rejects stale generated_at', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)

    expect(() => compile(captures, '2026-07-17T23:59:59.000Z')).toThrow('predates a source capture')
    expectZeroed(bytes)
  })

  it('leaves outer foreign bytes untouched when the exact compiler input shape rejects', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    const foreign = Uint8Array.of(9, 8, 7)
    const input = {
      generated_at: GENERATED_AT,
      captures,
      foreign,
    }

    expect(() => compileDexSolanaV3CurrentProgramStateEvidence(input)).toThrow()
    expectZeroed(bytes)
    expect([...foreign]).toEqual([9, 8, 7])
  })

  it('does not invoke a hostile capture getter and still clears all discovered raw bytes', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    let getterCalls = 0
    Object.defineProperty(captures[0], 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'private-api-key'
      },
    })

    expect(() => compile(captures)).toThrow('ownership tree is not descriptor-safe')
    expect(getterCalls).toBe(0)
    expectZeroed(bytes)
  })

  it('supports aliased raw arrays without depending on instance fill or iteration methods', async () => {
    const captures = await capturePair()
    const displaced = captures[1].anchor.rawExchanges[0].request.bytes
    displaced.fill(0)
    captures[1].anchor.rawExchanges[0].request.bytes =
      captures[0].anchor.rawExchanges[0].request.bytes
    const bytes = rawByteReferences(captures)
    expect(new Set(bytes).size).toBe(19)

    const hostileBytes = captures[0].anchor.rawExchanges[0].response.bytes
    const instanceFill = jest.fn(() => {
      throw new Error('instance fill must not run')
    })
    const instanceIterator = jest.fn(() => {
      throw new Error('instance iterator must not run')
    })
    Object.defineProperty(hostileBytes, 'fill', {
      configurable: true,
      value: instanceFill,
    })
    Object.defineProperty(hostileBytes, Symbol.iterator, {
      configurable: true,
      value: instanceIterator,
    })

    expect(() => compile(captures)).not.toThrow()
    expect(instanceFill).not.toHaveBeenCalled()
    expect(instanceIterator).not.toHaveBeenCalled()
    expectZeroed(bytes)
  })

  it('iteratively scans an arbitrarily deep ignored sidecar before clearing all raw bytes', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    let deepSidecar: Record<string, unknown> = {}
    for (let depth = 0; depth < 30_000; depth += 1) {
      deepSidecar = { next: deepSidecar }
    }
    expect(Reflect.set(captures[0], 'observation', deepSidecar)).toBe(true)

    expect(() => compile(captures)).not.toThrow()
    expectZeroed(bytes)
  })

  it('treats reached byte arrays as terminal leaves and preserves caller-owned attachments', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    const rawBytes = captures[0].anchor.rawExchanges[0].response.bytes
    const callerOwnedChild = Uint8Array.of(9, 8, 7)
    Object.defineProperty(rawBytes, 'callerOwnedChild', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: callerOwnedChild,
    })

    expect(() => compile(captures)).not.toThrow()
    expectZeroed(bytes)
    expect([...callerOwnedChild]).toEqual([9, 8, 7])
  })

  it('exposes an idempotent descriptor-safe disposer for abandoned compiler inputs', async () => {
    const captures = await capturePair()
    const bytes = rawByteReferences(captures)
    const input = { generated_at: GENERATED_AT, captures }

    disposeDexSolanaV3ProgramStateCompilerInputBytes(input)
    expect(() => disposeDexSolanaV3ProgramStateCompilerInputBytes(input)).not.toThrow()
    expectZeroed(bytes)
  })
})
