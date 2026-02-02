/**
 * Tests for NFT membership check utilities
 */

// Mock contracts module
const mockReadContract = jest.fn()
jest.mock('../contracts', () => ({
  CONTRACT_ADDRESSES: {
    membershipNFT: undefined as `0x${string}` | undefined,
  },
  basePublicClient: {
    readContract: (...args: unknown[]) => mockReadContract(...args),
  },
}))

import { checkNFTMembership, getNFTBalance, getTokenExpiry } from '../nft'
import { CONTRACT_ADDRESSES } from '../contracts'

describe('checkNFTMembership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset to undefined (not deployed)
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = undefined
  })

  it('returns false when contract is not deployed (no address)', async () => {
    const result = await checkNFTMembership('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(false)
    expect(mockReadContract).not.toHaveBeenCalled()
  })

  it('returns true for valid membership', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockResolvedValue(true)

    const result = await checkNFTMembership('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(true)
    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'hasValidMembership',
      })
    )
  })

  it('returns false for expired/no membership', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockResolvedValue(false)

    const result = await checkNFTMembership('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(false)
  })

  it('handles RPC errors gracefully by returning false', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockRejectedValue(new Error('RPC timeout'))

    const result = await checkNFTMembership('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(false)
  })
})

describe('getNFTBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = undefined
  })

  it('returns 0 when contract is not deployed', async () => {
    const result = await getNFTBalance('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(0)
  })

  it('returns balance from contract', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockResolvedValue(BigInt(3))

    const result = await getNFTBalance('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(3)
  })

  it('returns 0 on RPC error', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockRejectedValue(new Error('network error'))

    const result = await getNFTBalance('0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBe(0)
  })
})

describe('getTokenExpiry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = undefined
  })

  it('returns null when contract is not deployed', async () => {
    const result = await getTokenExpiry(BigInt(1))
    expect(result).toBeNull()
  })

  it('returns a Date from the contract timestamp', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400)
    mockReadContract.mockResolvedValue(futureTs)

    const result = await getTokenExpiry(BigInt(1))
    expect(result).toBeInstanceOf(Date)
    expect(result!.getTime()).toBe(Number(futureTs) * 1000)
  })

  it('returns null on RPC error', async () => {
    ;(CONTRACT_ADDRESSES as { membershipNFT: string | undefined }).membershipNFT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    mockReadContract.mockRejectedValue(new Error('bad call'))

    const result = await getTokenExpiry(BigInt(1))
    expect(result).toBeNull()
  })
})
