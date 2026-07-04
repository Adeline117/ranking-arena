/**
 * withAdminAuth 管理员门 — 403 非管理员 / 限流 failClose / 异常不泄漏。
 * 这是所有 /api/admin/* 的唯一闸门，门错一步=管理面暴露。
 */

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: class {},
}))

const mockVerifyAdmin = jest.fn()
jest.mock('@/lib/admin/auth', () => ({
  getSupabaseAdmin: jest.fn(() => ({ __client: true })),
  verifyAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))

const mockCheckRateLimit = jest.fn()
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

const mockErrorResponse = jest.fn((msg: string, status: number, code: string) => ({
  kind: 'error',
  msg,
  status,
  code,
}))
const mockHandleError = jest.fn((err: unknown, name: string) => ({ kind: 'handled', name }))
jest.mock('../response', () => ({
  error: (...a: unknown[]) => mockErrorResponse(...(a as [string, number, string])),
  handleError: (...a: unknown[]) => mockHandleError(...(a as [unknown, string])),
}))

import { withAdminAuth } from '../with-admin-auth'

function req(headers: Record<string, string> = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    method: 'GET',
    url: 'https://x.test/api/admin/thing',
    headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null },
  } as never
}

function okResponse() {
  const headers = new Map<string, string>()
  return {
    kind: 'ok',
    headers: { set: (k: string, v: string) => headers.set(k, v), _map: headers },
  }
}

beforeEach(() => {
  mockVerifyAdmin.mockReset()
  mockCheckRateLimit.mockReset().mockResolvedValue(null) // 默认不限流
  mockErrorResponse.mockClear()
  mockHandleError.mockClear()
})

describe('withAdminAuth', () => {
  it('非管理员 → 403 FORBIDDEN，handler 不执行', async () => {
    mockVerifyAdmin.mockResolvedValue(null)
    const handler = jest.fn()
    const wrapped = withAdminAuth(handler as never)
    const res = (await wrapped(req({ authorization: 'Bearer bad' }))) as never as {
      status: number
      code: string
    }
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('管理员 → handler 收到 admin/supabase/request 上下文', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'a1', email: 'admin@x.co' })
    const handler = jest.fn().mockResolvedValue(okResponse())
    const wrapped = withAdminAuth(handler as never)
    await wrapped(req({ authorization: 'Bearer good' }))
    expect(handler).toHaveBeenCalledTimes(1)
    const ctx = handler.mock.calls[0][0]
    expect(ctx.admin).toEqual({ id: 'a1', email: 'admin@x.co' })
    expect(ctx.supabase).toEqual({ __client: true })
  })

  it('响应带 X-Response-Time 头', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'a1', email: 'a@x.co' })
    const resp = okResponse()
    const wrapped = withAdminAuth(jest.fn().mockResolvedValue(resp) as never)
    await wrapped(req())
    expect(resp.headers._map.get('X-Response-Time')).toMatch(/^\d+ms$/)
  })

  it('限流触发 → 返回限流响应，handler 不执行（failClose）', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'a1', email: 'a@x.co' })
    const rateLimited = { kind: 'rate-limited', status: 429 }
    mockCheckRateLimit.mockResolvedValue(rateLimited)
    const handler = jest.fn()
    const wrapped = withAdminAuth(handler as never)
    const res = await wrapped(req())
    expect(res).toBe(rateLimited)
    expect(handler).not.toHaveBeenCalled()
  })

  it('限流带 failClose:true 参数（Redis 挂了拒绝而非放行）', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'a1', email: 'a@x.co' })
    const wrapped = withAdminAuth(jest.fn().mockResolvedValue(okResponse()) as never)
    await wrapped(req())
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ failClose: true, prefix: 'admin' })
    )
  })

  it('handler 抛异常 → handleError 捕获（不裸奔 500 泄栈）', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'a1', email: 'a@x.co' })
    const wrapped = withAdminAuth(jest.fn().mockRejectedValue(new Error('db exploded')) as never, {
      name: 'test-route',
    })
    const res = (await wrapped(req())) as never as { kind: string; name: string }
    expect(res.kind).toBe('handled')
    expect(mockHandleError).toHaveBeenCalledWith(expect.any(Error), 'test-route')
  })

  it('verifyAdmin 自身抛异常 → 也走 handleError（auth 失败不放行）', async () => {
    mockVerifyAdmin.mockRejectedValue(new Error('jwt malformed'))
    const handler = jest.fn()
    const wrapped = withAdminAuth(handler as never)
    const res = (await wrapped(req())) as never as { kind: string }
    expect(res.kind).toBe('handled')
    expect(handler).not.toHaveBeenCalled()
  })
})
