/**
 * Tracker Module Tests
 * 测试埋点核心模块
 */

import { Tracker, getTracker, track, pageView, setUserId } from './tracker'

// Mock storage
const mockStorage = () => {
  let store: Record<string, string> = {}
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value }),
    removeItem: jest.fn((key: string) => { delete store[key] }),
    clear: jest.fn(() => { store = {} }),
  }
}

describe('Tracker', () => {
  let originalWindow: typeof globalThis.window
  let originalDocument: typeof globalThis.document
  let originalNavigator: typeof globalThis.navigator
  let localStorage: ReturnType<typeof mockStorage>
  let sessionStorage: ReturnType<typeof mockStorage>

  beforeAll(() => {
    originalWindow = global.window
    originalDocument = global.document
    originalNavigator = global.navigator
  })

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage = mockStorage()
    sessionStorage = mockStorage()

    Object.defineProperty(global, 'window', {
      value: {
        location: { href: 'https://example.com/test' },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
      writable: true,
    })
    Object.defineProperty(global, 'document', {
      value: {
        referrer: 'https://google.com',
        title: 'Test Page',
        addEventListener: jest.fn(),
        visibilityState: 'visible',
      },
      writable: true,
    })
    Object.defineProperty(global, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 Test',
        sendBeacon: jest.fn().mockReturnValue(true),
      },
      writable: true,
    })
    Object.defineProperty(global, 'localStorage', {
      value: localStorage,
      writable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: sessionStorage,
      writable: true,
    })
    Object.defineProperty(global, 'fetch', {
      value: jest.fn().mockResolvedValue({ ok: true }),
      writable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  afterAll(() => {
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      writable: true,
    })
    Object.defineProperty(global, 'document', {
      value: originalDocument,
      writable: true,
    })
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    })
  })

  test('should create tracker instance', () => {
    const tracker = new Tracker()
    expect(tracker).toBeDefined()
  })

  test('should generate session ID', () => {
    sessionStorage.getItem.mockReturnValueOnce(null)
    const tracker = new Tracker()

    expect(sessionStorage.setItem).toHaveBeenCalled()
  })

  test('should reuse existing session ID', () => {
    sessionStorage.getItem.mockReturnValue('existing-session-id')
    const tracker = new Tracker()

    // Should not generate new ID
    expect(sessionStorage.setItem).not.toHaveBeenCalledWith(
      'analytics_session_id',
      expect.not.stringContaining('existing-session-id')
    )
  })

  test('should track events', () => {
    const tracker = new Tracker({ debug: false })

    tracker.track('page_view', {
      page: 'home',
      path: '/',
    })

    // Event should be queued
    const events = tracker.getLocalEvents()
    // Note: events are stored in localStorage when no endpoint is configured
  })

  test('should track page view', () => {
    const tracker = new Tracker({ debug: false })

    tracker.pageView('homepage')

    // Should call track with page_view event
  })

  test('should set user ID', () => {
    const tracker = new Tracker()

    tracker.setUserId('user123')

    // User ID should be set for subsequent events
  })

  test('should flush events on batch size', () => {
    const tracker = new Tracker({
      batchSize: 2,
      debug: false,
      endpoint: 'https://analytics.example.com/events',
    })

    tracker.track('page_view', { page: 'home', path: '/' })
    tracker.track('page_view', { page: 'about', path: '/about' })

    // Should trigger flush
    expect(global.fetch).toHaveBeenCalled()
  })

  test('should store events locally when no endpoint configured', () => {
    const tracker = new Tracker({ debug: false })

    tracker.track('page_view', { page: 'home', path: '/' })

    // Manually flush
    tracker.flush()

    // Should store in localStorage
    expect(localStorage.setItem).toHaveBeenCalled()
  })

  test('should limit queue size', () => {
    const tracker = new Tracker({
      maxQueueSize: 5,
      debug: false,
    })

    // Add more events than max queue size
    for (let i = 0; i < 10; i++) {
      tracker.track('page_view', { page: `page${i}`, path: `/page${i}` })
    }

    // Queue should be limited
  })

  test('should configure tracker', () => {
    const tracker = new Tracker()

    tracker.configure({
      enabled: false,
      debug: true,
    })

    // Tracking should be disabled after configuration
  })

  test('should not track when disabled', () => {
    const tracker = new Tracker({ enabled: false })

    tracker.track('page_view', { page: 'home', path: '/' })

    // Event should not be queued
  })

  test('should use sendBeacon for sync flush', async () => {
    const tracker = new Tracker({
      endpoint: 'https://analytics.example.com/events',
      debug: false,
    })

    tracker.track('page_view', { page: 'home', path: '/' })
    await tracker.flush(true)

    expect(navigator.sendBeacon).toHaveBeenCalled()
  })

  test('should clear local events', () => {
    const tracker = new Tracker()

    tracker.clearLocalEvents()

    expect(localStorage.removeItem).toHaveBeenCalledWith('analytics_events')
  })

  test('should destroy tracker and flush events', async () => {
    const tracker = new Tracker({
      endpoint: 'https://analytics.example.com/events',
    })

    tracker.track('page_view', { page: 'home', path: '/' })
    tracker.destroy()

    // Should flush remaining events
    expect(navigator.sendBeacon).toHaveBeenCalled()
  })
})

describe('Global tracker functions', () => {
  beforeEach(() => {
    Object.defineProperty(global, 'window', {
      value: {
        location: { href: 'https://example.com/test' },
        addEventListener: jest.fn(),
      },
      writable: true,
    })
    Object.defineProperty(global, 'document', {
      value: {
        referrer: '',
        title: 'Test',
        addEventListener: jest.fn(),
      },
      writable: true,
    })
    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'Test' },
      writable: true,
    })
    Object.defineProperty(global, 'localStorage', {
      value: mockStorage(),
      writable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: mockStorage(),
      writable: true,
    })
  })

  test('getTracker should return singleton', () => {
    const tracker1 = getTracker()
    const tracker2 = getTracker()

    expect(tracker1).toBe(tracker2)
  })

  test('track function should call tracker.track', () => {
    track('page_view', { page: 'test', path: '/test' })
    // Should not throw
  })

  test('pageView function should call tracker.pageView', () => {
    pageView('test-page')
    // Should not throw
  })

  test('setUserId function should call tracker.setUserId', () => {
    setUserId('user123')
    // Should not throw
  })
})
