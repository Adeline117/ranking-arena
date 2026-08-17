import { act, renderHook, waitFor } from '@testing-library/react'
import { useReports } from '../useReports'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockToast = jest.fn()

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const REPORT_ID = '30000000-0000-4000-8000-000000000001'
const OTHER_REPORT_ID = '30000000-0000-4000-8000-000000000002'

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

function token(subject: string, marker = 'token'): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function report(
  id: string,
  contentType: 'post' | 'comment' | 'message' | 'user' = 'post',
  overrides: Record<string, unknown> = {}
) {
  const value = {
    id,
    reporter_id: 'reporter-id',
    content_type: contentType,
    content_id: `content-${id}`,
    reason: 'spam',
    description: null,
    images: ['https://storage.test/signed/evidence'],
    status: 'pending',
    resolved_by: null,
    resolved_at: null,
    action_taken: null,
    created_at: '2026-08-17T00:00:00.000Z',
    reporter: {
      id: 'reporter-id',
      handle: 'reporter',
      avatar_url: null,
    },
    ...overrides,
  }
  return { ...value, details: value.description }
}

function clientReport(
  id: string,
  contentType: 'post' | 'comment' | 'message' | 'user' = 'post',
  overrides: Record<string, unknown> = {}
) {
  const { details: _details, ...value } = report(id, contentType, overrides)
  return { ...value, contentPreview: null, contentAuthor: null }
}

function listAck(
  reports: Array<ReturnType<typeof report>>,
  page: number,
  total: number,
  options: { status?: number } = {}
) {
  const limit = 20
  const offset = (page - 1) * limit
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    data: {
      success: true,
      data: reports,
      meta: {
        timestamp: '2026-08-17T00:00:00.000Z',
        pagination: {
          limit,
          offset,
          has_more: total > offset + limit,
          total,
        },
      },
    },
  }
}

function resolutionAck(
  reportId: string,
  action: 'resolve' | 'dismiss',
  overrides: Record<string, unknown> = {}
) {
  return {
    ok: true,
    status: 200,
    data: {
      ok: true,
      applied: true,
      result: 'applied',
      report: {
        id: reportId,
        status: action === 'resolve' ? 'resolved' : 'dismissed',
        content_type: 'post',
        content_id: `content-${reportId}`,
      },
      action_taken: action === 'resolve' ? 'content_deleted' : 'dismissed',
      content_affected_count: action === 'resolve' ? 1 : 0,
      message:
        action === 'resolve' ? 'Report resolved and content soft-deleted' : 'Report dismissed',
      ...overrides,
    },
  }
}

describe('useReports', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthedFetch.mockReset()
    __resetViewerScopeForTests()
    synchronizeViewerScope(true, ACTOR_A)
  })

  it('normalizes the real API row shape and derives client pagination', async () => {
    const accessToken = token(ACTOR_A, 'page-two')
    const resolvedComment = {
      status: 'resolved',
      resolved_by: ACTOR_A,
      resolved_at: '2026-08-17T00:01:00.000Z',
      action_taken: 'content_deleted',
    }
    mockAuthedFetch.mockResolvedValue(
      listAck([report(REPORT_ID, 'comment', resolvedComment)], 2, 45)
    )
    const hook = renderHook(() => useReports(accessToken, mockToast))

    await act(async () => {
      await hook.result.current.loadReports(2, 'resolved', 'comment')
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/admin/reports?page=2&limit=20&status=resolved&content_type=comment',
      'GET',
      accessToken,
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: ACTOR_A,
        expectedSessionGeneration: expect.any(Number),
        signal: expect.any(AbortSignal),
      })
    )
    expect(hook.result.current.reports).toEqual([
      clientReport(REPORT_ID, 'comment', resolvedComment),
    ])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    })
  })

  it('ignores an older slower load when a newer filter/page request supersedes it', async () => {
    const first = deferred<ReturnType<typeof listAck>>()
    const second = deferred<ReturnType<typeof listAck>>()
    mockAuthedFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const hook = renderHook(() => useReports(token(ACTOR_A, 'search-race'), mockToast))

    act(() => {
      void hook.result.current.loadReports(1, 'pending', 'all')
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))
    const firstSignal = mockAuthedFetch.mock.calls[0][5].signal as AbortSignal

    act(() => {
      void hook.result.current.loadReports(2, 'resolved', 'comment')
    })
    expect(firstSignal.aborted).toBe(true)
    expect(mockAuthedFetch.mock.calls[1][5].signal.aborted).toBe(false)

    await act(async () => {
      first.resolve(listAck([report(REPORT_ID)], 1, 40))
      await Promise.resolve()
    })
    expect(hook.result.current.reports).toEqual([])
    expect(hook.result.current.loading).toBe(true)

    await act(async () => {
      second.resolve(
        listAck(
          [
            report(OTHER_REPORT_ID, 'comment', {
              status: 'resolved',
              resolved_by: ACTOR_A,
              resolved_at: '2026-08-17T00:01:00.000Z',
              action_taken: 'content_deleted',
            }),
          ],
          2,
          21
        )
      )
      await Promise.resolve()
    })

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.reports).toEqual([
      clientReport(OTHER_REPORT_ID, 'comment', {
        status: 'resolved',
        resolved_by: ACTOR_A,
        resolved_at: '2026-08-17T00:01:00.000Z',
        action_taken: 'content_deleted',
      }),
    ])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    })
  })

  it('drops a late acknowledgement after the viewer switches to another actor', async () => {
    const pending = deferred<ReturnType<typeof listAck>>()
    mockAuthedFetch.mockReturnValueOnce(pending.promise)
    const hook = renderHook(({ accessToken }) => useReports(accessToken, mockToast), {
      initialProps: { accessToken: token(ACTOR_A, 'viewer-a') },
    })

    act(() => {
      void hook.result.current.loadReports(1, 'pending', 'all')
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))

    act(() => {
      synchronizeViewerScope(true, ACTOR_B)
      hook.rerender({ accessToken: token(ACTOR_B, 'viewer-b') })
    })

    await act(async () => {
      pending.resolve(listAck([report(REPORT_ID)], 1, 1))
      await Promise.resolve()
    })

    expect(hook.result.current.reports).toEqual([])
    expect(hook.result.current.loading).toBe(false)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('falls back once to the last available page when a requested page is now out of range', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(listAck([], 3, 40))
      .mockResolvedValueOnce(listAck([report(REPORT_ID)], 2, 40))
    const hook = renderHook(() => useReports(token(ACTOR_A, 'page-fallback'), mockToast))

    await act(async () => {
      await hook.result.current.loadReports(3, 'pending', 'all')
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch.mock.calls[0][0]).toBe(
      '/api/admin/reports?page=3&limit=20&status=pending&content_type=all'
    )
    expect(mockAuthedFetch.mock.calls[1][0]).toBe(
      '/api/admin/reports?page=2&limit=20&status=pending&content_type=all'
    )
    expect(hook.result.current.reports).toEqual([clientReport(REPORT_ID)])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 40,
      totalPages: 2,
    })
  })

  it('single-flights resolve and dismiss for the same report while the first action is pending', async () => {
    mockAuthedFetch.mockResolvedValueOnce(listAck([report(REPORT_ID)], 1, 1))
    const pending = deferred<ReturnType<typeof resolutionAck>>()
    mockAuthedFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(listAck([], 1, 0))
    const hook = renderHook(() => useReports(token(ACTOR_A, 'single-flight'), mockToast))

    await act(async () => {
      await hook.result.current.loadReports(1, 'pending', 'all')
    })

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.resolveReport(REPORT_ID, 'resolve')
      second = hook.result.current.resolveReport(REPORT_ID, 'dismiss')
    })

    await waitFor(() => expect(hook.result.current.actionLoading[REPORT_ID]).toBe(true))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      pending.resolve(resolutionAck(REPORT_ID, 'resolve'))
      await expect(first).resolves.toBe(true)
      await expect(second).resolves.toBe(false)
    })

    await waitFor(() => expect(hook.result.current.actionLoading[REPORT_ID]).toBeUndefined())
    expect(hook.result.current.reports).toEqual([])
  })

  it('keeps the same report flight and viewer-owned state across a same-actor token rotation', async () => {
    const firstToken = token(ACTOR_A, 'before-refresh')
    const refreshedToken = token(ACTOR_A, 'after-refresh')
    const pending = deferred<ReturnType<typeof resolutionAck>>()
    mockAuthedFetch
      .mockResolvedValueOnce(listAck([report(REPORT_ID)], 1, 1))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(listAck([], 1, 0))
    const hook = renderHook(({ accessToken }) => useReports(accessToken, mockToast), {
      initialProps: { accessToken: firstToken },
    })

    await act(async () => {
      await hook.result.current.loadReports(1, 'pending', 'all')
    })

    let first!: Promise<boolean>
    act(() => {
      first = hook.result.current.resolveReport(REPORT_ID, 'resolve')
    })
    await waitFor(() => expect(hook.result.current.actionLoading[REPORT_ID]).toBe(true))

    act(() => {
      hook.rerender({ accessToken: refreshedToken })
    })

    expect(hook.result.current.reports).toEqual([clientReport(REPORT_ID)])
    expect(hook.result.current.actionLoading[REPORT_ID]).toBe(true)
    await expect(hook.result.current.resolveReport(REPORT_ID, 'dismiss')).resolves.toBe(false)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      pending.resolve(resolutionAck(REPORT_ID, 'resolve'))
      await expect(first).resolves.toBe(true)
    })

    expect(hook.result.current.reports).toEqual([])
    expect(hook.result.current.actionLoading[REPORT_ID]).toBeUndefined()
  })

  it('does not let a pre-mutation load resurrect a report after a successful dismissal', async () => {
    const staleLoad = deferred<ReturnType<typeof listAck>>()
    mockAuthedFetch
      .mockResolvedValueOnce(listAck([report(REPORT_ID)], 1, 1))
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValueOnce(resolutionAck(REPORT_ID, 'dismiss'))
      .mockResolvedValueOnce(listAck([], 1, 0))
    const hook = renderHook(() => useReports(token(ACTOR_A, 'mutation-stale-load'), mockToast))

    await act(async () => {
      await hook.result.current.loadReports(1, 'pending', 'all')
    })
    expect(hook.result.current.reports).toEqual([clientReport(REPORT_ID)])

    act(() => {
      void hook.result.current.loadReports(1, 'pending', 'all')
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))

    await act(async () => {
      await expect(hook.result.current.resolveReport(REPORT_ID, 'dismiss')).resolves.toBe(true)
    })
    expect(hook.result.current.reports).toEqual([])

    await act(async () => {
      staleLoad.resolve(listAck([report(REPORT_ID)], 1, 1))
      await Promise.resolve()
    })

    expect(hook.result.current.reports).toEqual([])
  })

  it('reloads and falls back after moderating the last report on the last page', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(listAck([report(REPORT_ID)], 3, 41))
      .mockResolvedValueOnce(resolutionAck(REPORT_ID, 'dismiss'))
      .mockResolvedValueOnce(listAck([], 3, 40))
      .mockResolvedValueOnce(listAck([report(OTHER_REPORT_ID)], 2, 40))
    const hook = renderHook(() => useReports(token(ACTOR_A, 'mutation-page-fallback'), mockToast))

    await act(async () => {
      await hook.result.current.loadReports(3, 'pending', 'all')
    })
    await act(async () => {
      await expect(hook.result.current.resolveReport(REPORT_ID, 'dismiss')).resolves.toBe(true)
    })

    expect(mockAuthedFetch.mock.calls[2][0]).toBe(
      '/api/admin/reports?page=3&limit=20&status=pending&content_type=all'
    )
    expect(mockAuthedFetch.mock.calls[3][0]).toBe(
      '/api/admin/reports?page=2&limit=20&status=pending&content_type=all'
    )
    expect(hook.result.current.reports).toEqual([clientReport(OTHER_REPORT_ID)])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 40,
      totalPages: 2,
    })
  })

  it('fails closed on a mismatched resolution acknowledgement and keeps the report retryable', async () => {
    mockAuthedFetch.mockResolvedValueOnce(listAck([report(REPORT_ID)], 1, 1)).mockResolvedValueOnce(
      resolutionAck(REPORT_ID, 'resolve', {
        report: {
          id: OTHER_REPORT_ID,
          status: 'resolved',
          content_type: 'post',
          content_id: `content-${OTHER_REPORT_ID}`,
        },
      })
    )
    const hook = renderHook(() => useReports(token(ACTOR_A, 'wrong-id'), mockToast))

    await act(async () => {
      await hook.result.current.loadReports(1, 'pending', 'all')
    })

    let outcome = true
    await act(async () => {
      outcome = await hook.result.current.resolveReport(REPORT_ID, 'resolve')
    })

    expect(outcome).toBe(false)
    expect(hook.result.current.reports).toEqual([clientReport(REPORT_ID)])
    expect(mockToast).toHaveBeenCalledWith('adminOperationFailed', 'error')
    expect(hook.result.current.actionLoading[REPORT_ID]).toBeUndefined()
  })
})
