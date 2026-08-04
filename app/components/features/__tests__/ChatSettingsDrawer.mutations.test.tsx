import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockShowToast = jest.fn()

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
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

describe('ChatSettingsDrawer mutations', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
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
        json: async () => ({ settings: initialSettings }),
      })
    }) as unknown as typeof fetch
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
    const onSettingsChange = jest.fn()

    render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        otherUser={{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', handle: 'bravo' }}
        accessToken="access-token"
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
        json: async () => ({ settings: clearedSettings }),
      })
      await patchResponse.promise
    })

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledTimes(1))
    expect(mockShowToast).toHaveBeenCalledWith('chatHistoryCleared', 'success')
  })
})
