import {
  hasExactEmptyTwoFactorBody,
  readTwoFactorJson,
  TWO_FACTOR_MAX_REQUEST_BYTES,
} from '../two-factor-http-contract'

function streamedRequest(chunks: Uint8Array[], declaredLength?: string): Request {
  let index = 0
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? (declaredLength ?? null) : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false as const, value: chunks[index++] }
            : { done: true as const, value: undefined },
        cancel: async () => undefined,
      }),
    },
    json: async () => {
      throw new Error('stream path expected')
    },
  } as unknown as Request
}

describe('two-factor HTTP request contracts', () => {
  it('reads a bounded streamed JSON body without Content-Length', async () => {
    const request = streamedRequest([new TextEncoder().encode('{"code":"123456"}')])

    await expect(readTwoFactorJson(request)).resolves.toEqual({
      ok: true,
      value: { code: '123456' },
    })
  })

  it('rejects an oversized stream even when Content-Length is absent', async () => {
    const request = streamedRequest([new Uint8Array(TWO_FACTOR_MAX_REQUEST_BYTES + 1)])

    await expect(readTwoFactorJson(request)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it.each(['-1', 'NaN', String(TWO_FACTOR_MAX_REQUEST_BYTES + 1)])(
    'rejects invalid or oversized declared length %s',
    async (declaredLength) => {
      const request = streamedRequest([], declaredLength)
      const result = await readTwoFactorJson(request)

      expect(result.ok).toBe(false)
    }
  )

  it('accepts a truly empty mutation body and rejects a one-byte payload', async () => {
    await expect(hasExactEmptyTwoFactorBody(streamedRequest([]))).resolves.toBe(true)
    await expect(
      hasExactEmptyTwoFactorBody(streamedRequest([new TextEncoder().encode(' ')]))
    ).resolves.toBe(false)
  })
})
