// t() mock：返回 key 本身，便于断言选了哪条消息
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k }))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import { parseError, getErrorMessage, isRetryableError } from '../error-handling'

describe('parseError — 分类', () => {
  it('null/undefined → unknown', () => {
    expect(parseError(null).type).toBe('unknown')
    expect(parseError(undefined).type).toBe('unknown')
  })

  it('网络错误（消息含 network/fetch/connection/abort/cors）', () => {
    expect(parseError(new Error('Network request failed')).type).toBe('network')
    expect(parseError(new Error('Failed to fetch')).type).toBe('network')
    expect(parseError(new Error('connection refused')).type).toBe('network')
    expect(parseError(new Error('The operation was aborted')).type).toBe('network')
  })

  it('超时错误（消息含 timeout/timed out/deadline）', () => {
    expect(parseError(new Error('Request timeout')).type).toBe('timeout')
    expect(parseError(new Error('deadline exceeded')).type).toBe('timeout')
  })

  it('服务器错误（status≥500 或消息含 502/503）', () => {
    expect(parseError({ status: 500, message: 'x' }).type).toBe('server')
    expect(parseError({ status: 503 }).type).toBe('server')
    expect(parseError(new Error('502 Bad Gateway')).type).toBe('server')
  })

  it('认证错误（401/403 或消息含 unauthorized/forbidden）', () => {
    expect(parseError({ status: 401 }).type).toBe('auth')
    expect(parseError({ status: 403 }).type).toBe('auth')
    expect(parseError(new Error('Unauthorized')).type).toBe('auth')
  })

  it('验证错误（400/422 或消息含 invalid/required）', () => {
    expect(parseError({ status: 400, message: 'x' }).type).toBe('validation')
    expect(parseError({ status: 422 }).type).toBe('validation')
    expect(parseError(new Error('invalid input')).type).toBe('validation')
  })

  it('无从分类 → unknown', () => {
    expect(parseError(new Error('something weird happened')).type).toBe('unknown')
  })

  it('优先级：网络 > 服务器（消息同时含 network 和 500）', () => {
    // isNetworkError 先检查 → network 胜出
    expect(parseError(new Error('network 500 error')).type).toBe('network')
  })

  it('携带 code（服务器错误带 status）', () => {
    expect(parseError({ status: 503 }).code).toBe(503)
  })

  it('response.status 嵌套也能识别', () => {
    expect(parseError({ response: { status: 500 } }).type).toBe('server')
  })
})

describe('getErrorMessage', () => {
  it('返回分类对应的消息 key', () => {
    expect(getErrorMessage(new Error('Network failed'))).toBe('networkErrorFriendly')
    expect(getErrorMessage(null)).toBe('unknownErrorFriendly')
  })

  it('验证错误保留原始 message（非通用文案）', () => {
    expect(getErrorMessage({ status: 400, message: '邮箱格式错误' })).toBe('邮箱格式错误')
  })
})

describe('isRetryableError', () => {
  it('网络/超时/服务器 → 可重试', () => {
    expect(isRetryableError(new Error('network error'))).toBe(true)
    expect(isRetryableError(new Error('timeout'))).toBe(true)
    expect(isRetryableError({ status: 500 })).toBe(true)
  })

  it('认证/验证/未知 → 不可重试', () => {
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 400, message: 'x' })).toBe(false)
    expect(isRetryableError(new Error('weird'))).toBe(false)
  })
})
