/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (request: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      const result = await handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { from: mockFrom },
        request,
      })
      return result instanceof NextResponse
        ? result
        : NextResponse.json({ success: true, data: result })
    },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import { DELETE, GET, POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const alertRow = {
  id: 'alert-1',
  trader_id: 'trader-1',
  source: 'binance',
  alert_roi_change: true,
  roi_change_threshold: 10,
  alert_drawdown: true,
  drawdown_threshold: 20,
  alert_pnl_change: false,
  pnl_change_threshold: 5000,
  alert_score_change: false,
  score_change_threshold: 5,
  alert_rank_change: false,
  rank_change_threshold: 5,
  one_time: false,
  enabled: true,
  created_at: '2026-08-16T00:00:00.000Z',
}

function getQuery(result: { data: unknown; error: unknown }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    order: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.is.mockReturnValue(query)
  query.order.mockResolvedValue(result)
  return query
}

function deleteQuery(result: { error: unknown }) {
  const query = {
    delete: jest.fn(),
    eq: jest.fn(),
    then: (
      resolve: (value: { error: unknown }) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  }
  query.delete.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('trader-alert V1 publication containment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('declares no-store headers for every deployed trader-alert API path', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
    ) as {
      headers?: Array<{
        source: string
        headers: Array<{ key: string; value: string }>
      }>
    }
    const traderAlertsRoute = config.headers?.find(
      (rule) => rule.source === '/api/trader-alerts/:path*'
    )

    expect(traderAlertsRoute?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
        { key: 'CDN-Cache-Control', value: 'no-store' },
        { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
      ])
    )
  })

  it('rejects a new or updated configuration before body parsing or table access', async () => {
    const json = jest.fn(() => {
      throw new Error('POST body must remain unread while publication is disabled')
    })
    const response = await POST({ json } as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      success: false,
      available: false,
      code: 'TRADER_ALERTS_NOT_PUBLISHED',
      error: 'Trader alerts are temporarily unavailable during V1 verification.',
    })
    expect(json).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it('lets any authenticated owner inventory legacy configuration without a Pro entitlement', async () => {
    const query = getQuery({ data: [alertRow], error: null })
    mockFrom.mockReturnValue(query)

    const response = await GET(new Request('https://example.test/api/trader-alerts') as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        available: false,
        code: 'TRADER_ALERTS_NOT_PUBLISHED',
        alerts: [alertRow],
      },
    })
    expect(mockFrom).toHaveBeenCalledWith('trader_alerts')
    expect(mockFrom).not.toHaveBeenCalledWith('subscriptions')
    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID)
    expectNoStore(response)
  })

  it('preserves an owner-scoped delete path for legacy cleanup without checking Pro', async () => {
    const query = deleteQuery({ error: null })
    mockFrom.mockReturnValue(query)

    const response = await DELETE(
      new Request('https://example.test/api/trader-alerts?id=alert-1', { method: 'DELETE' }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, data: { deleted: true } })
    expect(mockFrom).toHaveBeenCalledWith('trader_alerts')
    expect(mockFrom).not.toHaveBeenCalledWith('subscriptions')
    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(query.eq).toHaveBeenCalledWith('id', 'alert-1')
    expectNoStore(response)
  })
})
