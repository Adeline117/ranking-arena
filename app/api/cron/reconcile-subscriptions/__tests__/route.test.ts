/** @jest-environment node */

const mockRpc = jest.fn()

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const result = await handler(request, { supabase: { rpc: mockRpc } })
    return Response.json({ ok: true, ...result })
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const firstCursor = '11e34ce2-43c1-4bcc-8f19-79b36d56605d'

function reconciledPage(overrides: Record<string, unknown> = {}) {
  return {
    status: 'reconciled',
    processed_count: 0,
    authority_count: 0,
    next_cursor: null,
    has_more: false,
    ...overrides,
  }
}

describe('GET /api/cron/reconcile-subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: reconciledPage(), error: null })
  })

  it('reconciles due projections only through the atomic ledger writer', async () => {
    mockRpc.mockResolvedValueOnce({
      data: reconciledPage({ processed_count: 3, authority_count: 2 }),
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 3,
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

  it('walks every atomic reconciliation page with the sealed cursor', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: reconciledPage({
          processed_count: 500,
          authority_count: 420,
          next_cursor: firstCursor,
          has_more: true,
        }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: reconciledPage({ processed_count: 2, authority_count: 1 }),
        error: null,
      })

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(body).toMatchObject({ reconciled: 502, authorities: 421, pages: 2 })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 500,
      p_after_user_id: firstCursor,
    })
  })

  it('keeps a database failure retryable', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'projection ledger unavailable' },
    })

    await expect(
      GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    ).rejects.toThrow(
      'Failed to reconcile Pro entitlement projections: projection ledger unavailable'
    )
  })

  it('rejects a malformed reconciliation acknowledgement', async () => {
    mockRpc.mockResolvedValueOnce({
      data: reconciledPage({ authority_count: 1 }),
      error: null,
    })

    await expect(
      GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    ).rejects.toThrow('Pro projection reconciliation returned an invalid page')
  })
})
