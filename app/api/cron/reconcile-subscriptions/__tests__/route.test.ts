/** @jest-environment node */

const mockRpc = jest.fn()

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    try {
      const result = await handler(request, { supabase: { rpc: mockRpc } })
      return Response.json({ ok: true, ...result })
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      )
    }
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/cron/reconcile-subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({
      data: {
        status: 'reconciled',
        processed_count: 3,
        authority_count: 2,
        next_cursor: '11111111-1111-4111-8111-111111111111',
        has_more: false,
      },
      error: null,
    })
  })

  it('uses the atomic entitlement projection and group authority', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      reconciled: 3,
      authorities: 2,
      pages: 1,
      errors: [],
    })
    expect(mockRpc).toHaveBeenCalledWith('reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 500,
      p_after_user_id: null,
    })
  })

  it('fails closed when atomic reconciliation is unavailable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'projection authority unavailable' },
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('projection authority unavailable'),
    })
  })
})
