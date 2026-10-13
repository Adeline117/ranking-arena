import { act, render, screen } from '@testing-library/react'
import { LanguageProvider, useLanguage } from '../LanguageProvider'
import { loadTranslations } from '@/lib/i18n'

let savedLanguage = 'en'
let readyListener: ((lang: string) => void) | null = null

jest.mock('@/lib/i18n', () => ({
  getLanguage: () => savedLanguage,
  setLanguage: jest.fn(),
  translations: {
    en: { greeting: 'Hello' },
    zh: { greeting: '你好' },
    ja: { greeting: 'Hello' },
    ko: { greeting: 'Hello' },
  },
  loadTranslations: jest.fn(() => new Promise<void>(() => {})),
  getTranslationVersion: () => 0,
  onTranslationsReady: (cb: (lang: string) => void) => {
    readyListener = cb
    return () => {
      readyListener = null
    }
  },
}))

let renderCount = 0
function Probe() {
  const { t, language } = useLanguage()
  renderCount += 1
  return (
    <span data-testid="probe">
      {language}:{t('greeting')}
    </span>
  )
}

describe('LanguageProvider dictionary loading', () => {
  beforeEach(() => {
    savedLanguage = 'en'
    renderCount = 0
    readyListener = null
    ;(loadTranslations as jest.Mock).mockClear()
  })

  it('does not idle-preload every other language', () => {
    jest.useFakeTimers()
    try {
      render(
        <LanguageProvider>
          <Probe />
        </LanguageProvider>
      )
      act(() => {
        jest.advanceTimersByTime(5_000)
      })
      const loaded = (loadTranslations as jest.Mock).mock.calls.map(([lang]) => lang)
      expect(loaded).toEqual(['en'])
    } finally {
      jest.useRealTimers()
    }
  })

  it('ignores a non-active language finishing its load, but re-renders for English', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    const before = renderCount
    act(() => readyListener?.('ja'))
    expect(renderCount).toBe(before)
    act(() => readyListener?.('en'))
    expect(renderCount).toBeGreaterThan(before)
  })

  it('switches zh users after mount via the sync core, without waiting for the full dictionary', () => {
    savedLanguage = 'zh'
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    // Effects have flushed: zh core is synchronous, no wait for the full dict.
    expect(screen.getByTestId('probe').textContent).toBe('zh:你好')
    expect(loadTranslations).toHaveBeenCalledWith('zh')
  })
})
