import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MentionAutocomplete } from './MentionAutocomplete'

const originalFetch = global.fetch

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

describe('MentionAutocomplete', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        users: [
          { id: '1', handle: 'alice', avatar_url: null },
          { id: '2', handle: 'alina', avatar_url: null },
        ],
      })
    )
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('renders authenticated results and replaces the exact active token', async () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(
      <MentionAutocomplete
        text="Hi @ali"
        cursorPosition={7}
        onSelect={onSelect}
        onClose={onClose}
        accessToken="token"
      />
    )

    expect(screen.getByRole('listbox', { name: 'Mention suggestions' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    const alice = await screen.findByRole('option', { name: '@alice' })
    expect(global.fetch).toHaveBeenCalledWith('/api/users/search?q=ali&limit=5', {
      headers: { Authorization: 'Bearer token' },
      signal: expect.any(AbortSignal),
    })

    fireEvent.click(alice)
    expect(onSelect).toHaveBeenCalledWith('alice', 3, 7)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('supports arrow, enter, and escape keyboard interaction', async () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(
      <>
        <textarea aria-label="Post content" defaultValue="Hi @ali" />
        <MentionAutocomplete
          text="Hi @ali"
          cursorPosition={7}
          onSelect={onSelect}
          onClose={onClose}
          accessToken="token"
        />
      </>
    )

    await screen.findByRole('option', { name: '@alina' })
    screen.getByRole('textbox', { name: 'Post content' }).focus()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: '@alina' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('alina', 3, 7)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not hijack typing after focus leaves the composer', async () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(
      <>
        <textarea aria-label="Post content" defaultValue="Hi @ali" />
        <input aria-label="Post title" />
        <MentionAutocomplete
          text="Hi @ali"
          cursorPosition={7}
          onSelect={onSelect}
          onClose={onClose}
          accessToken="token"
        />
      </>
    )

    await screen.findByRole('option', { name: '@alice' })
    screen.getByRole('textbox', { name: 'Post title' }).focus()
    fireEvent.keyDown(document, { key: 'Enter' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('fails closed on malformed or unsuccessful search responses', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ users: [{ id: 1, handle: 'unsafe' }] }))
      .mockResolvedValueOnce(response({ error: 'failed' }, false, 500))

    const { rerender } = render(
      <MentionAutocomplete
        text="Hi @bad"
        cursorPosition={7}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        accessToken="token"
      />
    )
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

    rerender(
      <MentionAutocomplete
        text="Hi @fail"
        cursorPosition={8}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        accessToken="token"
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })
})
