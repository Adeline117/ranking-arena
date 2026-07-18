import type { ReactElement } from 'react'

const mockRpc = jest.fn()

jest.mock('next/cache', () => ({
  unstable_cache: (loader: (...args: unknown[]) => unknown) => loader,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

jest.mock('../TokensIndexClient', () => ({
  __esModule: true,
  default: () => null,
}))

import TokensPage, { loadPopularTokensSSR } from '../page'

type TokensPageProps = {
  initialTokens: unknown[]
  initialStatus: 'success' | 'error'
}

describe('token rankings index SSR state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('throws upstream failures out of the cached loader and marks the client seed failed', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })

    await expect(loadPopularTokensSSR()).rejects.toThrow('database unavailable')

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialTokens: [],
      initialStatus: 'error',
    })
  })

  it('keeps a legitimate empty result distinct from failure', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialTokens: [],
      initialStatus: 'success',
    })
  })

  it('marks an SSR timeout as failure instead of an empty success', async () => {
    jest.useFakeTimers()
    try {
      mockRpc.mockReturnValue(new Promise(() => undefined))
      const page = TokensPage()

      await jest.advanceTimersByTimeAsync(4_000)

      const element = (await page) as ReactElement<TokensPageProps>
      expect(element.props).toMatchObject({
        initialTokens: [],
        initialStatus: 'error',
      })
    } finally {
      jest.useRealTimers()
    }
  })
})
