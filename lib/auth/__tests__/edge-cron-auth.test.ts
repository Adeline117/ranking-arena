import { webcrypto } from 'node:crypto'
import { safeCompareEdge, verifyEdgeCronSecret } from '../edge-cron-auth'

function makeRequest(authorization?: string): Request {
  return new Request('https://example.com/api/proxy/phemex', {
    headers: authorization ? { authorization } : undefined,
  })
}

describe('Edge cron authentication', () => {
  const originalCronSecret = process.env.CRON_SECRET
  const originalCrypto = globalThis.crypto

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true })
  })

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  test('compares equal values and rejects unequal values of any length', async () => {
    await expect(safeCompareEdge('same-secret', 'same-secret')).resolves.toBe(true)
    await expect(safeCompareEdge('same-secret', 'wrong-secret')).resolves.toBe(false)
    await expect(safeCompareEdge('short', 'a-much-longer-secret')).resolves.toBe(false)
  })

  test('accepts the configured Bearer cron secret', async () => {
    process.env.CRON_SECRET = 'edge-test-secret'

    await expect(verifyEdgeCronSecret(makeRequest('Bearer edge-test-secret'))).resolves.toBe(true)
  })

  test('rejects missing, malformed, and incorrect credentials', async () => {
    process.env.CRON_SECRET = 'edge-test-secret'

    await expect(verifyEdgeCronSecret(makeRequest())).resolves.toBe(false)
    await expect(verifyEdgeCronSecret(makeRequest('edge-test-secret'))).resolves.toBe(false)
    await expect(verifyEdgeCronSecret(makeRequest('Bearer wrong-secret'))).resolves.toBe(false)
  })

  test('rejects credentials when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET

    await expect(verifyEdgeCronSecret(makeRequest('Bearer anything'))).resolves.toBe(false)
  })
})
