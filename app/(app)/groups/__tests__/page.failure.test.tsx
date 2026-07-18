import type { ReactElement } from 'react'

const groupDirectoryQuery = jest.fn()

jest.mock('next/cache', () => ({
  unstable_cache: (loader: (...args: unknown[]) => unknown) => loader,
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

jest.mock('@/lib/data/posts', () => ({
  getPosts: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: (...args: unknown[]) => groupDirectoryQuery(...args),
        }),
      }),
    }),
  }),
}))

jest.mock('@/app/components/groups/GroupsFeedPage', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import GroupsPage, { loadRecommendedGroupsSSR } from '../page'

type GroupsFeedPageProps = {
  initialGroups: unknown[]
  initialGroupsStatus: 'success' | 'error'
}

function clientProps(page: ReactElement): GroupsFeedPageProps {
  return (page.props as { children: ReactElement<GroupsFeedPageProps> }).children.props
}

describe('groups recommended-list SSR state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('throws query failures out of the cache loader and marks the client seed failed', async () => {
    groupDirectoryQuery.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })

    await expect(loadRecommendedGroupsSSR()).rejects.toThrow('database unavailable')

    const page = (await GroupsPage()) as ReactElement
    expect(clientProps(page)).toMatchObject({
      initialGroups: [],
      initialGroupsStatus: 'error',
    })
  })

  it('keeps a legitimate empty result distinct from failure', async () => {
    groupDirectoryQuery.mockResolvedValue({ data: [], error: null })

    const page = (await GroupsPage()) as ReactElement
    expect(clientProps(page)).toMatchObject({
      initialGroups: [],
      initialGroupsStatus: 'success',
    })
  })
})
