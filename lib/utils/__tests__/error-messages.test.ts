import { parseError, getErrorMessage, isRetryableError, isAuthError } from '../error-messages'

describe('parseError', () => {
  it('parses network error', () => {
    const err = new TypeError('Failed to fetch')
    const parsed = parseError(err)
    expect(parsed.type).toBe('network')
    expect(parsed.retryable).toBe(true)
  })

  it('parses timeout error', () => {
    const err = new DOMException('The operation was aborted', 'AbortError')
    const parsed = parseError(err)
    expect(parsed.type).toBe('timeout')
    expect(parsed.retryable).toBe(true)
  })

  it('parses HTTP status errors', () => {
    const err = Object.assign(new Error('Not found'), { status: 404 })
    const parsed = parseError(err)
    expect(parsed.type).toBe('not_found')
    expect(parsed.retryable).toBe(false)
  })

  it('parses 401 as unauthorized', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    const parsed = parseError(err)
    expect(parsed.type).toBe('unauthorized')
  })

  it('parses 429 as rate_limit', () => {
    const err = Object.assign(new Error('Too many'), { status: 429 })
    const parsed = parseError(err)
    expect(parsed.type).toBe('rate_limit')
    expect(parsed.retryable).toBe(true)
  })

  it('handles unknown errors', () => {
    const parsed = parseError('something weird')
    expect(parsed.type).toBe('unknown')
  })
})

describe('getErrorMessage', () => {
  it('returns string message', () => {
    const msg = getErrorMessage(new Error('test'))
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})

describe('isRetryableError', () => {
  it('network errors are retryable', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('404 is not retryable', () => {
    expect(isRetryableError(Object.assign(new Error(''), { status: 404 }))).toBe(false)
  })
})

describe('isAuthError', () => {
  it('401 is auth error', () => {
    expect(isAuthError(Object.assign(new Error(''), { status: 401 }))).toBe(true)
  })

  it('403 is auth error', () => {
    expect(isAuthError(Object.assign(new Error(''), { status: 403 }))).toBe(true)
  })

  it('500 is not auth error', () => {
    expect(isAuthError(Object.assign(new Error(''), { status: 500 }))).toBe(false)
  })
})
