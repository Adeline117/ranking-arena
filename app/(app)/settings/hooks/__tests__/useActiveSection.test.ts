import { act, cleanup, renderHook } from '@testing-library/react'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

import { useActiveMobileSectionVisibility, useActiveSection } from '../useActiveSection'

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
const propertyRestorers: Array<() => void> = []

function overrideProperty(target: object, property: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property)
  Object.defineProperty(target, property, { configurable: true, value })
  propertyRestorers.push(() => {
    if (descriptor) {
      Object.defineProperty(target, property, descriptor)
    } else {
      Reflect.deleteProperty(target, property)
    }
  })
}

function mountSection(id: string, offsetTop = 0) {
  const element = document.createElement('section')
  const scrollIntoView = jest.fn()
  element.id = id
  Object.defineProperty(element, 'offsetTop', {
    configurable: true,
    value: offsetTop,
  })
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

function testRect(left: number, right: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 44,
    width: right - left,
    height: 44,
    toJSON: () => ({}),
  }
}

function createMobileNavFixture(accountRect: DOMRect) {
  const nav = document.createElement('div')
  const profile = document.createElement('button')
  const account = document.createElement('button')
  const accountScrollIntoView = jest.fn()
  const navScrollTo = jest.fn((options: ScrollToOptions) => {
    if (typeof options.left === 'number') nav.scrollLeft = options.left
    if (typeof options.top === 'number') nav.scrollTop = options.top
  })

  profile.dataset.settingsSection = 'profile'
  account.dataset.settingsSection = 'account'
  Object.defineProperty(profile, 'getBoundingClientRect', {
    configurable: true,
    value: () => testRect(24, 100),
  })
  Object.defineProperty(account, 'getBoundingClientRect', {
    configurable: true,
    value: () => accountRect,
  })
  Object.defineProperty(account, 'scrollIntoView', {
    configurable: true,
    value: accountScrollIntoView,
  })
  Object.defineProperties(nav, {
    clientWidth: { configurable: true, value: 272 },
    scrollWidth: { configurable: true, value: 1_107 },
    getBoundingClientRect: { configurable: true, value: () => testRect(24, 296) },
    scrollTo: { configurable: true, value: navScrollTo },
  })
  nav.scrollLeft = 0
  nav.scrollTop = 7
  nav.append(profile, account)
  document.body.appendChild(nav)
  mountedSections.push(nav)

  return { nav, accountScrollIntoView, navScrollTo }
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
    propertyRestorers
      .splice(0)
      .reverse()
      .forEach((restore) => restore())
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

  it('keeps the last section active within the trailing offset region', () => {
    mountSection('privacy', 600)
    const account = mountSection('account', 924)
    overrideProperty(window, 'innerHeight', 800)
    overrideProperty(window, 'scrollY', 700)
    overrideProperty(document.documentElement, 'scrollHeight', 1_600)
    const { result } = renderHook(() => useActiveSection())

    expect(account.element.offsetTop - window.scrollY).toBe(224)
    expect(document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)).toBe(100)

    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })

    expect(result.current.activeSection).toBe('account')
  })

  it('horizontally reveals an offscreen active mobile pill without moving the page', () => {
    overrideProperty(window, 'innerWidth', 320)
    overrideProperty(window, 'scrollY', 500)
    const windowScrollTo = jest.fn()
    overrideProperty(window, 'scrollTo', windowScrollTo)
    const { nav, accountScrollIntoView, navScrollTo } = createMobileNavFixture(
      testRect(1_039.1875, 1_130.703125)
    )
    type VisibilityProps = {
      section: Parameters<typeof useActiveMobileSectionVisibility>[0]
      ready: boolean
    }
    const { result, rerender } = renderHook(
      ({ section, ready }: VisibilityProps) => useActiveMobileSectionVisibility(section, ready),
      { initialProps: { section: 'profile', ready: false } as VisibilityProps }
    )
    Object.defineProperty(result.current, 'current', {
      configurable: true,
      writable: true,
      value: nav,
    })

    rerender({ section: 'profile', ready: true })
    expect(navScrollTo).not.toHaveBeenCalled()

    rerender({ section: 'account', ready: true })

    expect(navScrollTo).toHaveBeenCalledTimes(1)
    expect(navScrollTo).toHaveBeenCalledWith({
      left: 834.703125,
      top: 7,
      behavior: 'auto',
    })
    expect(nav.scrollLeft).toBe(834.703125)
    expect(nav.scrollTop).toBe(7)
    expect(accountScrollIntoView).not.toHaveBeenCalled()
    expect(windowScrollTo).not.toHaveBeenCalled()
    expect(window.scrollY).toBe(500)
  })

  it('preserves a manual mobile-nav position when the active pill is already visible', () => {
    overrideProperty(window, 'innerWidth', 375)
    overrideProperty(window, 'scrollY', 700)
    const windowScrollTo = jest.fn()
    overrideProperty(window, 'scrollTo', windowScrollTo)
    const { nav, accountScrollIntoView, navScrollTo } = createMobileNavFixture(testRect(100, 190))
    nav.scrollLeft = 400
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useActiveMobileSectionVisibility('account', ready),
      { initialProps: { ready: false } }
    )
    Object.defineProperty(result.current, 'current', {
      configurable: true,
      writable: true,
      value: nav,
    })

    rerender({ ready: true })

    expect(navScrollTo).not.toHaveBeenCalled()
    expect(nav.scrollLeft).toBe(400)
    expect(nav.scrollTop).toBe(7)
    expect(accountScrollIntoView).not.toHaveBeenCalled()
    expect(windowScrollTo).not.toHaveBeenCalled()
    expect(window.scrollY).toBe(700)
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
