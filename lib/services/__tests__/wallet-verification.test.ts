/**
 * Wallet claim challenge and signature verification security tests.
 */

jest.mock('viem', () => ({
  verifyMessage: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: jest.fn(),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { resolveTrader } from '@/lib/data/unified'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { createWalletClaimChallenge, verifyWalletOwnership } from '../wallet-verification'

const mockedResolveTrader = jest.mocked(resolveTrader)
const mockedGetSharedRedis = jest.mocked(getSharedRedis)
const mockSupabase = {} as Parameters<typeof verifyWalletOwnership>[0]

const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()

function createRedisFixture() {
  const values = new Map<string, string>()
  const get = jest.fn(async (key: string) => values.get(key) ?? null)
  const set = jest.fn(
    async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
      if (options?.nx && values.has(key)) return null
      values.set(key, String(value))
      return 'OK'
    }
  )
  const evalCommand = jest.fn(
    async (script: string, keys: string[], args: string[]): Promise<number> => {
      const key = keys[0]
      if (values.get(key) !== args[0]) return 0
      if (script.includes("'consumed'")) {
        values.set(key, 'consumed')
      } else {
        values.delete(key)
      }
      return 1
    }
  )
  return {
    values,
    redis: { get, set, eval: evalCommand },
    get,
    set,
    eval: evalCommand,
  }
}

async function issueAndVerify(
  redisFixture: ReturnType<typeof createRedisFixture>,
  overrides: Partial<Parameters<typeof verifyWalletOwnership>[2]> = {}
) {
  const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
  const verification = await verifyWalletOwnership(mockSupabase, 'user-1', {
    wallet_address: checksumEvm,
    signature: '0xsigned',
    challenge_id: challenge.challenge_id,
    platform: 'hyperliquid',
    trader_key: canonicalEvm,
    ...overrides,
  })
  return { challenge, verification, redisFixture }
}

describe('authenticated wallet claim challenges', () => {
  let redisFixture: ReturnType<typeof createRedisFixture>

  beforeEach(() => {
    jest.clearAllMocks()
    redisFixture = createRedisFixture()
    mockedGetSharedRedis.mockResolvedValue(redisFixture.redis as never)
    mockedResolveTrader.mockResolvedValue({
      platform: 'hyperliquid',
      traderKey: canonicalEvm,
      handle: null,
      avatarUrl: null,
    })
  })

  it('binds the signed message to Arena, the authenticated user, source, trader, nonce, and expiry', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', checksumEvm)

    expect(challenge.challenge_id).toMatch(/^[a-f0-9]{64}$/)
    expect(challenge.message).toContain('Domain: www.arenafi.org')
    expect(challenge.message).toContain('User ID: user-1')
    expect(challenge.message).toContain('Source: hyperliquid')
    expect(challenge.message).toContain(`Trader ID: ${canonicalEvm}`)
    expect(challenge.message).toContain(`Nonce: ${challenge.challenge_id}`)
    expect(challenge.message).toContain('Expiration Time:')
    expect(redisFixture.set).toHaveBeenCalledWith(
      `wallet-claim:challenge:${challenge.challenge_id}`,
      expect.any(String),
      { nx: true, ex: 300 }
    )
  })

  it('rejects a challenge replayed by another authenticated user', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)

    await expect(
      verifyWalletOwnership(mockSupabase, 'user-2', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('does not match this user, source, or trader')

    expect(redisFixture.values.has(`wallet-claim:replay:${challenge.challenge_id}`)).toBe(false)
  })

  it('rejects a challenge replayed across sources', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)

    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'gmx',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('does not match this user, source, or trader')
  })

  it('rejects an expired challenge even if a stale Redis value remains', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
    const key = `wallet-claim:challenge:${challenge.challenge_id}`
    const stored = JSON.parse(redisFixture.values.get(key)!) as Record<string, unknown>
    stored.issuedAt = Date.now() - 301_000
    stored.expiresAt = Date.now() - 1_000
    stored.message = String(stored.message)
      .replace(/Issued At: .+/, `Issued At: ${new Date(stored.issuedAt as number).toISOString()}`)
      .replace(
        /Expiration Time: .+/,
        `Expiration Time: ${new Date(stored.expiresAt as number).toISOString()}`
      )
    redisFixture.values.set(key, JSON.stringify(stored))

    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('challenge has expired')
  })

  it('atomically admits only one of two concurrent uses of the same challenge', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
    const input = {
      wallet_address: canonicalEvm,
      signature: '0xsigned',
      challenge_id: challenge.challenge_id,
      platform: 'hyperliquid',
      trader_key: canonicalEvm,
    }

    const results = await Promise.allSettled([
      verifyWalletOwnership(mockSupabase, 'user-1', input),
      verifyWalletOwnership(mockSupabase, 'user-1', input),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(redisFixture.set).toHaveBeenCalledWith(
      `wallet-claim:replay:${challenge.challenge_id}`,
      expect.any(String),
      { nx: true, ex: 600 }
    )
  })

  it('releases only its own reservation after a downstream verification failure so retry can succeed', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
    mockedResolveTrader.mockResolvedValueOnce(null)
    const input = {
      wallet_address: canonicalEvm,
      signature: '0xsigned',
      challenge_id: challenge.challenge_id,
      platform: 'hyperliquid',
      trader_key: canonicalEvm,
    }

    await expect(verifyWalletOwnership(mockSupabase, 'user-1', input)).rejects.toThrow(
      'Trader account was not found'
    )
    expect(redisFixture.values.has(`wallet-claim:replay:${challenge.challenge_id}`)).toBe(false)

    await expect(verifyWalletOwnership(mockSupabase, 'user-1', input)).resolves.toMatchObject({
      verified: true,
      challenge_id: challenge.challenge_id,
    })
  })

  it('cannot release a replay marker after losing reservation ownership', async () => {
    const { challenge, verification } = await issueAndVerify(redisFixture)
    const replayKey = `wallet-claim:replay:${challenge.challenge_id}`
    redisFixture.values.set(replayKey, 'another-request-owner')

    await expect(verification.reservation.release()).resolves.toBe(false)
    expect(redisFixture.values.get(replayKey)).toBe('another-request-owner')
  })

  it('keeps a consumed marker through its TTL and rejects subsequent replay', async () => {
    const { challenge, verification } = await issueAndVerify(redisFixture)

    await expect(verification.reservation.consume()).resolves.toBe(true)
    expect(redisFixture.values.get(`wallet-claim:replay:${challenge.challenge_id}`)).toBe(
      'consumed'
    )
    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('already in use or has been consumed')
  })

  it('fails closed when Redis is unavailable during issuance or verification', async () => {
    mockedGetSharedRedis.mockResolvedValue(null)
    await expect(
      createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
    ).rejects.toMatchObject({
      message: expect.stringContaining('temporarily unavailable'),
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      retryAfter: 30,
    })

    mockedGetSharedRedis.mockResolvedValue(redisFixture.redis as never)
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', canonicalEvm)
    mockedGetSharedRedis.mockResolvedValue(null)
    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('temporarily unavailable'),
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      retryAfter: 30,
    })
  })

  it('rejects the legacy freely constructed message format without a server challenge id', async () => {
    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        message: `I am claiming trader profile ${canonicalEvm} on Arena. Timestamp: ${Date.now()}`,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      } as unknown as Parameters<typeof verifyWalletOwnership>[2])
    ).rejects.toThrow('challenge_id must be a non-empty string')
  })
})

describe('chain-specific wallet identity verification', () => {
  let redisFixture: ReturnType<typeof createRedisFixture>

  beforeEach(() => {
    jest.clearAllMocks()
    redisFixture = createRedisFixture()
    mockedGetSharedRedis.mockResolvedValue(redisFixture.redis as never)
  })

  it.each(['gains', 'aevo', 'dydx', 'jupiter_perps', 'drift'])(
    'does not issue a challenge for retired or blocked source %s',
    async (source) => {
      await expect(createWalletClaimChallenge('user-1', source, canonicalEvm)).rejects.toThrow(
        'does not support wallet signature verification'
      )
      expect(redisFixture.set).not.toHaveBeenCalled()
    }
  )

  it('canonicalizes EVM checksum case for lookup and storage', async () => {
    const challenge = await createWalletClaimChallenge('user-1', 'hyperliquid', checksumEvm)
    mockedResolveTrader.mockResolvedValue({
      platform: 'hyperliquid',
      traderKey: canonicalEvm,
      handle: null,
      avatarUrl: null,
    })

    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: checksumEvm,
        signature: '0xsigned',
        challenge_id: challenge.challenge_id,
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).resolves.toMatchObject({
      verified: true,
      wallet_address: canonicalEvm,
      chain: 'evm',
    })
    expect(mockedResolveTrader).toHaveBeenCalledWith(mockSupabase, {
      handle: canonicalEvm,
      platform: 'hyperliquid',
    })
  })

  it('rejects non-string nested wallet input before challenge reservation', async () => {
    await expect(
      verifyWalletOwnership(mockSupabase, 'user-1', {
        wallet_address: { value: canonicalEvm } as unknown as string,
        signature: '0xsigned',
        challenge_id: 'a'.repeat(64),
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('wallet_address must be a non-empty string')
    expect(mockedResolveTrader).not.toHaveBeenCalled()
  })
})
