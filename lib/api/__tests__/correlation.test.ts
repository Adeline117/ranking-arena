/**
 * Correlation ID system tests
 */

import {
  getOrCreateCorrelationId,
  getCorrelationId,
  runWithCorrelationId,
} from '../correlation'

// Minimal NextRequest-like object for testing
function fakeRequest(headers: Record<string, string> = {}) {
  return {
    headers: {
      get(name: string) {
        // Header lookup is case-insensitive per HTTP spec
        const key = Object.keys(headers).find(
          (k) => k.toLowerCase() === name.toLowerCase()
        )
        return key ? headers[key] : null
      },
    },
  } as unknown as import('next/server').NextRequest
}

describe('Correlation ID', () => {
  describe('getOrCreateCorrelationId', () => {
    it('should return X-Correlation-ID header when present', () => {
      const req = fakeRequest({ 'X-Correlation-ID': 'abc-123' })
      expect(getOrCreateCorrelationId(req)).toBe('abc-123')
    })

    it('should return X-Request-ID header when X-Correlation-ID is absent', () => {
      const req = fakeRequest({ 'X-Request-ID': 'req-456' })
      expect(getOrCreateCorrelationId(req)).toBe('req-456')
    })

    it('should prefer X-Correlation-ID over X-Request-ID', () => {
      const req = fakeRequest({
        'X-Correlation-ID': 'corr-1',
        'X-Request-ID': 'req-2',
      })
      expect(getOrCreateCorrelationId(req)).toBe('corr-1')
    })

    it('should generate a new ID when no header is present', () => {
      const req = fakeRequest()
      const id = getOrCreateCorrelationId(req)
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('should generate unique IDs across calls', () => {
      const req = fakeRequest()
      const id1 = getOrCreateCorrelationId(req)
      const id2 = getOrCreateCorrelationId(req)
      expect(id1).not.toBe(id2)
    })
  })

  describe('AsyncLocalStorage context', () => {
    it('should return undefined outside of a correlation context', () => {
      expect(getCorrelationId()).toBeUndefined()
    })

    it('should return the correlation ID inside runWithCorrelationId', () => {
      runWithCorrelationId('test-cid-789', () => {
        expect(getCorrelationId()).toBe('test-cid-789')
      })
    })

    it('should return undefined after the context exits', () => {
      runWithCorrelationId('temp-id', () => {
        // inside
      })
      expect(getCorrelationId()).toBeUndefined()
    })

    it('should support nested contexts', () => {
      runWithCorrelationId('outer', () => {
        expect(getCorrelationId()).toBe('outer')
        runWithCorrelationId('inner', () => {
          expect(getCorrelationId()).toBe('inner')
        })
        expect(getCorrelationId()).toBe('outer')
      })
    })

    it('should propagate through async operations', async () => {
      await runWithCorrelationId('async-cid', async () => {
        expect(getCorrelationId()).toBe('async-cid')
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(getCorrelationId()).toBe('async-cid')
      })
    })
  })
})
