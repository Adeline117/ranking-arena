import { fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
const showToast = jest.fn()
jest.mock('@/app/components/ui/Toast', () => ({ useToast: () => ({ showToast }) }))
jest.mock('@/app/components/ui/Avatar', () => ({ __esModule: true, default: () => null }))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: () => undefined }))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }))
jest.mock('next/dynamic', () => () => () => null)

import ChatSettingsDrawer from '../ChatSettingsDrawer'

const OTHER_USER = { id: '11111111-1111-4111-8111-111111111111', handle: 'other' }
const baseSettings = {
  remark: null,
  is_muted: false,
  is_pinned: false,
  is_blocked: false,
  cleared_before: null,
}

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
}

describe('ChatSettingsDrawer block', () => {
  beforeEach(() => {
    showToast.mockReset()
    jest.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => jest.restoreAllMocks())

  it('blocks through the user-block API before mirroring the conversation flag', async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/settings') && (!init || !init.method)) {
        return jsonResponse({ settings: baseSettings })
      }
      if (url.includes('/block')) return jsonResponse({ blocked: true })
      return jsonResponse({ settings: { ...baseSettings, is_blocked: true } })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId="conv-1"
        otherUser={OTHER_USER}
        accessToken="token"
        onSettingsChange={jest.fn()}
        onSearchOpen={jest.fn()}
        onClearHistory={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByText('blockUser'))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/conv-1/settings',
        expect.objectContaining({ method: 'PATCH' })
      )
    )
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method])
    const blockIndex = calls.findIndex(
      ([url, method]) => url === `/api/users/${OTHER_USER.id}/block` && method === 'POST'
    )
    const patchIndex = calls.findIndex(([, method]) => method === 'PATCH')
    expect(blockIndex).toBeGreaterThan(-1)
    expect(patchIndex).toBeGreaterThan(blockIndex)
  })

  it('does not flip the conversation flag when the block API fails', async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/settings') && (!init || !init.method)) {
        return jsonResponse({ settings: baseSettings })
      }
      if (url.includes('/block')) return jsonResponse({ error: 'Failed to block user' }, false)
      return jsonResponse({ settings: { ...baseSettings, is_blocked: true } })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(
      <ChatSettingsDrawer
        isOpen
        onClose={jest.fn()}
        conversationId="conv-1"
        otherUser={OTHER_USER}
        accessToken="token"
        onSettingsChange={jest.fn()}
        onSearchOpen={jest.fn()}
        onClearHistory={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByText('blockUser'))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to block user', 'error'))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })
})
