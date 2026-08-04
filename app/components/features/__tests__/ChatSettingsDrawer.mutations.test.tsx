import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: () => mockUseAuthSession() }))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/app/components/base', () => ({
  Box: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Text: ({ children, ...props }: { children?: ReactNode }) => <span {...props}>{children}</span>,
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'x-csrf': 'token' }) }))
jest.mock('@/lib/utils/profile-navigation', () => ({ getProfileUrl: () => null }))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import ChatSettingsDrawer from '../ChatSettingsDrawer'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const initialSettings = {
  remark: null,
  is_muted: false,
  is_pinned: false,
  is_blocked: false,
  cleared_before: null,
  updated_at: '2026-08-03T12:00:00.000Z',
}

const actorId = '11111111-1111-4111-8111-111111111111'
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function jwt(userId: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function setViewer(userId: string) {
  const scope = synchronizeViewerScope(true, userId)
  mockUseAuthSession.mockReturnValue({
    accessToken: jwt(userId),
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: scope.sessionGeneration,
    userId,
    viewerKey: scope.viewerKey,
  })
}

function loadAcknowledgement(settings = initialSettings, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: actorId,
    target_id: targetId,
    conversation_id: conversationId,
    settings,
    ...overrides,
  }
}

function mutationAcknowledgement(
  appliedFields: string[],
  settings: typeof initialSettings,
  overrides: Record<string, unknown> = {}
) {
  return {
    actor_id: actorId,
    target_id: targetId,
    conversation_id: conversationId,
    applied_fields: appliedFields,
    block_status: null,
    settings,
    ...overrides,
  }
}

describe('ChatSettingsDrawer mutations', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    setViewer(actorId)
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('single-flights rapid clear-history confirmations and mutations', async () => {
    const patchResponse = deferred<{
      ok: boolean
      json: () => Promise<{ settings: typeof initialSettings }>
    }>()
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') return patchResponse.promise
      return Promise.resolve({
        ok: true,
        json: async () => loadAcknowledgement(),
      })
    }) as unknown as typeof fetch
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
    const onSettingsChange = jest.fn()

    render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId={conversationId}
        otherUser={{ id: targetId, handle: 'bravo' }}
        accessToken={jwt(actorId)}
        onSettingsChange={onSettingsChange}
        onSearchOpen={jest.fn()}
      />
    )

    const clearButton = await screen.findByRole('button', { name: 'clearChatHistory' })
    act(() => {
      clearButton.click()
      clearButton.click()
    })

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ clear_history: true }) })
    )

    const clearedSettings = {
      ...initialSettings,
      cleared_before: '2026-08-03T12:00:01.000Z',
      updated_at: '2026-08-03T12:00:01.000Z',
    }
    await act(async () => {
      patchResponse.resolve({
        ok: true,
        json: async () => mutationAcknowledgement(['clear_history'], clearedSettings),
      })
      await patchResponse.promise
    })

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledTimes(1))
    expect(mockShowToast).toHaveBeenCalledWith('chatHistoryCleared', 'success')
  })

  it('keeps a dangerous intent bound to the resource captured before confirmation', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => loadAcknowledgement(),
    }) as unknown as typeof fetch
    const props = {
      onClose: jest.fn(),
      conversationId,
      otherUser: { id: targetId, handle: 'bravo' },
      accessToken: jwt(actorId),
      onSettingsChange: jest.fn(),
      onSearchOpen: jest.fn(),
    }
    const view = render(<ChatSettingsDrawer {...props} isOpen />)
    const blockButton = await screen.findByRole('button', { name: 'blockUser' })
    jest.spyOn(window, 'confirm').mockImplementation(() => {
      view.rerender(<ChatSettingsDrawer {...props} isOpen={false} />)
      return true
    })

    act(() => blockButton.click())
    await act(async () => Promise.resolve())

    const patches = (global.fetch as jest.Mock).mock.calls.filter(
      ([, init]) => init?.method === 'PATCH'
    )
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual([
      `/api/chat/${conversationId}/settings`,
      expect.objectContaining({ body: JSON.stringify({ is_blocked: true }) }),
    ])
    expect(props.onSettingsChange).not.toHaveBeenCalled()
  })

  it('preserves last-good settings on a failed reload and allows a scoped retry', async () => {
    let loadCount = 0
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new Error('unexpected mutation')
      loadCount += 1
      if (loadCount === 1) {
        return { ok: true, json: async () => loadAcknowledgement(initialSettings) }
      }
      if (loadCount === 2) {
        return { ok: false, json: async () => ({ error: 'temporary' }) }
      }
      return {
        ok: true,
        json: async () => loadAcknowledgement({ ...initialSettings, remark: 'Recovered' }),
      }
    }) as unknown as typeof fetch

    const props = {
      onClose: jest.fn(),
      conversationId,
      otherUser: { id: targetId, handle: 'bravo' },
      accessToken: jwt(actorId),
      onSettingsChange: jest.fn(),
      onSearchOpen: jest.fn(),
    }
    const view = render(<ChatSettingsDrawer {...props} isOpen />)
    expect(await screen.findByText('bravo')).toBeInTheDocument()

    view.rerender(<ChatSettingsDrawer {...props} isOpen={false} />)
    view.rerender(<ChatSettingsDrawer {...props} isOpen />)
    expect(await screen.findByRole('alert')).toHaveTextContent('loadFailed')
    expect(screen.getByText('bravo')).toBeInTheDocument()

    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(screen.getAllByText('Recovered')).toHaveLength(2))
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('ignores a mutation acknowledgement after the drawer closes', async () => {
    const patchResponse = deferred<{
      ok: boolean
      json: () => Promise<unknown>
    }>()
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') return patchResponse.promise
      return Promise.resolve({ ok: true, json: async () => loadAcknowledgement() })
    }) as unknown as typeof fetch
    const onSettingsChange = jest.fn()
    const onClose = jest.fn()
    const view = render(
      <ChatSettingsDrawer
        isOpen
        onClose={onClose}
        conversationId={conversationId}
        otherUser={{ id: targetId, handle: 'bravo' }}
        accessToken={jwt(actorId)}
        onSettingsChange={onSettingsChange}
        onSearchOpen={jest.fn()}
      />
    )

    const muteButton = await screen.findByRole('button', { name: 'doNotDisturb' })
    act(() => muteButton.click())
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    act(() => screen.getByLabelText('Close settings').click())
    view.rerender(
      <ChatSettingsDrawer
        isOpen={false}
        onClose={onClose}
        conversationId={conversationId}
        otherUser={{ id: targetId, handle: 'bravo' }}
        accessToken={jwt(actorId)}
        onSettingsChange={onSettingsChange}
        onSearchOpen={jest.fn()}
      />
    )

    await act(async () => {
      patchResponse.resolve({
        ok: true,
        json: async () =>
          mutationAcknowledgement(['is_muted'], { ...initialSettings, is_muted: true }),
      })
      await patchResponse.promise
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSettingsChange).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('does not adopt a late load from a previous conversation', async () => {
    const oldLoad = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    const nextConversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const nextTargetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          loadAcknowledgement(
            { ...initialSettings, remark: 'Fresh B' },
            { conversation_id: nextConversationId, target_id: nextTargetId }
          ),
      }) as unknown as typeof fetch

    const view = render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId={conversationId}
        otherUser={{ id: targetId, handle: 'bravo' }}
        accessToken={jwt(actorId)}
        onSettingsChange={jest.fn()}
        onSearchOpen={jest.fn()}
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    view.rerender(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId={nextConversationId}
        otherUser={{ id: nextTargetId, handle: 'charlie' }}
        accessToken={jwt(actorId)}
        onSettingsChange={jest.fn()}
        onSearchOpen={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getAllByText('Fresh B')).toHaveLength(2))

    await act(async () => {
      oldLoad.resolve({
        ok: true,
        json: async () => loadAcknowledgement({ ...initialSettings, remark: 'Stale A' }),
      })
      await oldLoad.promise
    })
    expect(screen.queryByText('Stale A')).not.toBeInTheDocument()
    expect(screen.getAllByText('Fresh B')).toHaveLength(2)
  })

  it('hides the previous viewer last-good state during an account replacement', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => loadAcknowledgement({ ...initialSettings, remark: 'Viewer A only' }),
    }) as unknown as typeof fetch
    const props = {
      isOpen: true,
      onClose: jest.fn(),
      conversationId,
      otherUser: { id: targetId, handle: 'bravo' },
      onSettingsChange: jest.fn(),
      onSearchOpen: jest.fn(),
    }
    const view = render(<ChatSettingsDrawer {...props} accessToken={jwt(actorId)} />)
    await waitFor(() => expect(screen.getAllByText('Viewer A only')).toHaveLength(2))

    const viewerB = '44444444-4444-4444-8444-444444444444'
    setViewer(viewerB)
    view.rerender(<ChatSettingsDrawer {...props} accessToken={jwt(viewerB)} />)

    expect(screen.queryByText('Viewer A only')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'retry' })).toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a successful HTTP response bound to another actor or desired state', async () => {
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () =>
            mutationAcknowledgement(
              ['is_pinned'],
              { ...initialSettings, is_pinned: false },
              { actor_id: '33333333-3333-4333-8333-333333333333' }
            ),
        })
      }
      return Promise.resolve({ ok: true, json: async () => loadAcknowledgement() })
    }) as unknown as typeof fetch
    const onSettingsChange = jest.fn()
    render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId={conversationId}
        otherUser={{ id: targetId, handle: 'bravo' }}
        accessToken={jwt(actorId)}
        onSettingsChange={onSettingsChange}
        onSearchOpen={jest.fn()}
      />
    )

    const pinButton = await screen.findByRole('button', { name: 'pinChat' })
    act(() => pinButton.click())
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('updateFailed', 'error'))
    expect(onSettingsChange).not.toHaveBeenCalled()
  })
})
