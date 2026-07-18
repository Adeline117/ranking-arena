const mockLimit = jest.fn()

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: (...args: unknown[]) => mockLimit(...args),
        }),
      }),
    }),
  }),
}))

import { fetchInitialActivities } from '../page'

describe('feed SSR seed', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps a query failure distinct from a legitimate empty feed', async () => {
    mockLimit.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    })
    mockLimit.mockResolvedValueOnce({ data: [], error: null })

    await expect(fetchInitialActivities()).resolves.toMatchObject({
      activities: [],
      status: 'error',
    })
    await expect(fetchInitialActivities()).resolves.toMatchObject({
      activities: [],
      status: 'success',
    })
  })
})
