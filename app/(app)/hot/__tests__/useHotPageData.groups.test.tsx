import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockUseAuthSession = jest.fn()
const mockShowToast = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))

import { useHotPageData } from '../useHotPageData'

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  }
}

describe('useHotPageData groups error boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockUseAuthSession.mockReturnValue({
      accessToken: null,
      authChecked: true,
      email: null,
      userId: null,
      viewerKey: 'anon',
      sessionGeneration: 0,
    })
    global.fetch = mockFetch as never
  })

  it('surfaces a non-2xx response instead of disguising it as no data', async () => {
    const groupsFailure = response(503, { error: 'temporarily unavailable' })
    mockFetch
      .mockResolvedValueOnce(response(200, { data: { posts: [] } }))
      .mockResolvedValueOnce(groupsFailure)

    const { result } = renderHook(() => useHotPageData())
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    act(() => result.current.setActiveHotTab('groups'))

    await waitFor(() => expect(result.current.groupsError?.message).toContain('503'))
    expect(result.current.loadingGroups).toBe(false)
    expect(result.current.groups).toEqual([])
    expect(groupsFailure.json).not.toHaveBeenCalled()
  })

  it('retries in place and admits only groups with concrete identity and member count', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200, { data: { posts: [] } }))
      .mockResolvedValueOnce(response(500, { error: 'failed' }))
      .mockResolvedValueOnce(
        response(200, {
          data: {
            groups: [
              { id: 'group-a', name: 'Group A', name_en: 'Group A', member_count: 12 },
              { id: '', name: 'Missing identity', member_count: 10 },
              { id: 'group-invalid-count', name: 'Invalid count', member_count: null },
            ],
          },
        })
      )

    const { result } = renderHook(() => useHotPageData())
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))
    act(() => result.current.setActiveHotTab('groups'))
    await waitFor(() => expect(result.current.groupsError).not.toBeNull())

    await act(async () => {
      await result.current.refreshGroups()
    })

    expect(result.current.groupsError).toBeNull()
    expect(result.current.groups).toEqual([
      { id: 'group-a', name: 'Group A', name_en: 'Group A', member_count: 12 },
    ])
  })
})
