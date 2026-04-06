import { t, getLanguage, setLanguage, translations, loadTranslations, type TranslationKey } from '../i18n'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock CustomEvent dispatch
const dispatchSpy = jest.spyOn(window, 'dispatchEvent').mockImplementation(() => true)

describe('i18n', () => {
  beforeAll(async () => {
    // Wait for eager dynamic import of en.ts to resolve
    await loadTranslations('en')
  })

  beforeEach(() => {
    localStorageMock.clear()
    dispatchSpy.mockClear()
  })

  describe('translations object', () => {
    it('has en translations after load', () => {
      expect(translations.en).toBeDefined()
      expect(Object.keys(translations.en).length).toBeGreaterThan(0)
    })

    it('has zh translations (fallback to en initially)', () => {
      expect(translations.zh).toBeDefined()
      expect(typeof translations.zh).toBe('object')
    })
  })

  describe('setLanguage', () => {
    it('saves to localStorage', () => {
      setLanguage('en')
      expect(localStorageMock.getItem('language')).toBe('en')
    })

    it('dispatches languageChange event', () => {
      setLanguage('zh')
      expect(dispatchSpy).toHaveBeenCalled()
    })
  })

  describe('getLanguage', () => {
    it('returns saved language', () => {
      localStorageMock.setItem('language', 'en')
      expect(getLanguage()).toBe('en')
    })
  })

  describe('t function', () => {
    it('returns translation for known key', () => {
      const keys = Object.keys(translations.en)
      if (keys.length > 0) {
        const result = t(keys[0] as TranslationKey)
        expect(typeof result).toBe('string')
        expect(result.length).toBeGreaterThan(0)
      }
    })

    it('returns key itself for unknown key', () => {
      const result = t('nonexistent_key_xyz' as TranslationKey)
      expect(result).toBe('nonexistent_key_xyz')
    })
  })
})
