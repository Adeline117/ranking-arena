import { act, render, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { PushViewerSync, SET_ACTIVE_PUSH_VIEWER } from '../PushViewerSync'

const mockUseAuthSession = useAuthSession as jest.Mock

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string | null, sessionGeneration: number, tokenUserId = userId) {
  return {
    accessToken: tokenUserId ? jwt(tokenUserId) : null,
    authChecked: userId === null,
    loading: userId !== null,
    sessionGeneration,
    userId: null as string | null,
    viewerKey: userId === null ? ('anon' as const) : ('pending' as const),
  }
}

function verifiedAuth(userId: string, sessionGeneration: number, tokenUserId = userId) {
  return {
    ...authFor(userId, sessionGeneration, tokenUserId),
    authChecked: true,
    loading: false,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('PushViewerSync', () => {
  const postMessage = jest.fn()
  let currentAuth = verifiedAuth('user-a', 1)

  beforeEach(() => {
    jest.clearAllMocks()
    currentAuth = verifiedAuth('user-a', 1)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ active: { postMessage } }), controller: null },
    })
  })

  it('publishes the verified canonical viewer', async () => {
    render(<PushViewerSync />)

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: SET_ACTIVE_PUSH_VIEWER,
        userId: 'user-a',
      })
    )
  })

  it('publishes null during an identity transition and for mismatched tokens', async () => {
    const view = render(<PushViewerSync />)
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-a' }))
    )

    currentAuth = authFor('user-b', 2)
    view.rerender(<PushViewerSync />)
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null }))
    )

    currentAuth = verifiedAuth('user-b', 2, 'user-a')
    view.rerender(<PushViewerSync />)
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null }))
    )
  })

  it('does not publish a delayed A snapshot after B supersedes it', async () => {
    const ready = deferred<{ active: { postMessage: typeof postMessage } }>()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: ready.promise, controller: null },
    })
    const view = render(<PushViewerSync />)

    currentAuth = verifiedAuth('user-b', 2)
    view.rerender(<PushViewerSync />)
    await act(async () => ready.resolve({ active: { postMessage } }))

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: SET_ACTIVE_PUSH_VIEWER, userId: 'user-b' })
  })
})
