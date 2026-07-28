import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchSection } from '../SearchSection'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          claimPageSearchPlaceholder: 'Search traders',
          searchFailed: 'Search failed, please try again',
          searchFailedTitle: 'Search Failed',
          searching: 'Searching',
          retry: 'Retry',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

describe('SearchSection', () => {
  afterEach(() => {
    delete (global as { fetch?: typeof fetch }).fetch
  })

  it('shows a persistent error and retries a failed claim search', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            results: {
              traders: [
                {
                  id: 'binance:alice',
                  title: '@alice',
                  meta: { platform: 'binance', arena_score: 88 },
                },
              ],
            },
          },
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<SearchSection onSelect={jest.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('Search traders'), {
      target: { value: 'alice' },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed, please try again')
    expect(screen.queryByText('alice')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('preserves the complete trader id when a search identity contains colons', async () => {
    const onSelect = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          results: {
            traders: [
              {
                id: 'binance_futures:vault:subaccount:42',
                title: '@Colon Trader',
                meta: { platform: 'binance_futures', arena_score: 91 },
              },
            ],
          },
        },
      }),
    }) as unknown as typeof fetch

    render(<SearchSection onSelect={onSelect} />)

    fireEvent.change(screen.getByPlaceholderText('Search traders'), {
      target: { value: 'colon' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Colon Trader/ }))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'binance_futures',
        source_trader_id: 'vault:subaccount:42',
      })
    )
  })
})
