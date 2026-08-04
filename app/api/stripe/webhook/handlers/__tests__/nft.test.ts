const mockMintMembershipNFT = jest.fn()
const mockGetUserTokenIdStrict = jest.fn()
const mockIsMintingConfigured = jest.fn()
const mockSendNotification = jest.fn()
const mockLoggerInfo = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/web3/mint', () => ({
  mintMembershipNFT: (...args: unknown[]) => mockMintMembershipNFT(...args),
  getUserTokenIdStrict: (...args: unknown[]) => mockGetUserTokenIdStrict(...args),
  isMintingConfigured: () => mockIsMintingConfigured(),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

type Profile = {
  id: string
  wallet_address: string | null
  nft_token_id: string | null
  nft_minted_at: string | null
}

let profile: Profile
let markerWriteError: { message: string } | null

function matches(filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([operator, column, expected]) => {
    const actual = profile[column as keyof Profile]
    if (operator === 'eq') return actual === expected
    if (operator === 'is') return actual === expected
    if (operator === 'lt') return typeof actual === 'string' && actual < String(expected)
    return false
  })
}

function updateBuilder(values: Partial<Profile>) {
  const filters: Array<[string, string, unknown]> = []
  let result: Promise<{ data: { id: string } | null; error: { message: string } | null }> | null =
    null

  const execute = () => {
    result ??= Promise.resolve().then(() => {
      if (values.nft_token_id === '42' && markerWriteError) {
        return { data: null, error: markerWriteError }
      }
      if (!matches(filters)) return { data: null, error: null }
      profile = { ...profile, ...values }
      return { data: { id: profile.id }, error: null }
    })
    return result
  }

  const builder = {
    eq(column: string, value: unknown) {
      filters.push(['eq', column, value])
      return builder
    },
    is(column: string, value: unknown) {
      filters.push(['is', column, value])
      return builder
    },
    lt(column: string, value: unknown) {
      filters.push(['lt', column, value])
      return builder
    },
    select() {
      return builder
    },
    maybeSingle: execute,
    then<TResult1 = { data: { id: string } | null; error: { message: string } | null }>(
      onfulfilled?:
        | ((value: {
            data: { id: string } | null
            error: { message: string } | null
          }) => TResult1 | PromiseLike<TResult1>)
        | null
    ) {
      return execute().then(onfulfilled)
    },
  }
  return builder
}

const mockSupabase = {
  from: jest.fn(() => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { ...profile }, error: null }),
      }),
    }),
    update: (values: Partial<Profile>) => updateBuilder(values),
  })),
}

jest.mock('../shared', () => ({
  getSupabase: () => mockSupabase,
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

import { mintNFTForUser } from '../nft'

describe('mintNFTForUser durable idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    profile = {
      id: 'user-1',
      wallet_address: '0x1111111111111111111111111111111111111111',
      nft_token_id: null,
      nft_minted_at: null,
    }
    markerWriteError = null
    mockIsMintingConfigured.mockReturnValue(true)
    mockGetUserTokenIdStrict.mockResolvedValue(null)
  })

  it('allows only one concurrent checkout delivery to reach the on-chain mint', async () => {
    let finishMint:
      | ((value: { success: true; tokenId: bigint; txHash: string }) => void)
      | undefined
    let markMintStarted: (() => void) | undefined
    const mintStarted = new Promise<void>((resolve) => {
      markMintStarted = resolve
    })
    mockMintMembershipNFT.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMint = resolve
          markMintStarted?.()
        })
    )

    const first = mintNFTForUser('user-1', 'monthly', 'cs_first')
    await mintStarted

    await expect(mintNFTForUser('user-1', 'monthly', 'cs_second')).rejects.toThrow(
      'already claimed'
    )
    expect(mockMintMembershipNFT).toHaveBeenCalledTimes(1)

    finishMint?.({ success: true, tokenId: 42n, txHash: '0xabc' })
    await first
    expect(profile.nft_token_id).toBe('42')
  })

  it('throws when the post-mint durable marker cannot be written', async () => {
    markerWriteError = { message: 'marker persistence failed' }
    mockMintMembershipNFT.mockResolvedValue({ success: true, tokenId: 42n, txHash: '0xabc' })

    await expect(mintNFTForUser('user-1', 'yearly', 'cs_marker_error')).rejects.toThrow(
      'marker persistence failed'
    )
    expect(profile.nft_token_id).toBe('pending:stripe-checkout:cs_marker_error')
  })

  it('reconciles a confirmed chain token after a process dies before marker persistence', async () => {
    profile.nft_token_id = 'pending:stripe-checkout:cs_old'
    profile.nft_minted_at = '2026-08-04T00:00:00.000Z'
    mockGetUserTokenIdStrict.mockResolvedValue(42n)

    await mintNFTForUser('user-1', 'monthly', 'cs_retry')

    expect(mockMintMembershipNFT).not.toHaveBeenCalled()
    expect(profile.nft_token_id).toBe('42')
  })

  it('fails closed when chain reconciliation is unavailable', async () => {
    mockGetUserTokenIdStrict.mockRejectedValue(new Error('chain RPC unavailable'))

    await expect(mintNFTForUser('user-1', 'monthly', 'cs_rpc_down')).rejects.toThrow(
      'chain RPC unavailable'
    )
    expect(mockMintMembershipNFT).not.toHaveBeenCalled()
    expect(profile.nft_token_id).toBeNull()
  })
})
