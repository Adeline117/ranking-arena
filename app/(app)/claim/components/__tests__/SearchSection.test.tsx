import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchSection } from '../SearchSection'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function successfulResponse(
  traders: Array<{
    id: string
    title: string
    avatar?: string | null
    meta?: { platform?: string; arena_score?: number; roi?: number }
  }>
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { results: { traders } } }),
  } as Response
}

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
          searchTradersLabel: 'Search traders by name',
          noResultsForQuery: 'No results found for "{query}"',
          resultsCount: 'results',
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

  it('keeps the newest results when an older request resolves last', async () => {
    const olderRequest = deferred<Response>()
    const newerRequest = deferred<Response>()
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise)
    global.fetch = fetchMock as unknown as typeof fetch

    render(<SearchSection onSelect={jest.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search traders by name' })
    fireEvent.change(input, { target: { value: 'alice' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const olderSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal
    fireEvent.change(input, { target: { value: 'bob' } })
    expect(olderSignal?.aborted).toBe(true)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      newerRequest.resolve(
        successfulResponse([
          { id: 'bybit:bob', title: '@bob', meta: { platform: 'bybit', arena_score: 90 } },
        ])
      )
    })
    expect(await screen.findByText('bob')).toBeInTheDocument()

    await act(async () => {
      olderRequest.resolve(
        successfulResponse([
          {
            id: 'binance:alice',
            title: '@alice',
            meta: { platform: 'binance', arena_score: 80 },
          },
        ])
      )
    })

    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.queryByText('alice')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a stale rejection after the current request succeeds', async () => {
    const olderRequest = deferred<Response>()
    const newerRequest = deferred<Response>()
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise)
    global.fetch = fetchMock as unknown as typeof fetch

    render(<SearchSection onSelect={jest.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search traders by name' })
    fireEvent.change(input, { target: { value: 'older' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'current' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      newerRequest.resolve(
        successfulResponse([{ id: 'okx:current', title: '@current', meta: { platform: 'okx' } }])
      )
    })
    expect(await screen.findByText('current')).toBeInTheDocument()

    await act(async () => {
      olderRequest.reject(new Error('late network failure'))
    })

    expect(screen.getByText('current')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not let a stale finally clear the current loading state', async () => {
    const olderRequest = deferred<Response>()
    const currentRequest = deferred<Response>()
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    global.fetch = fetchMock as unknown as typeof fetch

    render(<SearchSection onSelect={jest.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search traders by name' })
    fireEvent.change(input, { target: { value: 'older' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'current' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      olderRequest.resolve(
        successfulResponse([
          { id: 'binance:older', title: '@older', meta: { platform: 'binance' } },
        ])
      )
    })

    expect(input).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Searching', { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByText('older')).not.toBeInTheDocument()

    await act(async () => {
      currentRequest.resolve(successfulResponse([]))
    })
    expect(
      await screen.findByText('No results found for "current"', { selector: 'p' })
    ).toBeInTheDocument()
  })

  it('aborts its active request when it unmounts', async () => {
    const activeRequest = deferred<Response>()
    const fetchMock = jest.fn().mockReturnValue(activeRequest.promise)
    global.fetch = fetchMock as unknown as typeof fetch

    const { unmount } = render(<SearchSection onSelect={jest.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search traders by name' }), {
      target: { value: 'alice' },
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('labels the input and shows an empty state only for the latest valid search', async () => {
    const fetchMock = jest.fn().mockResolvedValue(successfulResponse([]))
    global.fetch = fetchMock as unknown as typeof fetch

    render(<SearchSection onSelect={jest.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search traders by name' })
    const status = screen.getByRole('status')
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-controls')
    expect(input).not.toHaveAttribute('aria-describedby')

    fireEvent.change(input, { target: { value: ' a ' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'nobody' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByText('No results found for "nobody"', { selector: 'p' })
    ).toBeInTheDocument()
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('No results found for "nobody"')
    expect(input).toHaveAttribute('aria-describedby', status.id)
    expect(input).toHaveAttribute('aria-controls')
    expect(document.getElementById(input.getAttribute('aria-controls') || '')).toBeInTheDocument()
    expect(screen.queryByText('Searching')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
