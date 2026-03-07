/**
 * Shared fetcher utilities tests
 * Tests failure classification, data normalization, and VPS proxy logic.
 *
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { classifyFetchError, type FailureReason } from '../shared'

describe('classifyFetchError', () => {
  it('classifies timeout errors', () => {
    expect(classifyFetchError(new Error('The operation was aborted'))).toBe('timeout')
    expect(classifyFetchError(new Error('ETIMEDOUT'))).toBe('timeout')
    expect(classifyFetchError(new Error('timeout exceeded'))).toBe('timeout')
  })

  it('classifies rate limiting', () => {
    expect(classifyFetchError(null, 429)).toBe('rate_limited')
    expect(classifyFetchError(new Error('429 Too Many Requests'))).toBe('rate_limited')
    expect(classifyFetchError(new Error('rate limit exceeded'))).toBe('rate_limited')
  })

  it('classifies geo-blocking', () => {
    expect(classifyFetchError(null, 451)).toBe('geo_blocked')
    expect(classifyFetchError(new Error('restricted location'))).toBe('geo_blocked')
    expect(classifyFetchError(new Error('Geo-blocked'))).toBe('geo_blocked')
    expect(classifyFetchError(null, 403, 'restricted region')).toBe('geo_blocked')
  })

  it('classifies auth required', () => {
    expect(classifyFetchError(null, 401)).toBe('auth_required')
    expect(classifyFetchError(new Error('Unauthorized'))).toBe('auth_required')
  })

  it('classifies endpoint gone (404)', () => {
    expect(classifyFetchError(null, 404)).toBe('endpoint_gone')
    expect(classifyFetchError(new Error('Not Found'))).toBe('endpoint_gone')
  })

  it('classifies WAF blocks', () => {
    expect(classifyFetchError(new Error('Access Denied'))).toBe('waf_blocked')
    expect(classifyFetchError(new Error('WAF block'))).toBe('waf_blocked')
    expect(classifyFetchError(null, 403, '', { 'cf-ray': '123' })).toBe('waf_blocked')
    // HTML response = WAF block
    expect(classifyFetchError(null, 200, '<html>Cloudflare challenge</html>')).toBe('waf_blocked')
  })

  it('classifies generic 403 as geo_blocked', () => {
    expect(classifyFetchError(null, 403, 'Forbidden')).toBe('geo_blocked')
  })

  it('returns unknown for unclassifiable errors', () => {
    expect(classifyFetchError(new Error('Something weird happened'))).toBe('unknown')
    expect(classifyFetchError(null)).toBe('unknown')
  })

  it('handles non-Error objects', () => {
    expect(classifyFetchError('timeout string')).toBe('timeout')
    expect(classifyFetchError(42)).toBe('unknown')
    expect(classifyFetchError(undefined)).toBe('unknown')
  })

  // Priority tests: ensure correct classification when multiple signals match
  it('prioritizes timeout over other signals', () => {
    // Timeout should win even if status is 403
    expect(classifyFetchError(new Error('abort'), 403)).toBe('timeout')
  })

  it('prioritizes rate_limit over geo_block', () => {
    expect(classifyFetchError(null, 429, 'restricted')).toBe('rate_limited')
  })
})
