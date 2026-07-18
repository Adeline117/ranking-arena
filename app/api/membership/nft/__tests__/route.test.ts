/** @jest-environment node */

const mockMaybeSingle = jest.fn()
const mockFrom = jest.fn((table: string) => {
  if (table !== 'user_profiles') {
    throw new Error(`Unexpected entitlement write/read table: ${table}`)
  }
  return {
    select: jest.fn(() => ({
      eq: jest.fn(() => ({
        maybeSingle: mockMaybeSingle,
      })),
    })),
  }
})
const mockCheckNFTMembership = jest.fn()
const mockGetTokenExpiry = jest.fn()
const mockGetUserTokenId = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => () =>
    handler({
      user: { id: 'user-1' },
      supabase: { from: mockFrom },
    }),
}))

jest.mock('@/lib/web3/nft', () => ({
  checkNFTMembership: (...args: unknown[]) => mockCheckNFTMembership(...args),
  getTokenExpiry: (...args: unknown[]) => mockGetTokenExpiry(...args),
}))

jest.mock('@/lib/web3/mint', () => ({
  getUserTokenId: (...args: unknown[]) => mockGetUserTokenId(...args),
}))

import { GET } from '../route'

describe('GET /api/membership/nft badge observation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns an empty badge without touching the chain when no wallet is linked', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { wallet_address: null }, error: null })

    const response = await GET(new Request('https://www.arenafi.org/api/membership/nft'))

    await expect(response.json()).resolves.toEqual({
      hasNft: false,
      walletAddress: null,
    })
    expect(mockCheckNFTMembership).not.toHaveBeenCalled()
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('returns verified badge details without writing Pro entitlement state', async () => {
    const expiresAt = new Date('2027-07-18T00:00:00.000Z')
    mockMaybeSingle.mockResolvedValue({
      data: { wallet_address: '0x1234567890abcdef1234567890abcdef12345678' },
      error: null,
    })
    mockCheckNFTMembership.mockResolvedValue(true)
    mockGetUserTokenId.mockResolvedValue(42n)
    mockGetTokenExpiry.mockResolvedValue(expiresAt)

    const response = await GET(new Request('https://www.arenafi.org/api/membership/nft'))

    await expect(response.json()).resolves.toEqual({
      hasNft: true,
      tokenId: '42',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      expiresAt: expiresAt.toISOString(),
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockCheckNFTMembership).toHaveBeenCalledWith(
      '0x1234567890abcdef1234567890abcdef12345678'
    )
  })
})
