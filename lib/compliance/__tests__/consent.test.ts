/**
 * 同意管理测试
 */

import {
  ConsentManager,
} from '../consent'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(global, 'localStorage', { value: localStorageMock })

describe('Consent Management', () => {
  beforeEach(() => {
    localStorage.clear()
    // 重置 ConsentManager 单例（通过清除缓存）
    ;(global as any).consentManagerInstance = null
  })
  
  describe('ConsentManager', () => {
    it('should initialize with default state', () => {
      const manager = new ConsentManager()
      const state = manager.getState()
      
      expect(state.necessary).toBe(true)
      expect(state.analytics).toBe(false)
      expect(state.marketing).toBe(false)
      expect(state.preferences).toBe(false)
      expect(state.timestamp).toBe(0)
    })
    
    it('should report not consented initially', () => {
      const manager = new ConsentManager()
      expect(manager.hasConsented()).toBe(false)
    })
    
    it('should set consent properly', () => {
      const manager = new ConsentManager()
      
      manager.setConsent({
        analytics: true,
        marketing: false,
        preferences: true,
      })
      
      const state = manager.getState()
      expect(state.necessary).toBe(true) // 始终为 true
      expect(state.analytics).toBe(true)
      expect(state.marketing).toBe(false)
      expect(state.preferences).toBe(true)
      expect(state.timestamp).toBeGreaterThan(0)
    })
    
    it('should accept all consent', () => {
      const manager = new ConsentManager()
      manager.acceptAll()
      
      const state = manager.getState()
      expect(state.necessary).toBe(true)
      expect(state.analytics).toBe(true)
      expect(state.marketing).toBe(true)
      expect(state.preferences).toBe(true)
    })
    
    it('should accept necessary only', () => {
      const manager = new ConsentManager()
      
      // 先接受全部
      manager.acceptAll()
      
      // 然后只接受必要
      manager.acceptNecessaryOnly()
      
      const state = manager.getState()
      expect(state.necessary).toBe(true)
      expect(state.analytics).toBe(false)
      expect(state.marketing).toBe(false)
      expect(state.preferences).toBe(false)
    })
    
    it('should revoke consent', () => {
      const manager = new ConsentManager()
      
      manager.acceptAll()
      expect(manager.hasConsented()).toBe(true)
      
      manager.revokeConsent()
      expect(manager.hasConsented()).toBe(false)
    })
    
    it('should persist to localStorage', () => {
      const manager = new ConsentManager()
      manager.acceptAll()
      
      // 检查 localStorage
      const stored = localStorage.getItem('arena_consent')
      expect(stored).not.toBeNull()
      
      const parsed = JSON.parse(stored!)
      expect(parsed.analytics).toBe(true)
    })
    
    it('should load from localStorage', () => {
      // 预设 localStorage
      localStorage.setItem('arena_consent', JSON.stringify({
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true,
        timestamp: Date.now(),
        version: '1.0',
      }))
      
      const manager = new ConsentManager()
      const state = manager.getState()
      
      expect(state.analytics).toBe(true)
      expect(state.marketing).toBe(false)
      expect(state.preferences).toBe(true)
    })
    
    it('should notify listeners on change', () => {
      const manager = new ConsentManager()
      const listener = jest.fn()
      
      manager.subscribe(listener)
      manager.setConsent({ analytics: true })
      
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        analytics: true,
      }))
    })
    
    it('should unsubscribe properly', () => {
      const manager = new ConsentManager()
      const listener = jest.fn()
      
      const unsubscribe = manager.subscribe(listener)
      unsubscribe()
      
      manager.setConsent({ analytics: true })
      
      expect(listener).not.toHaveBeenCalled()
    })
  })
  
  describe('hasConsentFor', () => {
    it('should check specific category', () => {
      const manager = new ConsentManager()
      
      manager.setConsent({ analytics: true, marketing: false })
      
      expect(manager.hasConsentFor('necessary')).toBe(true)
      expect(manager.hasConsentFor('analytics')).toBe(true)
      expect(manager.hasConsentFor('marketing')).toBe(false)
    })
  })
})
