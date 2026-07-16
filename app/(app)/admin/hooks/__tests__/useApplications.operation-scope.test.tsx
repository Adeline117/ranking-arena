import { webcrypto } from 'node:crypto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useApplications } from '../useApplications'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { __resetGroupApplicationOperationsForTests } from '@/lib/groups/application-operation'

const mockAuthedFetch = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
  getCsrfHeaders: () => ({}),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'

function token(subject: string, marker: string): string {
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

function operationBody(callIndex = 0): { operation_id: string; reason?: string | null } {
  return mockAuthedFetch.mock.calls[callIndex][3]
}

describe('useApplications operation/viewer scope', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    __resetGroupApplicationOperationsForTests()
    window.localStorage.clear()
  })

  it('rejects a token whose subject does not own the current viewer scope', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const hook = renderHook(() => useApplications(token(ACTOR_B, 'wrong')))

    await act(async () => {
      expect(await hook.result.current.approveApplication(APPLICATION_ID)).toBe(false)
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('retains one operation across a non-exact response and same-user token refresh', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 500, data: null })
    const showToast = jest.fn()
    const hook = renderHook(({ accessToken }) => useApplications(accessToken, showToast), {
      initialProps: { accessToken: token(ACTOR_A, 'first') },
    })

    await act(async () => {
      await hook.result.current.approveApplication(APPLICATION_ID)
    })
    hook.rerender({ accessToken: token(ACTOR_A, 'refreshed') })
    await act(async () => {
      await hook.result.current.approveApplication(APPLICATION_ID)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(operationBody(1).operation_id).toBe(operationBody(0).operation_id)
    expect(mockAuthedFetch.mock.calls[1][5]).toEqual(
      expect.objectContaining({ expectedUserId: ACTOR_A })
    )
  })

  it('single-flights two same-operation consumers and resolves both as success', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const response = deferred<{
      ok: boolean
      status: number
      data: unknown
    }>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const hook = renderHook(() => useApplications(token(ACTOR_A, 'same')))

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.approveApplication(APPLICATION_ID)
      second = hook.result.current.approveApplication(APPLICATION_ID)
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    const operationId = operationBody().operation_id

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          message: 'approved',
          operation_id: operationId,
          group: { id: GROUP_ID },
        },
      })
      await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    })

    await waitFor(() => expect(hook.result.current.actionLoading[APPLICATION_ID]).toBe(false))
  })

  it('masks old viewer state synchronously and ignores its late acknowledgement', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const response = deferred<{ ok: boolean; status: number; data: unknown }>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const showToast = jest.fn()
    const hook = renderHook(({ accessToken }) => useApplications(accessToken, showToast), {
      initialProps: { accessToken: token(ACTOR_A, 'a') },
    })

    let pending!: Promise<boolean>
    act(() => {
      pending = hook.result.current.approveApplication(APPLICATION_ID)
    })
    await waitFor(() => expect(hook.result.current.actionLoading[APPLICATION_ID]).toBe(true))
    const oldOperationId = operationBody().operation_id

    act(() => {
      synchronizeViewerScope(true, ACTOR_B)
      hook.rerender({ accessToken: token(ACTOR_B, 'b') })
    })
    expect(hook.result.current.actionLoading[APPLICATION_ID]).not.toBe(true)

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          message: 'approved',
          operation_id: oldOperationId,
          group: { id: GROUP_ID },
        },
      })
      await expect(pending).resolves.toBe(false)
    })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('masks an old request across a new generation for the same actor', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const response = deferred<{ ok: boolean; status: number; data: unknown }>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const hook = renderHook(({ accessToken }) => useApplications(accessToken), {
      initialProps: { accessToken: token(ACTOR_A, 'generation-four') },
    })

    let pending!: Promise<boolean>
    act(() => {
      pending = hook.result.current.approveApplication(APPLICATION_ID)
    })
    await waitFor(() => expect(hook.result.current.actionLoading[APPLICATION_ID]).toBe(true))
    const oldOperationId = operationBody().operation_id

    act(() => {
      const transition = beginViewerTransition(ACTOR_A)
      commitViewerTransition(transition, ACTOR_A)
      hook.rerender({ accessToken: token(ACTOR_A, 'generation-five') })
    })
    expect(hook.result.current.actionLoading[APPLICATION_ID]).not.toBe(true)

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          message: 'approved',
          operation_id: oldOperationId,
          group: { id: GROUP_ID },
        },
      })
      await expect(pending).resolves.toBe(false)
    })
  })

  it('does not publish an old viewer application list after a viewer switch', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const response = deferred<{
      ok: boolean
      status: number
      data: { applications: Array<Record<string, unknown>> }
    }>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const hook = renderHook(({ accessToken }) => useApplications(accessToken), {
      initialProps: { accessToken: token(ACTOR_A, 'list-a') },
    })

    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.loadApplications()
    })
    await waitFor(() => expect(hook.result.current.applicationsLoading).toBe(true))

    act(() => {
      synchronizeViewerScope(true, ACTOR_B)
      hook.rerender({ accessToken: token(ACTOR_B, 'list-b') })
    })
    expect(hook.result.current.applicationsLoading).toBe(false)
    expect(hook.result.current.applications).toEqual([])

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: {
          applications: [
            {
              id: APPLICATION_ID,
              applicant_id: ACTOR_A,
              name: 'Old viewer application',
              status: 'pending',
              created_at: '2026-07-16T00:00:00.000Z',
            },
          ],
        },
      })
      await pending
    })
    expect(hook.result.current.applications).toEqual([])
  })

  it('does not let replaced intent A clear intent B loading or surface A errors', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const firstResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    const secondResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    mockAuthedFetch
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    const showToast = jest.fn()
    const hook = renderHook(() => useApplications(token(ACTOR_A, 'same'), showToast))

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.rejectApplication(APPLICATION_ID, 'reason A')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    act(() => {
      second = hook.result.current.rejectApplication(APPLICATION_ID, 'reason B')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      firstResponse.resolve({ ok: false, status: 409, data: { error: 'stale A' } })
      await expect(first).resolves.toBe(false)
    })
    expect(showToast).not.toHaveBeenCalled()
    expect(hook.result.current.actionLoading[APPLICATION_ID]).toBe(true)

    const secondOperationId = operationBody(1).operation_id
    await act(async () => {
      secondResponse.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          message: 'rejected',
          operation_id: secondOperationId,
        },
      })
      await expect(second).resolves.toBe(true)
    })
    await waitFor(() => expect(hook.result.current.actionLoading[APPLICATION_ID]).toBe(false))
  })
})
