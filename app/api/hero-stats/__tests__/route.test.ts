/** @jest-environment node */
const mockGetHeroStats = jest.fn()
jest.mock('@/lib/data/hero-stats', () => ({
  getHeroStats: () => mockGetHeroStats(),
}))

import { GET } from '../route'

describe('GET /api/hero-stats cache policy', () => {
  it('long-caches real data at the CDN', async () => {
    mockGetHeroStats.mockResolvedValue({ sourceBoardCount: 27, traderCount: 9000 })
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400'
    )
  })

  it('keeps fallback defaults out of the long CDN cache', async () => {
    mockGetHeroStats.mockResolvedValue({ sourceBoardCount: 28, traderCount: 9600, isDefault: true })
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=30, stale-while-revalidate=30')
    await expect(res.json()).resolves.toMatchObject({ isDefault: true })
  })
})
