import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockGetSession = jest.fn()
const mockShowToast = jest.fn()
const mockOnSaved = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
      React.createElement('span', props, children),
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      React.createElement('button', props, children),
  }
})

import VerifiedTraderEditor from '../VerifiedTraderEditor'

describe('VerifiedTraderEditor identity contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
  })

  it('sends the exact trader identity with profile changes', async () => {
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={{ display_name: 'Before' }}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'After' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      trader_id: 'account-42',
      source: 'binance_futures',
      display_name: 'After',
    })
    expect(mockOnSaved).toHaveBeenCalledTimes(1)
  })
})
