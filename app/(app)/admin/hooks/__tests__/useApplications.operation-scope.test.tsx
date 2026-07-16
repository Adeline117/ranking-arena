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
const EDIT_APPLICATION_B_ID = '55555555-5555-4555-8555-555555555555'

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

function editApplication(id: string, applicantId: string, name: string) {
  return {
    id,
    group_id: GROUP_ID,
    applicant_id: applicantId,
    name,
    status: 'pending',
    created_at: '2026-07-16T00:00:00.000Z',
  }
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

  it('rejects every edit-application path when the token subject does not own the viewer', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const hook = renderHook(() => useApplications(token(ACTOR_B, 'wrong-edit-actor')))

    await act(async () => {
      await hook.result.current.loadEditApplications()
      await expect(hook.result.current.approveEditApplication(APPLICATION_ID)).resolves.toBe(false)
      await expect(
        hook.result.current.rejectEditApplication(APPLICATION_ID, 'reason')
      ).resolves.toBe(false)
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('keeps a new viewer edit list loading while an old viewer load settles', async () => {
    const scopeA = synchronizeViewerScope(true, ACTOR_A)
    const oldResponse = deferred<{
      ok: boolean
      status: number
      data: { applications: ReturnType<typeof editApplication>[] }
    }>()
    const currentResponse = deferred<{
      ok: boolean
      status: number
      data: { applications: ReturnType<typeof editApplication>[] }
    }>()
    mockAuthedFetch
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(currentResponse.promise)
    const hook = renderHook(({ accessToken }) => useApplications(accessToken), {
      initialProps: { accessToken: token(ACTOR_A, 'edit-list-a') },
    })

    let oldLoad!: Promise<void>
    act(() => {
      oldLoad = hook.result.current.loadEditApplications()
    })
    await waitFor(() => expect(hook.result.current.editApplicationsLoading).toBe(true))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    hook.rerender({ accessToken: token(ACTOR_B, 'edit-list-b') })
    expect(hook.result.current.editApplications).toEqual([])
    expect(hook.result.current.editApplicationsLoading).toBe(false)

    let currentLoad!: Promise<void>
    act(() => {
      currentLoad = hook.result.current.loadEditApplications()
    })
    await waitFor(() => expect(hook.result.current.editApplicationsLoading).toBe(true))
    expect(mockAuthedFetch.mock.calls[0][5]).toEqual({
      expectedUserId: ACTOR_A,
      expectedSessionGeneration: scopeA.sessionGeneration,
    })
    expect(mockAuthedFetch.mock.calls[1][5]).toEqual({
      expectedUserId: ACTOR_B,
      expectedSessionGeneration: scopeB.sessionGeneration,
    })

    await act(async () => {
      oldResponse.resolve({
        ok: true,
        status: 200,
        data: { applications: [editApplication(APPLICATION_ID, ACTOR_A, 'old viewer edit')] },
      })
      await oldLoad
    })
    expect(hook.result.current.editApplications).toEqual([])
    expect(hook.result.current.editApplicationsLoading).toBe(true)

    await act(async () => {
      currentResponse.resolve({
        ok: true,
        status: 200,
        data: {
          applications: [editApplication(EDIT_APPLICATION_B_ID, ACTOR_B, 'current viewer edit')],
        },
      })
      await currentLoad
    })
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([
      EDIT_APPLICATION_B_ID,
    ])
    expect(hook.result.current.editApplicationsLoading).toBe(false)
  })

  it('refuses an edit callback captured by an older generation of the same actor', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const hook = renderHook(({ accessToken }) => useApplications(accessToken), {
      initialProps: { accessToken: token(ACTOR_A, 'old-generation') },
    })
    const staleLoad = hook.result.current.loadEditApplications
    const staleApprove = hook.result.current.approveEditApplication

    const transition = beginViewerTransition(ACTOR_A)
    const currentScope = commitViewerTransition(transition, ACTOR_A)
    expect(currentScope).not.toBeNull()

    await act(async () => {
      await staleLoad()
      await expect(staleApprove(APPLICATION_ID)).resolves.toBe(false)
    })
    expect(mockAuthedFetch).not.toHaveBeenCalled()

    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: { applications: [] } })
    hook.rerender({ accessToken: token(ACTOR_A, 'current-generation') })
    await act(async () => {
      await hook.result.current.loadEditApplications()
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch.mock.calls[0][5]).toEqual({
      expectedUserId: ACTOR_A,
      expectedSessionGeneration: currentScope?.sessionGeneration,
    })
  })

  it('does not let an old viewer edit action mutate, toast, succeed, or clear the new action', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const oldActionResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    const oldErrorResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    const newActionResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    mockAuthedFetch
      .mockReturnValueOnce(oldActionResponse.promise)
      .mockReturnValueOnce(oldErrorResponse.promise)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          applications: [
            editApplication(APPLICATION_ID, ACTOR_B, 'viewer B edit'),
            editApplication(EDIT_APPLICATION_B_ID, ACTOR_B, 'viewer B second edit'),
          ],
        },
      })
      .mockReturnValueOnce(newActionResponse.promise)
    const showToast = jest.fn()
    const hook = renderHook(({ accessToken }) => useApplications(accessToken, showToast), {
      initialProps: { accessToken: token(ACTOR_A, 'edit-action-a') },
    })

    let oldAction!: Promise<boolean>
    let oldErrorAction!: Promise<boolean>
    act(() => {
      oldAction = hook.result.current.approveEditApplication(APPLICATION_ID)
      oldErrorAction = hook.result.current.rejectEditApplication(
        EDIT_APPLICATION_B_ID,
        'old viewer reason'
      )
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    hook.rerender({ accessToken: token(ACTOR_B, 'edit-action-b') })
    await act(async () => {
      await hook.result.current.loadEditApplications()
    })
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([
      APPLICATION_ID,
      EDIT_APPLICATION_B_ID,
    ])

    let newAction!: Promise<boolean>
    act(() => {
      newAction = hook.result.current.rejectEditApplication(APPLICATION_ID, 'viewer B reason')
    })
    await waitFor(() =>
      expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(true)
    )
    expect(mockAuthedFetch.mock.calls[3][3]).toEqual({ reason: 'viewer B reason' })
    expect(mockAuthedFetch.mock.calls[3][5]).toEqual({
      expectedUserId: ACTOR_B,
      expectedSessionGeneration: scopeB.sessionGeneration,
    })

    await act(async () => {
      oldActionResponse.resolve({ ok: true, status: 200, data: { success: true } })
      await expect(oldAction).resolves.toBe(false)
    })
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([
      APPLICATION_ID,
      EDIT_APPLICATION_B_ID,
    ])
    expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(true)
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => {
      oldErrorResponse.resolve({
        ok: false,
        status: 409,
        data: { error: 'old viewer must stay silent' },
      })
      await expect(oldErrorAction).resolves.toBe(false)
    })
    expect(showToast).not.toHaveBeenCalled()
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([
      APPLICATION_ID,
      EDIT_APPLICATION_B_ID,
    ])
    expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(true)

    await act(async () => {
      newActionResponse.resolve({ ok: false, status: 409, data: { error: 'viewer B failed' } })
      await expect(newAction).resolves.toBe(false)
    })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('viewer B failed', 'error')
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([
      APPLICATION_ID,
      EDIT_APPLICATION_B_ID,
    ])
    expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(false)
  })

  it('uses request ownership so a replaced edit action cannot clear or commit over the latest one', async () => {
    const scope = synchronizeViewerScope(true, ACTOR_A)
    const firstResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    const secondResponse = deferred<{ ok: boolean; status: number; data: unknown }>()
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { applications: [editApplication(APPLICATION_ID, ACTOR_A, 'same viewer edit')] },
      })
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    const showToast = jest.fn()
    const hook = renderHook(() => useApplications(token(ACTOR_A, 'same-edit-viewer'), showToast))

    await act(async () => {
      await hook.result.current.loadEditApplications()
    })
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([APPLICATION_ID])

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.approveEditApplication(APPLICATION_ID)
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    act(() => {
      second = hook.result.current.rejectEditApplication(APPLICATION_ID, 'latest intent')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(3))

    await act(async () => {
      firstResponse.resolve({ ok: true, status: 200, data: { success: true } })
      await expect(first).resolves.toBe(false)
    })
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([APPLICATION_ID])
    expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(true)
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => {
      secondResponse.resolve({ ok: false, status: 409, data: { error: 'latest intent failed' } })
      await expect(second).resolves.toBe(false)
    })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('latest intent failed', 'error')
    expect(hook.result.current.editApplications.map(({ id }) => id)).toEqual([APPLICATION_ID])
    expect(hook.result.current.actionLoading[`edit_${APPLICATION_ID}`]).toBe(false)
    expect(mockAuthedFetch.mock.calls[2][5]).toEqual({
      expectedUserId: ACTOR_A,
      expectedSessionGeneration: scope.sessionGeneration,
    })
  })
})
