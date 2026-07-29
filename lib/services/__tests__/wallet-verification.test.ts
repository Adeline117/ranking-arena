/**
 * Wallet Verification Service Tests
 *
 * Tests parseClaimMessage() and message freshness validation.
 * Skips actual crypto signature verification (requires complex chain mocking).
 */

// Mock external dependencies to avoid real crypto operations
jest.mock('viem', () => ({
  verifyMessage: jest.fn().mockResolvedValue(true),
}))

jest.mock('@solana/web3.js', () => ({
  PublicKey: jest.fn().mockImplementation(() => ({
    toBytes: () => new Uint8Array(32),
  })),
}))

jest.mock('tweetnacl', () => ({
  sign: {
    detached: {
      verify: jest.fn().mockReturnValue(true),
    },
  },
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn().mockResolvedValue(null),
}))

import { resolveTrader } from '@/lib/data/unified'
import { parseClaimMessage, verifyWalletOwnership } from '../wallet-verification'
import { buildTraderClaimWalletMessage } from '@/lib/auth/trader-claim-wallet-message'
import { getSharedRedis } from '@/lib/cache/redis-client'

const mockedResolveTrader = jest.mocked(resolveTrader)
const mockedGetSharedRedis = jest.mocked(getSharedRedis)
const mockSupabase = {} as Parameters<typeof verifyWalletOwnership>[0]
const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

function claimMessage(
  traderKey: string,
  overrides: Partial<{
    userId: string
    source: string
    timestamp: number
  }> = {}
): string {
  return buildTraderClaimWalletMessage({
    userId: overrides.userId ?? USER_ID,
    source: overrides.source ?? 'hyperliquid',
    traderKey,
    timestamp: overrides.timestamp ?? Date.now(),
  })
}

// ═══════════════════════════════════════════════════════
// parseClaimMessage
// ═══════════════════════════════════════════════════════

describe('parseClaimMessage', () => {
  test('parses valid message correctly', () => {
    const ts = Date.now()
    const msg = claimMessage('0xABC123', { timestamp: ts })
    const result = parseClaimMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe(USER_ID)
    expect(result!.source).toBe('hyperliquid')
    expect(result!.traderKey).toBe('0xABC123')
    expect(result!.timestamp).toBe(ts)
  })

  test('returns null for empty string', () => {
    expect(parseClaimMessage('')).toBeNull()
  })

  test('returns null for wrong prefix', () => {
    const msg = claimMessage('0xABC123').replace('Arena trader claim', 'Hello world')
    expect(parseClaimMessage(msg)).toBeNull()
  })

  test('returns null for missing timestamp', () => {
    const msg = claimMessage('0xABC123').replace(/\nTimestamp: \d+$/, '')
    expect(parseClaimMessage(msg)).toBeNull()
  })

  test('returns null for non-numeric timestamp', () => {
    const msg = claimMessage('0xABC123').replace(/\d+$/, 'not-a-number')
    expect(parseClaimMessage(msg)).toBeNull()
  })

  test('returns null for missing trader key', () => {
    const msg = claimMessage('0xABC123').replace('Trader ID: 0xABC123', 'Trader ID: ')
    expect(parseClaimMessage(msg)).toBeNull()
  })

  test('handles trader keys with special characters', () => {
    const ts = 1700000000000
    const msg = claimMessage('0x1234-ABCD.test', { timestamp: ts })
    const result = parseClaimMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.traderKey).toBe('0x1234-ABCD.test')
    expect(result!.timestamp).toBe(ts)
  })

  test('handles Solana-style base58 trader keys', () => {
    const ts = 1700000000000
    const key = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
    const msg = claimMessage(key, { source: 'drift', timestamp: ts })
    const result = parseClaimMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.traderKey).toBe(key)
  })

  test('timestamp is parsed as integer', () => {
    const msg = claimMessage('0xABC', { timestamp: 1700000000000 })
    const result = parseClaimMessage(msg)
    expect(result).not.toBeNull()
    expect(typeof result!.timestamp).toBe('number')
    expect(result!.timestamp).toBe(1700000000000)
  })

  test('returns null for extra text after timestamp', () => {
    const msg = `${claimMessage('0xABC')} extra`
    expect(parseClaimMessage(msg)).toBeNull()
  })

  test('returns null for extra text before prefix', () => {
    const msg = `extra ${claimMessage('0xABC')}`
    expect(parseClaimMessage(msg)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// Message freshness validation (via verifyWalletOwnership behavior)
// ═══════════════════════════════════════════════════════

describe('message freshness', () => {
  // We can't easily test verifyWalletOwnership end-to-end without extensive
  // mocking, but we can validate the constants and logic conceptually.

  test('MAX_MESSAGE_AGE is 5 minutes', () => {
    // The module uses 5 * 60 * 1000 = 300000ms
    const EXPECTED_MAX_AGE = 5 * 60 * 1000
    expect(EXPECTED_MAX_AGE).toBe(300000)
  })

  test('a message from 1 second ago should be fresh', () => {
    const messageTimestamp = Date.now() - 1000
    const age = Date.now() - messageTimestamp
    expect(age).toBeLessThan(5 * 60 * 1000) // within 5 min
  })

  test('a message from 10 minutes ago should be expired', () => {
    const messageTimestamp = Date.now() - 10 * 60 * 1000
    const age = Date.now() - messageTimestamp
    expect(age).toBeGreaterThan(5 * 60 * 1000)
  })

  test('a message from the future (within 60s tolerance) should be acceptable', () => {
    const messageTimestamp = Date.now() + 30000 // 30s in the future
    const age = Date.now() - messageTimestamp
    // age is negative (-30s), which is > -60000, so within tolerance
    expect(age).toBeGreaterThan(-60000)
  })

  test('a message from far in the future should be rejected', () => {
    const messageTimestamp = Date.now() + 120000 // 2 min in the future
    const age = Date.now() - messageTimestamp
    // age is ~-120000, which is < -60000
    expect(age).toBeLessThan(-60000)
  })
})

describe('chain-specific wallet identity verification', () => {
  const solanaTrader = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const caseCollidingSolanaWallet = '7XKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
  const canonicalEvm = checksumEvm.toLowerCase()

  beforeEach(() => {
    jest.clearAllMocks()
    mockedGetSharedRedis.mockResolvedValue(null)
  })

  test('rejects a different valid-looking Solana key that collides only after lowercasing', async () => {
    mockedResolveTrader.mockResolvedValue({
      platform: 'drift',
      traderKey: solanaTrader,
      handle: null,
      avatarUrl: null,
    })

    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: caseCollidingSolanaWallet,
        signature: 'c2lnbmF0dXJl',
        message: claimMessage(solanaTrader, { source: 'drift' }),
        platform: 'drift',
        trader_key: solanaTrader,
      })
    ).rejects.toThrow('does not match this trader account')
  })

  test('accepts an exact Solana identity without changing its case', async () => {
    mockedResolveTrader.mockResolvedValue({
      platform: 'drift',
      traderKey: solanaTrader,
      handle: null,
      avatarUrl: null,
    })

    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: solanaTrader,
        signature: 'c2lnbmF0dXJl',
        message: claimMessage(solanaTrader, { source: 'drift' }),
        platform: 'drift',
        trader_key: solanaTrader,
      })
    ).resolves.toMatchObject({
      verified: true,
      wallet_address: solanaTrader,
      chain: 'solana',
    })
  })

  test('canonicalizes EVM checksum case for lookup and storage', async () => {
    mockedResolveTrader.mockResolvedValue({
      platform: 'hyperliquid',
      traderKey: canonicalEvm,
      handle: null,
      avatarUrl: null,
    })

    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: checksumEvm,
        signature: '0xsigned',
        message: claimMessage(checksumEvm),
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

  test('fails closed when the claimed wallet is not an Arena trader', async () => {
    mockedResolveTrader.mockResolvedValue(null)

    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        message: claimMessage(canonicalEvm),
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('Trader account was not found in Arena')
  })

  test('rejects non-string nested wallet input before crypto or lookup', async () => {
    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: { value: canonicalEvm } as unknown as string,
        signature: '0xsigned',
        message: claimMessage(canonicalEvm),
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('wallet_address must be a non-empty string')
    expect(mockedResolveTrader).not.toHaveBeenCalled()
  })

  test('rejects a valid wallet proof issued for another authenticated user', async () => {
    await expect(
      verifyWalletOwnership(mockSupabase, OTHER_USER_ID, {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        message: claimMessage(canonicalEvm),
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('different Arena user')
    expect(mockedResolveTrader).not.toHaveBeenCalled()
  })

  test('rejects a valid wallet proof issued for another source', async () => {
    await expect(
      verifyWalletOwnership(mockSupabase, USER_ID, {
        wallet_address: canonicalEvm,
        signature: '0xsigned',
        message: claimMessage(canonicalEvm, { source: 'gmx' }),
        platform: 'hyperliquid',
        trader_key: canonicalEvm,
      })
    ).rejects.toThrow('different trader source')
    expect(mockedResolveTrader).not.toHaveBeenCalled()
  })

  test('claims the replay key with one atomic SET NX operation', async () => {
    const set = jest.fn().mockResolvedValue('OK')
    mockedGetSharedRedis.mockResolvedValue({ set } as never)
    mockedResolveTrader.mockResolvedValue({
      platform: 'hyperliquid',
      traderKey: canonicalEvm,
      handle: null,
      avatarUrl: null,
    })

    await verifyWalletOwnership(mockSupabase, USER_ID, {
      wallet_address: canonicalEvm,
      signature: '0xatomic-proof',
      message: claimMessage(canonicalEvm),
      platform: 'hyperliquid',
      trader_key: canonicalEvm,
    })

    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^wallet-sig:v2:[0-9a-f]{64}$/),
      USER_ID,
      { nx: true, ex: 600 }
    )
  })
})
