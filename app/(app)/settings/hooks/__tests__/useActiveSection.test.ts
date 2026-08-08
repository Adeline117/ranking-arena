import { act, cleanup, renderHook } from '@testing-library/react'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

import { useActiveSection } from '../useActiveSection'

class TestMutationObserver {
  static instances: TestMutationObserver[] = []

  private connected = false

  readonly observe = jest.fn(() => {
    this.connected = true
  })

  readonly disconnect = jest.fn(() => {
    this.connected = false
  })

  readonly takeRecords = jest.fn(() => [])

  constructor(private readonly callback: MutationCallback) {
    TestMutationObserver.instances.push(this)
  }

  trigger() {
    if (this.connected) {
      this.callback([], this as unknown as MutationObserver)
    }
  }
}

const nativeMutationObserver = globalThis.MutationObserver
const mountedSections: HTMLElement[] = []

function mountSection(id: string) {
  const element = document.createElement('section')
  const scrollIntoView = jest.fn()
  element.id = id
  Object.defineProperty(element, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  document.body.appendChild(element)
  mountedSections.push(element)
  return { element, scrollIntoView }
}

function latestObserver() {
  const observer = TestMutationObserver.instances.at(-1)
  if (!observer) throw new Error('Expected a settings deep-link observer')
  return observer
}

describe('useActiveSection', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: TestMutationObserver,
    })
  })

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockSearchParams = new URLSearchParams()
    TestMutationObserver.instances = []
  })

  afterEach(() => {
    cleanup()
    mountedSections.splice(0).forEach((element) => element.remove())
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  afterAll(() => {
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: nativeMutationObserver,
    })
  })

  it('restores an already-mounted deep-link target exactly once without animation', () => {
    mockSearchParams = new URLSearchParams('section=privacy')
    const { scrollIntoView } = mountSection('privacy')

    const { result } = renderHook(() => useActiveSection())

    expect(result.current.activeSection).toBe('privacy')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    expect(TestMutationObserver.instances).toHaveLength(0)
  })

  it('waits past 100ms for a cold-load target mounted at 800ms and restores it once', () => {
    mockSearchParams = new URLSearchParams('section=account')
    const { result } = renderHook(() => useActiveSection())
    const observer = latestObserver()

    expect(result.current.activeSection).toBe('account')
    act(() => {
      jest.advanceTimersByTime(100)
    })

    let target: ReturnType<typeof mountSection>
    act(() => {
      jest.advanceTimersByTime(700)
      target = mountSection('account')
      observer.trigger()
    })

    expect(target!.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(target!.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    expect(observer.disconnect).toHaveBeenCalledTimes(1)

    act(() => {
      jest.advanceTimersByTime(10_000)
      observer.trigger()
    })
    expect(target!.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('keeps user-initiated navigation smooth without a second query-sync scroll', () => {
    mockSearchParams = new URLSearchParams('source=profile')
    const { scrollIntoView } = mountSection('security')
    const { result, rerender } = renderHook(() => useActiveSection())

    act(() => {
      result.current.scrollToSection('security')
    })

    expect(mockReplace).toHaveBeenCalledWith('/settings?source=profile&section=security', {
      scroll: false,
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })

    mockSearchParams = new URLSearchParams('source=profile&section=security')
    rerender()

    expect(result.current.activeSection).toBe('security')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(TestMutationObserver.instances).toHaveLength(0)
  })

  it('disconnects the old wait when the section query changes', () => {
    mockSearchParams = new URLSearchParams('section=privacy')
    const { rerender } = renderHook(() => useActiveSection())
    const privacyObserver = latestObserver()

    mockSearchParams = new URLSearchParams('section=security')
    rerender()
    const securityObserver = latestObserver()

    expect(securityObserver).not.toBe(privacyObserver)
    expect(privacyObserver.disconnect).toHaveBeenCalledTimes(1)

    const privacy = mountSection('privacy')
    act(() => privacyObserver.trigger())
    expect(privacy.scrollIntoView).not.toHaveBeenCalled()

    const security = mountSection('security')
    act(() => securityObserver.trigger())
    expect(security.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(security.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })

  it('disconnects a pending wait on unmount', () => {
    mockSearchParams = new URLSearchParams('section=alerts')
    const { unmount } = renderHook(() => useActiveSection())
    const observer = latestObserver()

    unmount()

    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)

    const alerts = mountSection('alerts')
    act(() => observer.trigger())
    expect(alerts.scrollIntoView).not.toHaveBeenCalled()
  })

  it('bounds a missing target wait instead of observing indefinitely', () => {
    mockSearchParams = new URLSearchParams('section=account')
    renderHook(() => useActiveSection())
    const observer = latestObserver()

    act(() => {
      jest.advanceTimersByTime(9_999)
    })
    expect(observer.disconnect).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)

    const account = mountSection('account')
    act(() => observer.trigger())
    expect(account.scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not add a duplicate history update for the current section', () => {
    mockSearchParams = new URLSearchParams('section=wallet')
    mountSection('wallet')
    const { result } = renderHook(() => useActiveSection())

    act(() => {
      result.current.scrollToSection('wallet')
    })

    expect(mockReplace).not.toHaveBeenCalled()
  })
})
