/**
 * ETag 条件请求 — 304 判定错了要么白耗带宽要么客户端拿到过期数据。
 */

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: class MockNextResponse {
    body: unknown
    status: number
    headers: Map<string, string> & {
      set: (k: string, v: string) => void
      get: (k: string) => string | null
    }
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body
      this.status = init?.status ?? 200
      const m = new Map(Object.entries(init?.headers ?? {}))
      this.headers = m as never
    }
  },
}))

import { generateETag, isETagMatch, withETag } from '../etag'
import { NextResponse } from 'next/server'

function req(headers: Record<string, string> = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null } } as never
}

describe('generateETag', () => {
  it('相同数据 → 相同 ETag（确定性）', () => {
    expect(generateETag({ a: 1, b: [2, 3] })).toBe(generateETag({ a: 1, b: [2, 3] }))
  })

  it('不同数据 → 不同 ETag', () => {
    expect(generateETag({ a: 1 })).not.toBe(generateETag({ a: 2 }))
  })

  it('格式为带引号的 hex（HTTP ETag 规范形态）', () => {
    expect(generateETag('x')).toMatch(/^"[0-9a-f]+"$/)
  })
})

describe('isETagMatch', () => {
  const etag = generateETag({ v: 1 })

  it('无 If-None-Match → false', () => {
    expect(isETagMatch(req(), etag)).toBe(false)
  })

  it('精确匹配 → true', () => {
    expect(isETagMatch(req({ 'if-none-match': etag }), etag)).toBe(true)
  })

  it('多 ETag 逗号列表中含目标 → true', () => {
    expect(isETagMatch(req({ 'if-none-match': `"aaa", ${etag}, "bbb"` }), etag)).toBe(true)
  })

  it('通配 * → true', () => {
    expect(isETagMatch(req({ 'if-none-match': '*' }), etag)).toBe(true)
  })

  it('不匹配 → false', () => {
    expect(isETagMatch(req({ 'if-none-match': '"deadbeef"' }), etag)).toBe(false)
  })
})

describe('withETag', () => {
  it('客户端无缓存 → 原响应 + ETag 头', () => {
    const data = { rows: [1, 2] }
    const resp = new NextResponse('body') as never as {
      status: number
      headers: Map<string, string>
    }
    const out = withETag(req(), resp as never, data) as never as {
      status: number
      headers: Map<string, string>
    }
    expect(out.status).toBe(200)
    expect(out.headers.get('ETag')).toBe(generateETag(data))
  })

  it('If-None-Match 命中 → 304 空体 + 保留 Cache-Control', () => {
    const data = { rows: [1, 2] }
    const etag = generateETag(data)
    const resp = new NextResponse('body', {
      headers: { 'Cache-Control': 'max-age=60' },
    })
    const out = withETag(req({ 'if-none-match': etag }), resp as never, data) as never as {
      status: number
      body: unknown
      headers: Map<string, string>
    }
    expect(out.status).toBe(304)
    expect(out.body).toBeNull()
    expect(out.headers.get('ETag')).toBe(etag)
    expect(out.headers.get('Cache-Control')).toBe('max-age=60')
  })

  it('数据变化 → 不再 304（旧 ETag 失配）', () => {
    const oldTag = generateETag({ v: 1 })
    const resp = new NextResponse('body')
    const out = withETag(req({ 'if-none-match': oldTag }), resp as never, { v: 2 }) as never as {
      status: number
    }
    expect(out.status).toBe(200)
  })
})
