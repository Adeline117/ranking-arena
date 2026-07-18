import { renderHook, waitFor } from '@testing-library/react'
import { useOnchainEnrichTrigger } from '../useOnchainEnrichTrigger'

const mockInvalidateQueries = jest.fn()
const mockQueryClient = { invalidateQueries: mockInvalidateQueries }

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'test-csrf' }),
}))

const baseParams = {
  source: 'okx_web3_solana',
  exchangeTraderId: 'SolanaWallet1111111111111111111111111111111',
  extras: {},
  enabled: true,
  loaded: true,
}

describe('useOnchainEnrichTrigger', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('exposes provider-capacity 503 as nonfatal optional unavailability', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as jest.Mock

    const { result } = renderHook(() => useOnchainEnrichTrigger(baseParams))

    await waitFor(() => expect(result.current).toBe('unavailable'))
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })

  it('keeps the request alive when rendering the loading state', async () => {
    let resolveFetch!: (value: { ok: boolean; status: number; json: () => Promise<object> }) => void
    let requestSignal: AbortSignal | undefined
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    }) as jest.Mock

    const { result } = renderHook(() => useOnchainEnrichTrigger(baseParams))

    await waitFor(() => expect(result.current).toBe('loading'))
    expect(requestSignal?.aborted).toBe(false)

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ status: 'fresh', skipped: true }),
    })
    await waitFor(() => expect(result.current).toBe('idle'))
  })

  it('keeps permanent server failures distinct from capacity degradation', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as jest.Mock

    const { result } = renderHook(() => useOnchainEnrichTrigger(baseParams))

    await waitFor(() => expect(result.current).toBe('failed'))
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })

  it('invalidates trader core after a successful enrichment', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'enriched' }),
    }) as jest.Mock
    mockInvalidateQueries.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOnchainEnrichTrigger(baseParams))

    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledTimes(1))
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['trader-core', 'okx_web3_solana', 'SolanaWallet1111111111111111111111111111111'],
    })
    await waitFor(() => expect(result.current).toBe('idle'))
  })

  it('does not call enrichment when on-chain data is already present', async () => {
    global.fetch = jest.fn() as jest.Mock

    const { result } = renderHook(() =>
      useOnchainEnrichTrigger({
        ...baseParams,
        extras: { onchain_derivation: { source: 'onchain-computed' } },
      })
    )

    await waitFor(() => expect(result.current).toBe('idle'))
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
