/**
 * @jest-environment node
 */

const mockRpcAbort = jest.fn()
const mockRpc = jest.fn(() => ({ abortSignal: mockRpcAbort }))

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, {})
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/expire-mutes')
}

describe('GET /api/cron/expire-mutes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpcAbort.mockResolvedValue({
      data: {
        group_mutes_cleared: 2,
        temp_bans_cleared: 3,
        temp_bans_preserved: 1,
      },
      error: null,
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('bounds and acknowledges the atomic cleanup RPC', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 5,
      group_mutes_cleared: 2,
      temp_bans_cleared: 3,
      temp_bans_preserved: 1,
    })
    expect(mockRpc).toHaveBeenCalledWith('expire_mutes_and_temporary_bans_atomic', {
      p_limit: 500,
    })
    expect(timeoutSpy).toHaveBeenCalledWith(20_000)
    expect(mockRpcAbort).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('fails closed on a database error', async () => {
    mockRpcAbort.mockResolvedValue({ data: null, error: { message: 'lock timeout' } })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('lock timeout')
  })

  it.each([
    null,
    [],
    {},
    {
      group_mutes_cleared: -1,
      temp_bans_cleared: 0,
      temp_bans_preserved: 0,
    },
    {
      group_mutes_cleared: 501,
      temp_bans_cleared: 0,
      temp_bans_preserved: 0,
    },
    {
      group_mutes_cleared: 0,
      temp_bans_cleared: 0.5,
      temp_bans_preserved: 0,
    },
  ])('rejects a malformed cleanup acknowledgement: %p', async (data) => {
    mockRpcAbort.mockResolvedValue({ data, error: null })

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('does not acknowledge a cleanup completed after its work deadline', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cleanup deadline'))
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(request())

    expect(response.status).toBe(500)
  })
})
