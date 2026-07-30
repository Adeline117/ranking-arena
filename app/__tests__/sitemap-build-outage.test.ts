const mockReadSealedRankingAuthorityGeneration = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

import sitemap from '../sitemap'

describe('Next sitemap outage isolation', () => {
  const originalNextPhase = process.env.NEXT_PHASE

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.NEXT_PHASE
  })

  afterAll(() => {
    if (originalNextPhase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = originalNextPhase
  })

  it('keeps static URLs but never contacts the database during a production build', async () => {
    process.env.NEXT_PHASE = 'phase-production-build'

    const staticUrls = await sitemap({ id: 0 })
    const traderUrls = await sitemap({ id: 1 })
    const socialUrls = await sitemap({ id: 999 })

    expect(staticUrls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringMatching(/\/$/) }),
        expect.objectContaining({ url: expect.stringContaining('/rankings/tokens') }),
      ])
    )
    expect(traderUrls).toEqual([])
    expect(socialUrls).toEqual([])
    expect(mockReadSealedRankingAuthorityGeneration).not.toHaveBeenCalled()
  })

  it('returns no fabricated trader URLs when the runtime authority is unavailable', async () => {
    mockReadSealedRankingAuthorityGeneration.mockRejectedValue(
      new Error('publication authority timed out')
    )
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(sitemap({ id: 1 })).resolves.toEqual([])
    expect(consoleError).toHaveBeenCalledWith(
      '[sitemap] trader shard 0 unavailable:',
      'publication authority timed out'
    )

    consoleError.mockRestore()
  })
})
