const mockSet = jest.fn()
const mockGetdel = jest.fn()
const mockGetSharedRedis = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

import { consumeSiweNonce, storeSiweNonce } from '../siwe-nonce'

const NONCE = 'a'.repeat(64)

describe('SIWE nonce single-use store', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSharedRedis.mockResolvedValue({ set: mockSet, getdel: mockGetdel })
    mockSet.mockResolvedValue('OK')
    mockGetdel.mockResolvedValue('pending')
  })

  it('stores an unguessable nonce once with the exact five-minute lifetime', async () => {
    await expect(storeSiweNonce(NONCE)).resolves.toBeUndefined()

    expect(mockSet).toHaveBeenCalledWith(`siwe:nonce:${NONCE}`, 'pending', {
      ex: 300,
      nx: true,
    })
  })

  it('atomically consumes a nonce exactly once', async () => {
    await expect(consumeSiweNonce(NONCE)).resolves.toBe(true)
    mockGetdel.mockResolvedValueOnce(null)
    await expect(consumeSiweNonce(NONCE)).resolves.toBe(false)

    expect(mockGetdel).toHaveBeenCalledTimes(2)
    expect(mockGetdel).toHaveBeenCalledWith(`siwe:nonce:${NONCE}`)
  })

  it('never falls back when Redis is unavailable or refuses the unique write', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    await expect(storeSiweNonce(NONCE)).rejects.toThrow('unavailable')

    mockSet.mockResolvedValueOnce(null)
    await expect(storeSiweNonce(NONCE)).rejects.toThrow('collision')

    mockGetSharedRedis.mockResolvedValueOnce(null)
    await expect(consumeSiweNonce(NONCE)).rejects.toThrow('unavailable')
  })

  it('rejects malformed nonces before touching Redis', async () => {
    await expect(storeSiweNonce('not-a-nonce')).rejects.toThrow('Invalid SIWE nonce')
    await expect(consumeSiweNonce('not-a-nonce')).resolves.toBe(false)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })
})
