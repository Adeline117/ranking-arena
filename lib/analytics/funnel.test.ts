/**
 * Funnel Analytics Tests
 * 测试漏斗分析工具
 */

import {
  Funnels,
  FunnelTracker,
  trackFunnelStep,
} from './funnel'

// Mock localStorage and sessionStorage
const mockStorage = () => {
  let store: Record<string, string> = {}
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value }),
    removeItem: jest.fn((key: string) => { delete store[key] }),
    clear: jest.fn(() => { store = {} }),
  }
}

describe('Funnels', () => {
  test('should have REGISTRATION funnel defined', () => {
    expect(Funnels.REGISTRATION).toBeDefined()
    expect(Funnels.REGISTRATION.id).toBe('registration')
    expect(Funnels.REGISTRATION.steps.length).toBeGreaterThan(0)
  })

  test('should have EXCHANGE_BINDING funnel defined', () => {
    expect(Funnels.EXCHANGE_BINDING).toBeDefined()
    expect(Funnels.EXCHANGE_BINDING.id).toBe('exchange_binding')
  })

  test('should have POST_CREATION funnel defined', () => {
    expect(Funnels.POST_CREATION).toBeDefined()
    expect(Funnels.POST_CREATION.id).toBe('post_creation')
  })

  test('should have SUBSCRIPTION funnel defined', () => {
    expect(Funnels.SUBSCRIPTION).toBeDefined()
    expect(Funnels.SUBSCRIPTION.id).toBe('subscription')
  })

  test('REGISTRATION funnel should have expected steps', () => {
    const steps = Funnels.REGISTRATION.steps
    expect(steps.some(s => s.id === 'landing')).toBe(true)
    expect(steps.some(s => s.id === 'click_login')).toBe(true)
    expect(steps.some(s => s.id === 'auth_complete')).toBe(true)
  })

  test('POST_CREATION funnel should have optional steps', () => {
    const steps = Funnels.POST_CREATION.steps
    const optionalStep = steps.find(s => s.id === 'add_images')
    expect(optionalStep?.required).toBe(false)
  })

  test('funnels should have timeout configured', () => {
    expect(Funnels.REGISTRATION.timeout).toBeDefined()
    expect(Funnels.REGISTRATION.timeout).toBe(30 * 60 * 1000) // 30 minutes
    expect(Funnels.SUBSCRIPTION.timeout).toBe(10 * 60 * 1000) // 10 minutes
  })
})

describe('FunnelTracker', () => {
  let mockLocalStorage: ReturnType<typeof mockStorage>
  let mockSessionStorage: ReturnType<typeof mockStorage>
  let originalLocalStorage: Storage
  let originalSessionStorage: Storage

  beforeEach(() => {
    mockLocalStorage = mockStorage()
    mockSessionStorage = mockStorage()

    // Save original storage
    originalLocalStorage = global.localStorage
    originalSessionStorage = global.sessionStorage

    // Mock storage on global (works in jsdom)
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
  })

  afterEach(() => {
    // Restore original storage
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

  test('should create tracker instance', () => {
    const tracker = new FunnelTracker()
    expect(tracker).toBeDefined()
  })

  test('should start a funnel', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')

    const progress = tracker.getProgress('registration')
    expect(progress).not.toBeNull()
    expect(progress?.funnelId).toBe('registration')
    expect(progress?.isCompleted).toBe(false)
    expect(progress?.isAbandoned).toBe(false)
  })

  test('should track funnel step', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')
    tracker.trackStep('registration', 'click_login')

    const progress = tracker.getProgress('registration')
    expect(progress?.completedSteps).toContain('click_login')
    expect(progress?.currentStep).toBe('click_login')
  })

  test('should not track step for unknown funnel', () => {
    const tracker = new FunnelTracker()
    tracker.trackStep('unknown_funnel', 'some_step')

    const progress = tracker.getProgress('unknown_funnel')
    expect(progress).toBeNull()
  })

  test('should abandon funnel', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')
    tracker.abandonFunnel('registration')

    const progress = tracker.getProgress('registration')
    expect(progress?.isAbandoned).toBe(true)
  })

  test('should calculate conversion rate', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')

    // Complete some steps
    const steps = Funnels.REGISTRATION.steps
    tracker.trackStep('registration', steps[0].id)
    tracker.trackStep('registration', steps[1].id)

    const rate = tracker.getConversionRate('registration')
    expect(rate).toBeGreaterThan(0)
    expect(rate).toBeLessThanOrEqual(100)
  })

  test('should return 0 conversion rate for unknown funnel', () => {
    const tracker = new FunnelTracker()
    const rate = tracker.getConversionRate('unknown')
    expect(rate).toBe(0)
  })

  test('should reset all progress', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')
    tracker.reset()

    const progress = tracker.getProgress('registration')
    expect(progress).toBeNull()
  })

  test('should mark funnel as completed when all required steps done', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')

    // Complete all steps in order
    const steps = Funnels.REGISTRATION.steps
    steps.forEach(step => {
      tracker.trackStep('registration', step.id)
    })

    const progress = tracker.getProgress('registration')
    expect(progress?.isCompleted).toBe(true)
  })

  test('should handle starting new funnel while one is in progress', () => {
    const tracker = new FunnelTracker()
    tracker.startFunnel('registration')
    tracker.trackStep('registration', 'click_login')

    // Start again - should abandon previous
    tracker.startFunnel('registration')

    const progress = tracker.getProgress('registration')
    expect(progress?.completedSteps).not.toContain('click_login')
  })
})

describe('trackFunnelStep', () => {
  test('should not throw when called', () => {
    // In jsdom browser environment, trackFunnelStep should work without throwing
    expect(() => {
      trackFunnelStep('registration', 'landing')
    }).not.toThrow()
  })

  test('should not throw for unknown funnel', () => {
    expect(() => {
      trackFunnelStep('unknown_funnel', 'some_step')
    }).not.toThrow()
  })
})
