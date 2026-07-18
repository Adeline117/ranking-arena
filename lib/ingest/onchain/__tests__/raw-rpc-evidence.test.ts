import { MessageChannel } from 'node:worker_threads'

import {
  disposeRawRpcBytes,
  encodeJsonRpcRequestBody,
  rawRpcBodyEvidence,
  readBoundedRpcResponse,
  takeRawRpcBodyEvidence,
} from '../raw-rpc-evidence'
import {
  disposeSolanaRawRpcEvidenceExchanges,
  type SolanaRawRpcEvidenceExchange,
} from '../solana-evidence-core'

function streamedResponse(chunks: Uint8Array[]): Response {
  let index = 0
  return {
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response
}

describe('raw RPC byte ownership', () => {
  it('clears every delivered stream chunk after assembling one owned response buffer', async () => {
    const first = new TextEncoder().encode('{"jsonrpc":"2.0",')
    const second = new TextEncoder().encode('"id":1,"result":true}')

    const result = await readBoundedRpcResponse(streamedResponse([first, second]), 1024, true)

    expect(result).toMatchObject({
      ok: true,
      text: '{"jsonrpc":"2.0","id":1,"result":true}',
    })
    expect(first.every((byte) => byte === 0)).toBe(true)
    expect(second.every((byte) => byte === 0)).toBe(true)
    if (!result.ok || result.bytes === null) throw new Error('expected exact response bytes')
    expect(new TextDecoder().decode(result.bytes)).toBe('{"jsonrpc":"2.0","id":1,"result":true}')
    disposeRawRpcBytes(result.bytes)
    expect(result.bytes.every((byte) => byte === 0)).toBe(true)
  })

  it('clears all accepted chunks when the bounded reader rejects an oversized response', async () => {
    const first = Uint8Array.of(1, 2)
    const second = Uint8Array.of(3, 4)

    await expect(
      readBoundedRpcResponse(streamedResponse([first, second]), 3, true)
    ).resolves.toEqual({ ok: false, reason: 'response_too_large' })
    expect(first.every((byte) => byte === 0)).toBe(true)
    expect(second.every((byte) => byte === 0)).toBe(true)
  })

  it('transfers an owned response without retaining a second byte copy', () => {
    const bytes = Uint8Array.of(5, 6, 7)
    const evidence = takeRawRpcBodyEvidence(bytes)

    expect(evidence.bytes).toBe(bytes)
    expect(evidence.byteLength).toBe(3)
    disposeRawRpcBytes(evidence.bytes)
    expect(bytes).toEqual(Uint8Array.of(0, 0, 0))
  })

  it('keeps the legacy copy helper isolated from caller mutation', () => {
    const source = Uint8Array.of(8, 9)
    const evidence = rawRpcBodyEvidence(source)

    expect(evidence.bytes).not.toBe(source)
    source.fill(0)
    expect(evidence.bytes).toEqual(Uint8Array.of(8, 9))
    disposeRawRpcBytes(evidence.bytes)
  })

  it('returns one directly owned request buffer that can be deterministically cleared', () => {
    const request = encodeJsonRpcRequestBody(1, 'getSlot', [{ commitment: 'finalized' }])

    expect(new TextDecoder().decode(request.evidence.bytes)).toBe(request.text)
    disposeRawRpcBytes(request.evidence.bytes)
    expect(request.evidence.bytes.every((byte) => byte === 0)).toBe(true)
  })

  it('clears every exchange buffer even if an earlier detached buffer cannot be filled', () => {
    const detached = Uint8Array.of(1)
    const channel = new MessageChannel()
    channel.port1.postMessage(detached.buffer, [detached.buffer])
    channel.port1.close()
    channel.port2.close()
    const reachable = [Uint8Array.of(2), Uint8Array.of(3), Uint8Array.of(4)]
    const exchanges = [
      {
        request: { bytes: detached },
        response: { bytes: reachable[0] },
      },
      {
        request: { bytes: reachable[1] },
        response: { bytes: reachable[2] },
      },
    ] as unknown as SolanaRawRpcEvidenceExchange[]

    expect(() => disposeSolanaRawRpcEvidenceExchanges(exchanges)).toThrow(
      'Solana raw RPC evidence bytes could not all be cleared'
    )
    expect(reachable.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })
})
