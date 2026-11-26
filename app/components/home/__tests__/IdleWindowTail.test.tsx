import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import IdleWindowTail from '../IdleWindowTail'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          idleWindowTailHidden: '{count} more accounts with no trading this period',
          idleWindowShow: 'Show',
          idleWindowHide: 'Hide',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

function mockCount(body: unknown, ok = true) {
  const fetchMock = jest.fn(async () => ({ ok, json: async () => body }))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('IdleWindowTail', () => {
  it('says how many idle accounts are hidden and asks for the same board scope', async () => {
    const fetchMock = mockCount({ success: true, data: { count: 5016 } })
    const onChange = jest.fn()
    render(
      <IdleWindowTail timeRange="7D" category="futures" expanded={false} onChange={onChange} />
    )

    expect(
      await screen.findByText('5,016 more accounts with no trading this period')
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/traders/idle-count?timeRange=7D&category=futures',
      expect.anything()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('scopes to the exchange instead of the category on a single-exchange board', async () => {
    const fetchMock = mockCount({ success: true, data: { count: 3 } })
    render(
      <IdleWindowTail
        timeRange="90D"
        exchange="bybit"
        category="futures"
        expanded={false}
        onChange={jest.fn()}
      />
    )
    await screen.findByText('3 more accounts with no trading this period')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/traders/idle-count?timeRange=90D&exchange=bybit',
      expect.anything()
    )
  })

  it.each([
    ['there are none', { success: true, data: { count: 0 } }, true],
    ['the count is unknown', { success: true, data: { count: null } }, true],
    ['the request fails', null, false],
  ])('renders nothing when %s', async (_label, body, ok) => {
    const fetchMock = mockCount(body, ok)
    const { container } = render(
      <IdleWindowTail timeRange="90D" category="all" expanded={false} onChange={jest.fn()} />
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(container).not.toHaveTextContent('0 more')
  })

  it('offers to hide the tail again while it is expanded, whatever the count', async () => {
    mockCount({ success: true, data: { count: null } })
    const onChange = jest.fn()
    render(<IdleWindowTail timeRange="90D" category="all" expanded onChange={onChange} />)
    const button = await screen.findByRole('button', { name: 'Hide' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(button)
    expect(onChange).toHaveBeenCalledWith(false)
  })
})
