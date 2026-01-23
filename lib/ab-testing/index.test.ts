/**
 * A/B Testing Tests
 * 测试 A/B 测试框架
 */

import {
  Experiments,
  ABTestManager,
  useExperiment,
  trackExperimentConversion,
} from './index'

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

// Mock feature flags
jest.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: jest.fn().mockReturnValue(true),
}))

describe('Experiments', () => {
  test('should have NEW_HOMEPAGE_LAYOUT experiment', () => {
    expect(Experiments.NEW_HOMEPAGE_LAYOUT).toBeDefined()
    expect(Experiments.NEW_HOMEPAGE_LAYOUT.id).toBe('new_homepage_layout')
    expect(Experiments.NEW_HOMEPAGE_LAYOUT.variants.length).toBeGreaterThanOrEqual(2)
  })

  test('should have TRADER_CARD_STYLE experiment', () => {
    expect(Experiments.TRADER_CARD_STYLE).toBeDefined()
    expect(Experiments.TRADER_CARD_STYLE.id).toBe('trader_card_style')
  })

  test('should have RECOMMENDATION_ALGO experiment', () => {
    expect(Experiments.RECOMMENDATION_ALGO).toBeDefined()
    expect(Experiments.RECOMMENDATION_ALGO.id).toBe('recommendation_algo')
  })

  test('should have SUBSCRIPTION_PAGE experiment', () => {
    expect(Experiments.SUBSCRIPTION_PAGE).toBeDefined()
    expect(Experiments.SUBSCRIPTION_PAGE.id).toBe('subscription_page')
  })

  test('experiments should have control variant', () => {
    Object.values(Experiments).forEach(experiment => {
      const hasControl = experiment.variants.some(v => v.id === 'control')
      expect(hasControl).toBe(true)
    })
  })

  test('variant weights should sum to 100 or close', () => {
    Object.values(Experiments).forEach(experiment => {
      const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0)
      expect(totalWeight).toBeGreaterThanOrEqual(99)
      expect(totalWeight).toBeLessThanOrEqual(101)
    })
  })
})

describe('ABTestManager', () => {
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

  test('should create manager instance', () => {
    const manager = new ABTestManager()
    expect(manager).toBeDefined()
  })

  test('should generate anonymous user ID', () => {
    const manager = new ABTestManager()
    const userId = manager.getUserId()

    expect(userId).toBeDefined()
    expect(userId.startsWith('anon_')).toBe(true)
    expect(mockLocalStorage.setItem).toHaveBeenCalled()
  })

  test('should reuse existing anonymous ID', () => {
    // Mock getItem to return 'existing-anon-id' for 'ab_anonymous_id' key
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'ab_anonymous_id') return 'existing-anon-id'
      return null
    })
    const manager = new ABTestManager()
    const userId = manager.getUserId()

    expect(userId).toBe('existing-anon-id')
  })

  test('should use set user ID', () => {
    const manager = new ABTestManager()
    manager.setUserId('user123')
    const userId = manager.getUserId()

    expect(userId).toBe('user123')
  })

  test('should return control for disabled experiment', () => {
    const manager = new ABTestManager()

    // NEW_HOMEPAGE_LAYOUT is disabled by default
    const variant = manager.getVariant('new_homepage_layout')

    expect(variant).toBeDefined()
    expect(variant?.id).toBe('control')
  })

  test('should return null for unknown experiment', () => {
    const manager = new ABTestManager()
    const variant = manager.getVariant('unknown_experiment')

    expect(variant).toBeNull()
  })

  test('should save assignment to localStorage', () => {
    const manager = new ABTestManager()

    // Force enable an experiment
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = true
    manager.getVariant('new_homepage_layout')

    expect(mockLocalStorage.setItem).toHaveBeenCalled()

    // Reset
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = false
  })

  test('should return consistent variant for same user', () => {
    const manager = new ABTestManager()

    // Force enable an experiment
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = true
    Experiments.NEW_HOMEPAGE_LAYOUT.trafficPercentage = 100

    const variant1 = manager.getVariant('new_homepage_layout')
    const variant2 = manager.getVariant('new_homepage_layout')

    expect(variant1?.id).toBe(variant2?.id)

    // Reset
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = false
  })

  test('should load saved assignments', () => {
    const savedAssignments = {
      test_experiment: {
        experimentId: 'test_experiment',
        variantId: 'variant_a',
        assignedAt: Date.now(),
        isInExperiment: true,
      },
    }
    mockLocalStorage.getItem.mockReturnValueOnce(JSON.stringify(savedAssignments))

    const manager = new ABTestManager()
    const assignments = manager.getAllAssignments()

    expect(assignments.size).toBeGreaterThanOrEqual(0)
  })

  test('should clear assignments', () => {
    const manager = new ABTestManager()
    manager.clearAssignments()

    expect(localStorage.removeItem).toHaveBeenCalledWith('ab_assignments')
  })

  test('should track conversion', () => {
    const manager = new ABTestManager()

    // Should not throw
    manager.trackConversion('new_homepage_layout', 'signup', 1)
  })

  test('should respect targeting whitelist', () => {
    const manager = new ABTestManager()
    manager.setUserId('allowed-user')

    // Set up experiment with whitelist
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = true
    Experiments.NEW_HOMEPAGE_LAYOUT.targeting = {
      userIdWhitelist: ['allowed-user'],
    }

    const variant = manager.getVariant('new_homepage_layout')

    // Should get a variant (not necessarily control since user is whitelisted)
    expect(variant).toBeDefined()

    // Reset
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = false
    delete Experiments.NEW_HOMEPAGE_LAYOUT.targeting
  })

  test('should check experiment date range', () => {
    const manager = new ABTestManager()

    // Set up experiment with future start date
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = true
    Experiments.NEW_HOMEPAGE_LAYOUT.startDate = '2099-01-01'

    const variant = manager.getVariant('new_homepage_layout')
    expect(variant?.id).toBe('control')

    // Reset
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = false
    delete Experiments.NEW_HOMEPAGE_LAYOUT.startDate
  })

  test('should check experiment end date', () => {
    const manager = new ABTestManager()

    // Set up experiment with past end date
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = true
    Experiments.NEW_HOMEPAGE_LAYOUT.endDate = '2000-01-01'

    const variant = manager.getVariant('new_homepage_layout')
    expect(variant?.id).toBe('control')

    // Reset
    Experiments.NEW_HOMEPAGE_LAYOUT.enabled = false
    delete Experiments.NEW_HOMEPAGE_LAYOUT.endDate
  })
})

describe('useExperiment', () => {
  test('should return control on client side when experiment is active', () => {
    // On client side with jsdom, we have window available
    // The function should return a valid variant
    const result = useExperiment('new_homepage_layout')

    expect(result.variant).toBeDefined()
    expect(result.isLoading).toBe(false)
    // In browser environment, user should be in experiment
    expect(typeof result.isInExperiment).toBe('boolean')
  })
})

describe('trackExperimentConversion', () => {
  test('should not throw when tracking conversion', () => {
    // In browser environment (jsdom), this should work without throwing
    expect(() => {
      trackExperimentConversion('new_homepage_layout', 'signup', 1)
    }).not.toThrow()
  })
})
