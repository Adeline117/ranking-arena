import { act, renderHook } from '@testing-library/react'
import { useMarketFeed } from '../useMarketFeed'

class MockEventSource {
  static instances: MockEventSource[] = []

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = jest.fn()

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }
}

describe('useMarketFeed terminal connection states', () => {
  const originalEventSource = global.EventSource

  beforeEach(() => {
    jest.useFakeTimers()
    MockEventSource.instances = []
    global.EventSource = MockEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    global.EventSource = originalEventSource
    jest.useRealTimers()
  })

  it('turns a hung connection into an error and lets the caller retry immediately', () => {
    const { result, unmount } = renderHook(() => useMarketFeed({ initialDelayMs: 0 }))

    act(() => {
      jest.advanceTimersByTime(0)
    })
    expect(MockEventSource.instances).toHaveLength(1)
    expect(result.current.error).toBeNull()

    act(() => {
      jest.advanceTimersByTime(15_000)
    })
    expect(result.current.connected).toBe(false)
    expect(result.current.error).toBe('connection_timeout')
    expect(MockEventSource.instances[0].close).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.retry()
    })
    expect(result.current.error).toBeNull()
    expect(MockEventSource.instances).toHaveLength(2)

    act(() => {
      MockEventSource.instances[0].onerror?.(new Event('error'))
    })
    expect(result.current.error).toBeNull()
    expect(MockEventSource.instances).toHaveLength(2)

    act(() => {
      MockEventSource.instances[1].onerror?.(new Event('error'))
    })
    expect(result.current.error).toBe('connection_failed')

    unmount()
  })
})
