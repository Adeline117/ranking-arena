import { act, renderHook, waitFor } from '@testing-library/react'
import { useGroupPostLinkPreview } from './useLinkPreview'

interface MockResponse {
  ok: boolean
  json: () => Promise<unknown>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response(data: unknown): MockResponse {
  return {
    ok: true,
    json: async () => data,
  }
}

function requestSignal(call: number): AbortSignal {
  const init = (global.fetch as jest.Mock).mock.calls[call]?.[1] as RequestInit | undefined
  return init?.signal as AbortSignal
}

describe('useGroupPostLinkPreview', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('keeps the new URL result when an aborted old request resolves afterwards', async () => {
    const oldRequest = deferred<MockResponse>()
    const newRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)

    const hook = renderHook(({ content }) => useGroupPostLinkPreview(content), {
      initialProps: { content: 'old https://a.example/post' },
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const oldSignal = requestSignal(0)

    hook.rerender({ content: 'new https://b.example/post' })

    expect(oldSignal.aborted).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      newRequest.resolve(response({ title: 'B', description: 'new', image: '/b.png' }))
      await newRequest.promise
    })

    await waitFor(() => expect(hook.result.current.linkPreview?.title).toBe('B'))
    expect(hook.result.current.linkPreviewLoading).toBe(false)

    await act(async () => {
      oldRequest.resolve(response({ title: 'A', description: 'old', image: '/a.png' }))
      await oldRequest.promise
    })

    expect(hook.result.current.linkPreview).toEqual({
      url: 'https://b.example/post',
      title: 'B',
      description: 'new',
      image: '/b.png',
    })
    expect(hook.result.current.linkPreviewLoading).toBe(false)
  })

  it('ignores an old rejection and finally while the current request is loading', async () => {
    const oldRequest = deferred<MockResponse>()
    const newRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)

    const hook = renderHook(({ content }) => useGroupPostLinkPreview(content), {
      initialProps: { content: 'https://a.example' },
    })
    hook.rerender({ content: 'https://b.example' })

    await act(async () => {
      oldRequest.reject(new Error('late A failure'))
      await oldRequest.promise.catch(() => undefined)
    })

    expect(hook.result.current.linkPreview).toBeNull()
    expect(hook.result.current.linkPreviewLoading).toBe(true)

    await act(async () => {
      newRequest.resolve(response({ title: 'B', description: '', image: '' }))
      await newRequest.promise
    })

    await waitFor(() => expect(hook.result.current.linkPreviewLoading).toBe(false))
    expect(hook.result.current.linkPreview?.title).toBe('B')
  })

  it('does not render a card for truthy non-string preview text', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      response({ title: { unexpected: true }, description: ['not text'], image: '/bad.png' })
    )

    const hook = renderHook(() => useGroupPostLinkPreview('https://a.example'))

    await waitFor(() => expect(hook.result.current.linkPreviewLoading).toBe(false))
    expect(hook.result.current.linkPreview).toBeNull()
  })

  it('does not abort or refetch when ordinary text changes around the same first URL', () => {
    const activeRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock).mockReturnValue(activeRequest.promise)

    const hook = renderHook(({ content }) => useGroupPostLinkPreview(content), {
      initialProps: { content: 'https://same.example start' },
    })
    const signal = requestSignal(0)

    hook.rerender({ content: 'more text https://same.example start' })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(false)
  })

  it('aborts and resets immediately when the content no longer has a URL', async () => {
    const activeRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock).mockReturnValue(activeRequest.promise)

    const hook = renderHook(({ content }) => useGroupPostLinkPreview(content), {
      initialProps: { content: 'https://a.example' },
    })
    const signal = requestSignal(0)

    hook.rerender({ content: 'no link now' })

    expect(signal.aborted).toBe(true)
    expect(hook.result.current.linkPreview).toBeNull()
    expect(hook.result.current.linkPreviewLoading).toBe(false)
    expect(hook.result.current.linkPreviewUrlRef.current).toBeNull()
  })

  it('aborts the active request on unmount', () => {
    const activeRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock).mockReturnValue(activeRequest.promise)

    const hook = renderHook(() => useGroupPostLinkPreview('https://a.example'))
    const signal = requestSignal(0)

    hook.unmount()

    expect(signal.aborted).toBe(true)
  })

  it('leaves an active replacement request after StrictMode replays the effect', () => {
    const firstRequest = deferred<MockResponse>()
    const secondRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    renderHook(() => useGroupPostLinkPreview('https://strict.example'), {
      reactStrictMode: true,
    })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(requestSignal(0).aborted).toBe(true)
    expect(requestSignal(1).aborted).toBe(false)
  })

  it('keeps a dismissed URL closed until the detected URL changes', async () => {
    const firstRequest = deferred<MockResponse>()
    const secondRequest = deferred<MockResponse>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    const hook = renderHook(({ content }) => useGroupPostLinkPreview(content), {
      initialProps: { content: 'https://a.example' },
    })

    await act(async () => {
      firstRequest.resolve(response({ title: 'A', description: '', image: '' }))
      await firstRequest.promise
    })
    await waitFor(() => expect(hook.result.current.linkPreview?.title).toBe('A'))

    act(() => hook.result.current.setLinkPreview(null))
    hook.rerender({ content: 'typed more https://a.example' })

    expect(hook.result.current.linkPreview).toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)

    hook.rerender({ content: 'https://b.example' })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(requestSignal(1).aborted).toBe(false)
  })
})
