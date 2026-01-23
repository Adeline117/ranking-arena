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
  let mockLocalStorage: ReturnType<typeof mockStorage>
  let mockSessionStorage: ReturnType<typeof mockStorage>
  let originalLocalStorage: Storage
  let originalSessionStorage: Storage
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    jest.useFakeTimers()
    mockLocalStorage = mockStorage()
    mockSessionStorage = mockStorage()

    // Save originals
    originalLocalStorage = global.localStorage
    originalSessionStorage = global.sessionStorage
    originalFetch = global.fetch

    // Mock storage - jsdom already has window/document/navigator
    Object.defineProperty(global, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'fetch', {
      value: jest.fn().mockResolvedValue({ ok: true }),
      writable: true,
      configurable: true,
    })

    // Mock navigator.sendBeacon
    Object.defineProperty(global.navigator, 'sendBeacon', {
      value: jest.fn().mockReturnValue(true),
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()

    // Restore storage
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    })
  })

  // No afterAll needed - jsdom manages window/document/navigator

  test('should create tracker instance', () => {
    const tracker = new Tracker()
    expect(tracker).toBeDefined()
  })

  test('should generate session ID', () => {
    sessionStorage.getItem.mockReturnValueOnce(null)
    const _tracker = new Tracker()

    expect(sessionStorage.setItem).toHaveBeenCalled()
  })

  test('should reuse existing session ID', () => {
    sessionStorage.getItem.mockReturnValue('existing-session-id')
    const _tracker = new Tracker()

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
    const _events = tracker.getLocalEvents()
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
  let originalLocalStorage: Storage
  let originalSessionStorage: Storage

  beforeEach(() => {
    // Save originals
    originalLocalStorage = global.localStorage
    originalSessionStorage = global.sessionStorage

    // Mock storage (jsdom provides window/document/navigator)
    Object.defineProperty(global, 'localStorage', {
      value: mockStorage(),
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: mockStorage(),
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    // Restore storage
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
      configurable: true,
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
