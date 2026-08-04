import { render, screen } from '@testing-library/react'

const mockGetSupabaseAdmin = jest.fn()
const mockTieredGetOrSet = jest.fn()
const mockCheckRateLimit = jest.fn()

jest.mock('@/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    lang: 'en',
    t: (key: string) =>
      ({
        tokenRankingsContainmentLabel: 'Verification hold',
        tokenRankingsContainmentTitle: 'Token rankings are temporarily withheld',
        tokenRankingsContainmentDescription: 'No token ranking is published.',
        tokenRankingsContainmentBack: 'Return to trader rankings',
      })[key] ?? key,
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

import TokensPage, { metadata } from '../page'
import TokenRankingContainment from '../TokenRankingContainment'

const originalFetch = global.fetch

describe('token rankings index containment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('is noindex and renders the server-only publication hold', async () => {
    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true })
    expect(TokensPage().type).toBe(TokenRankingContainment)

    render(await TokenRankingContainment())

    expect(screen.getByRole('heading')).toHaveTextContent('Token rankings are temporarily withheld')
    expect(screen.getByRole('status')).toHaveTextContent('No token ranking is published.')
    expect(screen.getByText('TOKEN_RANKING_NOT_PUBLISHED')).toBeInTheDocument()
  })

  it('does not call Supabase, Redis, rate limiting, or fetch', async () => {
    TokensPage()
    await TokenRankingContainment()

    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
