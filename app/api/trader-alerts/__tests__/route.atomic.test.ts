/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const ALERT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ALERT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TRADER_ID = 'leader-1'
const SOURCE = 'bybit'

const mockAdminFrom = jest.fn()
const mockUserRpc = jest.fn()
const mockCreateUserScopedServerClient = jest.fn()
const mockHasCurrentGlobalProEntitlement = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [key, value] of Object.entries(init.headers ?? {})) this.headers.set(key, value)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: USER_ID },
        supabase: { from: mockAdminFrom, rpc: jest.fn() },
        request,
      }),
}))

jest.mock('@/lib/supabase/user-scoped-server', () => ({
  createUserScopedServerClient: (...args: unknown[]) => mockCreateUserScopedServerClient(...args),
}))

jest.mock('@/lib/premium/server-entitlement', () => ({
  hasCurrentGlobalProEntitlement: (...args: unknown[]) =>
    mockHasCurrentGlobalProEntitlement(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { DELETE, GET, POST } from '../route'

function request(url: string, body?: unknown) {
  return {
    url,
    headers: new Headers({ Authorization: 'Bearer test-token' }),
    json: jest.fn().mockResolvedValue(body),
  } as never
}

function storedAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: ALERT_ID,
    trader_id: TRADER_ID,
    source: SOURCE,
    alert_roi_change: true,
    roi_change_threshold: 10,
    alert_drawdown: true,
    drawdown_threshold: 20,
    alert_pnl_change: false,
    pnl_change_threshold: 5000,
    alert_score_change: true,
    score_change_threshold: 5,
    alert_rank_change: false,
    rank_change_threshold: 5,
    one_time: false,
    enabled: true,
    created_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  }
}

function rpcAlert(overrides: Record<string, unknown> = {}) {
  return {
    ...storedAlert(),
    user_id: USER_ID,
    updated_at: '2026-07-29T00:01:00.000Z',
    ...overrides,
  }
}

function upsertAck(
  status: 'created' | 'updated' = 'created',
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    current_count: 1,
    limit: 50,
    alert: rpcAlert(),
    ...overrides,
  }
}

function deleteAck(
  status: 'deleted' | 'not_found' = 'deleted',
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    alert_id: ALERT_ID,
    trader_id: TRADER_ID,
    source: SOURCE,
    deleted_count: status === 'deleted' ? 1 : 0,
    current_count: 0,
    limit: 50,
    ...overrides,
  }
}

function alertQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock | ((resolve: (value: unknown) => unknown) => unknown)> =
    {}
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.is = jest.fn(() => builder)
  builder.order = jest.fn(() => builder)
  builder.limit = jest.fn(() => builder)
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return builder
}

function validPost(overrides: Record<string, unknown> = {}) {
  return {
    trader_id: TRADER_ID,
    source: SOURCE,
    alert_roi_change: true,
    roi_change_threshold: 10,
    alert_drawdown: true,
    drawdown_threshold: 20,
    alert_pnl_change: false,
    pnl_change_threshold: 5000,
    alert_score_change: true,
    score_change_threshold: 5,
    alert_rank_change: false,
    rank_change_threshold: 5,
    one_time: false,
    enabled: true,
    ...overrides,
  }
}

describe('GET /api/trader-alerts exact private reads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasCurrentGlobalProEntitlement.mockResolvedValue(true)
  })

  it('reads one exact source identity and normalizes historical nullable defaults', async () => {
    const query = alertQuery({
      data: [storedAlert({ alert_score_change: null, score_change_threshold: null })],
      error: null,
    })
    mockAdminFrom.mockReturnValue(query)

    const response = await GET(
      request(`https://arena.test/api/trader-alerts?trader_id=${TRADER_ID}&source=${SOURCE}`)
    )

    expect(response).toEqual({
      alerts: [expect.objectContaining({ alert_score_change: true, score_change_threshold: 5 })],
    })
    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(query.eq).toHaveBeenCalledWith('trader_id', TRADER_ID)
    expect(query.eq).toHaveBeenCalledWith('source', SOURCE)
    expect(query.is).not.toHaveBeenCalled()
  })

  it('treats an omitted source as the exact legacy NULL identity, not every exchange', async () => {
    const query = alertQuery({ data: [], error: null })
    mockAdminFrom.mockReturnValue(query)

    await GET(request(`https://arena.test/api/trader-alerts?trader_id=${TRADER_ID}`))

    expect(query.eq).toHaveBeenCalledWith('trader_id', TRADER_ID)
    expect(query.is).toHaveBeenCalledWith('source', null)
  })

  it.each([
    ['query error', { data: null, error: { code: 'XX000', message: 'offline' } }],
    ['null list', { data: null, error: null }],
    ['malformed row', { data: [storedAlert({ trader_id: '' })], error: null }],
  ])('returns 503 instead of a false empty list for a %s', async (_label, result) => {
    mockAdminFrom.mockReturnValue(alertQuery(result))

    const response = await GET(request('https://arena.test/api/trader-alerts'))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ success: false })
  })

  it('distinguishes a confirmed non-Pro viewer from entitlement authority failure', async () => {
    mockHasCurrentGlobalProEntitlement.mockResolvedValueOnce(false)
    const forbidden = await GET(request('https://arena.test/api/trader-alerts'))
    expect(forbidden.status).toBe(403)

    mockHasCurrentGlobalProEntitlement.mockRejectedValueOnce(new Error('offline'))
    const unavailable = await GET(request('https://arena.test/api/trader-alerts'))
    expect(unavailable.status).toBe(503)
    expect(mockAdminFrom).not.toHaveBeenCalled()
  })

  it('rejects source without a trader identity before querying private state', async () => {
    const response = await GET(request(`https://arena.test/api/trader-alerts?source=${SOURCE}`))

    expect(response.status).toBe(400)
    expect(mockAdminFrom).not.toHaveBeenCalled()
  })
})

describe('POST /api/trader-alerts atomic upsert', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateUserScopedServerClient.mockReturnValue({ rpc: mockUserRpc })
    mockUserRpc.mockResolvedValue({ data: upsertAck(), error: null })
  })

  it('creates only through the atomic RPC and consumes its exact acknowledgement', async () => {
    const postRequest = request('https://arena.test/api/trader-alerts', validPost())
    const response = await POST(postRequest)

    expect(mockCreateUserScopedServerClient).toHaveBeenCalledWith(postRequest)
    expect(mockUserRpc).toHaveBeenCalledWith('upsert_trader_alert_atomic', {
      p_trader_id: TRADER_ID,
      p_source: SOURCE,
      p_expected_alert_id: null,
      p_alert_roi_change: true,
      p_roi_change_threshold: 10,
      p_alert_drawdown: true,
      p_drawdown_threshold: 20,
      p_alert_pnl_change: false,
      p_pnl_change_threshold: 5000,
      p_alert_score_change: true,
      p_score_change_threshold: 5,
      p_alert_rank_change: false,
      p_rank_change_threshold: 5,
      p_one_time: false,
      p_enabled: true,
    })
    expect(response).toEqual({ alert: rpcAlert(), created: true })
    expect(mockAdminFrom).not.toHaveBeenCalled()
  })

  it('binds an update to the alert id loaded by the client', async () => {
    mockUserRpc.mockResolvedValue({
      data: upsertAck('updated', { alert: rpcAlert({ enabled: false }) }),
      error: null,
    })

    const response = await POST(
      request('https://arena.test/api/trader-alerts', validPost({ id: ALERT_ID, enabled: false }))
    )

    expect(mockUserRpc).toHaveBeenCalledWith(
      'upsert_trader_alert_atomic',
      expect.objectContaining({ p_expected_alert_id: ALERT_ID, p_enabled: false })
    )
    expect(response).toEqual({ alert: rpcAlert({ enabled: false }), created: false })
  })

  it.each([
    [
      'limit',
      { data: { status: 'limit_reached', current_count: 50, limit: 50 }, error: null },
      400,
    ],
    ['conflict', { data: { status: 'conflict' }, error: null }, 409],
    ['not Pro', { data: { status: 'forbidden' }, error: null }, 403],
    [
      'missing RPC',
      { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      503,
    ],
  ])(
    'returns the authoritative %s response without a fallback write',
    async (_label, result, status) => {
      mockUserRpc.mockResolvedValue(result)

      const response = await POST(request('https://arena.test/api/trader-alerts', validPost()))

      expect(response.status).toBe(status)
      expect(mockAdminFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'failed' } }],
    ['null ACK', { data: null, error: null }],
    ['wrong owner', { data: upsertAck('created', { user_id: OTHER_USER_ID }), error: null }],
    [
      'wrong alert owner',
      { data: upsertAck('created', { alert: rpcAlert({ user_id: OTHER_USER_ID }) }), error: null },
    ],
    [
      'wrong source',
      { data: upsertAck('created', { alert: rpcAlert({ source: 'binance' }) }), error: null },
    ],
    [
      'wrong expected id',
      { data: upsertAck('updated', { alert: rpcAlert({ id: OTHER_ALERT_ID }) }), error: null },
    ],
    [
      'nullable numeric ACK',
      {
        data: upsertAck('created', { alert: rpcAlert({ roi_change_threshold: null }) }),
        error: null,
      },
    ],
    ['unexpected ACK field', { data: upsertAck('created', { stale: true }), error: null }],
  ])('fails closed on a %s', async (_label, result) => {
    mockUserRpc.mockResolvedValue(result)
    const body = _label === 'wrong expected id' ? validPost({ id: ALERT_ID }) : validPost()

    const response = await POST(request('https://arena.test/api/trader-alerts', body))

    expect(response.status).toBe(500)
    expect(mockAdminFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and unexpected input before invoking the RPC', async () => {
    const malformedJson = jest.fn().mockRejectedValueOnce(new SyntaxError('bad JSON'))
    const malformed = {
      url: 'https://arena.test/api/trader-alerts',
      headers: new Headers({ Authorization: 'Bearer test-token' }),
      json: malformedJson,
    } as never
    const malformedResponse = await POST(malformed)
    expect(malformedResponse.status).toBe(400)

    const extraFieldResponse = await POST(
      request('https://arena.test/api/trader-alerts', validPost({ unexpected: true }))
    )
    expect(extraFieldResponse.status).toBe(400)
    expect(mockUserRpc).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/trader-alerts atomic exact delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateUserScopedServerClient.mockReturnValue({ rpc: mockUserRpc })
    mockUserRpc.mockResolvedValue({ data: deleteAck(), error: null })
  })

  it('deletes an exact owned alert id and consumes the deleted identity', async () => {
    const response = await DELETE(request(`https://arena.test/api/trader-alerts?id=${ALERT_ID}`))

    expect(mockUserRpc).toHaveBeenCalledWith('delete_trader_alert_atomic', {
      p_alert_id: ALERT_ID,
      p_trader_id: null,
      p_source: null,
    })
    expect(response).toEqual({
      deleted: true,
      id: ALERT_ID,
      trader_id: TRADER_ID,
      source: SOURCE,
    })
  })

  it('maps an omitted source to only the exact legacy NULL identity', async () => {
    mockUserRpc.mockResolvedValue({
      data: deleteAck('deleted', { alert_id: OTHER_ALERT_ID, source: null }),
      error: null,
    })

    await DELETE(request(`https://arena.test/api/trader-alerts?trader_id=${TRADER_ID}`))

    expect(mockUserRpc).toHaveBeenCalledWith('delete_trader_alert_atomic', {
      p_alert_id: null,
      p_trader_id: TRADER_ID,
      p_source: null,
    })
  })

  it('returns 404 for zero rows instead of falsely acknowledging deletion', async () => {
    mockUserRpc.mockResolvedValue({
      data: deleteAck('not_found', {
        alert_id: ALERT_ID,
        trader_id: null,
        source: null,
      }),
      error: null,
    })

    const response = await DELETE(request(`https://arena.test/api/trader-alerts?id=${ALERT_ID}`))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Alert not found',
    })
  })

  it.each([
    ['wrong owner', deleteAck('deleted', { user_id: OTHER_USER_ID })],
    ['wrong id', deleteAck('deleted', { alert_id: OTHER_ALERT_ID })],
    ['contradictory count', deleteAck('deleted', { deleted_count: 0 })],
    ['unexpected field', deleteAck('deleted', { stale: true })],
  ])('fails closed on a %s acknowledgement', async (_label, data) => {
    mockUserRpc.mockResolvedValue({ data, error: null })

    const response = await DELETE(request(`https://arena.test/api/trader-alerts?id=${ALERT_ID}`))

    expect(response.status).toBe(500)
  })

  it.each([
    `https://arena.test/api/trader-alerts`,
    `https://arena.test/api/trader-alerts?id=${ALERT_ID}&trader_id=${TRADER_ID}`,
    `https://arena.test/api/trader-alerts?id=not-a-uuid`,
    `https://arena.test/api/trader-alerts?id=${ALERT_ID}&source=${SOURCE}`,
  ])('rejects the ambiguous or malformed identity %s', async (url) => {
    const response = await DELETE(request(url))
    expect(response.status).toBe(400)
    expect(mockUserRpc).not.toHaveBeenCalled()
  })
})

describe('trader-alert route source contract', () => {
  it('contains no direct mutation/count fallback and routes source-less identity to NULL', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/trader-alerts/route.ts'), 'utf8')
    const post = source.slice(
      source.indexOf('export const POST'),
      source.indexOf('export const DELETE')
    )
    const deletion = source.slice(source.indexOf('export const DELETE'))

    expect(post).toContain("rpc('upsert_trader_alert_atomic'")
    expect(post).not.toContain(".from('trader_alerts')")
    expect(post).not.toContain("count: 'exact'")
    expect(deletion).toContain("rpc('delete_trader_alert_atomic'")
    expect(deletion).not.toContain(".from('trader_alerts')")
  })
})
