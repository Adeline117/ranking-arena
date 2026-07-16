jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
const mockMemberDelete = jest.fn()
const mockAuditInsert = jest.fn()
const mockSendNotification = jest.fn()
const mockFireAndForget = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { from: typeof mockFrom }
        request: unknown
      }) => unknown
    ) =>
    async (request: unknown) => {
      try {
        return await handler({
          user: { id: 'group-admin' },
          supabase: { from: (...args: unknown[]) => mockFrom(...args) },
          request,
        })
      } catch {
        return {
          status: 500,
          _body: { error: 'Internal server error' },
          async json() {
            return this._body
          },
          headers: new Map(),
        }
      }
    },
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))

import { POST } from '../route'

type DbError = { code: string; message: string }
type DbResult = { data: unknown; error: DbError | null }

const DB_ERROR: DbError = { code: 'XX001', message: 'database failed' }
const GROUP_ID = 'group-1'
const TARGET_ID = 'target-1'

let tableQueues: Record<string, unknown[]>

function queueTable(table: string, ...queries: unknown[]) {
  tableQueues[table] = queries
}

function rowQuery(data: unknown, error: DbError | null = null) {
  const result = { data, error }
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

function mutationQuery(operationSpy: jest.Mock, result: DbResult) {
  const chain: Record<string, jest.Mock> & {
    then?: (
      onFulfilled?: (value: DbResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise<unknown>
  } = {
    eq: jest.fn(),
    select: jest.fn(),
  }
  chain.eq.mockReturnValue(chain)
  chain.select.mockReturnValue(chain)
  chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
  operationSpy.mockReturnValue(chain)
  return { delete: operationSpy }
}

function auditMutation() {
  const result: DbResult = { data: null, error: null }
  const chain: {
    then: (
      onFulfilled?: (value: DbResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise<unknown>
  } = {
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  mockAuditInsert.mockReturnValue(chain)
  return { insert: mockAuditInsert }
}

function request() {
  return {}
}

function context() {
  return { params: Promise.resolve({ id: GROUP_ID, userId: TARGET_ID }) }
}

describe('POST group member kick', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tableQueues = {}
    mockFrom.mockImplementation((table: string) => {
      const queue = tableQueues[table]
      if (!queue || queue.length === 0) throw new Error(`Unexpected table access: ${table}`)
      return queue.shift()
    })
  })

  it('returns 500 when the requester lookup fails and performs no side effects', async () => {
    queueTable('group_members', rowQuery(null, DB_ERROR))

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockMemberDelete).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockAuditInsert).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('returns 500 when the target lookup fails and performs no side effects', async () => {
    queueTable('group_members', rowQuery({ role: 'admin' }), rowQuery(null, DB_ERROR))

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockMemberDelete).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockAuditInsert).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('returns 500 on a delete error and does not notify or audit', async () => {
    queueTable(
      'group_members',
      rowQuery({ role: 'admin' }),
      rowQuery({ role: 'member' }),
      mutationQuery(mockMemberDelete, { data: null, error: DB_ERROR })
    )

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockMemberDelete).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockAuditInsert).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('does not notify or audit when the conditional delete returns zero rows', async () => {
    queueTable(
      'group_members',
      rowQuery({ role: 'admin' }),
      rowQuery({ role: 'member' }),
      mutationQuery(mockMemberDelete, { data: [], error: null })
    )

    const response = await POST(request() as never, context())

    expect(response.status).toBe(409)
    expect(mockMemberDelete).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockAuditInsert).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('kicks successfully without a manual member-count mutation', async () => {
    queueTable(
      'group_members',
      rowQuery({ role: 'admin' }),
      rowQuery({ role: 'member' }),
      mutationQuery(mockMemberDelete, {
        data: [{ user_id: TARGET_ID }],
        error: null,
      })
    )
    queueTable('group_audit_log', auditMutation())

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    expect(mockMemberDelete).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
    expect(mockAuditInsert).toHaveBeenCalledTimes(1)
    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
  })
})
