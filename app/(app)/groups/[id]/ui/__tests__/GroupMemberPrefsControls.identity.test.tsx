import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
let mockAuthState: {
  accessToken: string | null
  authChecked: boolean
  userId: string | null
  viewerKey: string
  sessionGeneration: number
} = {
  accessToken: 'token-a',
  authChecked: true,
  userId: '11111111-1111-4111-8111-111111111111',
  viewerKey: 'user:11111111-1111-4111-8111-111111111111',
  sessionGeneration: 1,
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'X-CSRF': 'test' }) }))
jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}))

import GroupMemberPrefsControls from '../GroupMemberPrefsControls'

type FetchResponse = {
  status: number
  json: () => Promise<unknown>
}

const fetchMock = jest.fn<Promise<FetchResponse>, Parameters<typeof fetch>>()
const viewerA = '11111111-1111-4111-8111-111111111111'
const viewerB = '33333333-3333-4333-8333-333333333333'
const groupId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-08-03T12:00:00.000Z'

function response(status: number, body: unknown): FetchResponse {
  return { status, json: async () => body }
}

function snapshot(viewerId = viewerA, extra: Record<string, unknown> = {}) {
  return response(200, {
    success: true,
    data: {
      preferences: {
        viewer_id: viewerId,
        group_id: groupId,
        self_notify_muted: false,
        pinned: true,
      },
    },
    meta: { timestamp },
    ...extra,
  })
}

function mutation(viewerId = viewerA, extra: Record<string, unknown> = {}) {
  return response(200, {
    success: true,
    data: {
      preferences: {
        viewer_id: viewerId,
        group_id: groupId,
        self_notify_muted: true,
        pinned: true,
      },
      mutation: { field: 'self_notify_muted', value: true },
    },
    meta: { timestamp },
    ...extra,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('GroupMemberPrefsControls identity-bound operations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthState = {
      accessToken: 'token-a',
      authChecked: true,
      userId: viewerA,
      viewerKey: 'user:11111111-1111-4111-8111-111111111111',
      sessionGeneration: 1,
    }
    globalThis.fetch = fetchMock as typeof fetch
  })

  it('renders exact preferences with 44px controls', async () => {
    fetchMock.mockResolvedValueOnce(snapshot())
    render(<GroupMemberPrefsControls groupId={groupId} />)

    const mute = await screen.findByRole('button', { name: 'groupPrefs_mute' })
    const unpin = screen.getByRole('button', { name: 'groupPrefs_unpin' })
    expect(mute).toHaveStyle({ width: '44px', height: '44px' })
    expect(unpin).toHaveStyle({ width: '44px', height: '44px' })
    expect(mute).toHaveAttribute('aria-pressed', 'false')
    expect(unpin).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows an explicit retry for an expanded 200 instead of false preference state', async () => {
    fetchMock.mockResolvedValueOnce(snapshot(viewerA, { unexpected: true }))
    render(<GroupMemberPrefsControls groupId={groupId} />)

    const retry = await screen.findByRole('button', { name: 'loadFailed · retry' })
    expect(screen.queryByRole('button', { name: 'groupPrefs_mute' })).not.toBeInTheDocument()

    fetchMock.mockResolvedValueOnce(snapshot())
    fireEvent.click(retry)
    expect(await screen.findByRole('button', { name: 'groupPrefs_mute' })).toBeInTheDocument()
  })

  it('coalesces same-frame clicks and accepts only the requested desired-state receipt', async () => {
    fetchMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(mutation())
    render(<GroupMemberPrefsControls groupId={groupId} />)
    const mute = await screen.findByRole('button', { name: 'groupPrefs_mute' })

    fireEvent.click(mute)
    fireEvent.click(mute)

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('groupPrefs_mutedToast', 'success')
    )
    const patchCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-a' })
  })

  it('rolls back an optimistic toggle when a 200 receipt is identity-mismatched', async () => {
    fetchMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(mutation(viewerB))
    render(<GroupMemberPrefsControls groupId={groupId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'groupPrefs_mute' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('groupPrefs_updateFailed', 'error')
    )
    expect(screen.getByRole('button', { name: 'groupPrefs_mute' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockShowToast).not.toHaveBeenCalledWith('groupPrefs_mutedToast', 'success')
  })

  it('drops an old viewer response after the canonical account changes', async () => {
    const oldRequest = deferred<FetchResponse>()
    fetchMock
      .mockImplementationOnce(() => oldRequest.promise)
      .mockResolvedValueOnce(snapshot(viewerB))
    const view = render(<GroupMemberPrefsControls groupId={groupId} />)

    mockAuthState = {
      accessToken: 'token-b',
      authChecked: true,
      userId: viewerB,
      viewerKey: 'user:33333333-3333-4333-8333-333333333333',
      sessionGeneration: 2,
    }
    view.rerender(<GroupMemberPrefsControls groupId={groupId} />)
    expect(await screen.findByRole('button', { name: 'groupPrefs_mute' })).toBeInTheDocument()

    oldRequest.resolve(snapshot())
    await act(async () => {
      await oldRequest.promise
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'groupPrefs_mute' })).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('loadFailed', 'error')
  })
})
