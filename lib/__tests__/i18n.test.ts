import { t, getLanguage, setLanguage, translations, type TranslationKey } from '../i18n'

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
  beforeEach(() => {
    localStorageMock.clear()
    dispatchSpy.mockClear()
  })

  describe('translations object', () => {
    it('has zh translations', () => {
      expect(translations.zh).toBeDefined()
      expect(typeof translations.zh).toBe('object')
    })

    it('has en translations (fallback to zh initially)', () => {
      expect(translations.en).toBeDefined()
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
      // t should return something for any key in the zh dict
      const keys = Object.keys(translations.zh)
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
