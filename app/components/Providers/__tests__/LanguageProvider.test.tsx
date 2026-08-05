import { act, render, screen } from '@testing-library/react'
import { LanguageProvider, useLanguage as useAppLanguage } from '../LanguageProvider'
import { loadTranslations, onTranslationsReady, translations } from '@/lib/i18n'
import { useLanguage as useSharedLanguage } from '@/lib/i18n/client'

jest.mock('@/lib/i18n', () => ({
  getLanguage: () => 'en',
  setLanguage: jest.fn(),
  translations: { en: { childLabel: 'Child content' }, zh: {}, ja: {}, ko: {} },
  loadTranslations: jest.fn().mockResolvedValue(undefined),
  getTranslationVersion: () => 0,
  onTranslationsReady: jest.fn(() => jest.fn()),
}))

describe('LanguageProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete translations.en.asyncLabel
  })

  it('mounts when requestIdleCallback is unavailable', () => {
    const original = window.requestIdleCallback
    delete (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback

    try {
      render(
        <LanguageProvider>
          <div>Child content</div>
        </LanguageProvider>
      )

      expect(screen.getByText('Child content')).toBeInTheDocument()
      expect(loadTranslations).toHaveBeenCalledWith('en')
    } finally {
      if (original) window.requestIdleCallback = original
    }
  })

  it('provides the same context instance to lib consumers', () => {
    function SharedConsumer() {
      const appContext = useAppLanguage()
      const sharedContext = useSharedLanguage()
      return (
        <>
          <div data-testid="context-identity">{String(appContext === sharedContext)}</div>
          <div>{sharedContext.t('childLabel')}</div>
        </>
      )
    }

    render(
      <LanguageProvider>
        <SharedConsumer />
      </LanguageProvider>
    )

    expect(screen.getByTestId('context-identity')).toHaveTextContent('true')
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('publishes a fresh translation function when an async dictionary becomes ready', () => {
    function Consumer() {
      return <div>{useAppLanguage().t('asyncLabel')}</div>
    }

    render(
      <LanguageProvider>
        <Consumer />
      </LanguageProvider>
    )

    expect(screen.getByText('asyncLabel')).toBeInTheDocument()
    const listener = jest.mocked(onTranslationsReady).mock.calls[0]?.[0]
    expect(listener).toBeDefined()

    act(() => {
      translations.en.asyncLabel = 'Loaded asynchronously'
      listener?.()
    })

    expect(screen.getByText('Loaded asynchronously')).toBeInTheDocument()
  })
})
