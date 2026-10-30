/** @jest-environment node */

const mockRequireAuth = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/api', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
  handleError: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function inventoryQuery(result: { count: number; data: unknown[]; error: unknown }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.order.mockReturnValue(query)
  query.range.mockResolvedValue(result)
  return query
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('legacy trader-alert history inventory', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
  })

  it('returns owner-scoped legacy history as unavailable with no-store headers', async () => {
    const row = { id: 'history-1', user_id: USER_ID, alert_id: 'alert-1' }
    const query = inventoryQuery({ count: 1, data: [row], error: null })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(query)

    const request = new NextRequest('https://example.test/api/alerts?alert_id=alert-1&limit=20')
    const response = await GET(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        available: false,
        code: 'TRADER_ALERTS_NOT_PUBLISHED',
        history: [row],
        total: 1,
      },
    })
    expect(mockRequireAuth).toHaveBeenCalledWith(request)
    expect(mockFrom).toHaveBeenCalledWith('alert_history')
    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(query.eq).toHaveBeenCalledWith('alert_id', 'alert-1')
    expectNoStore(response)
  })
})
