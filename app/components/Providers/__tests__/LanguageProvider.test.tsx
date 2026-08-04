import { render, screen } from '@testing-library/react'
import { LanguageProvider, useLanguage as useAppLanguage } from '../LanguageProvider'
import { loadTranslations } from '@/lib/i18n'
import { useLanguage as useSharedLanguage } from '@/lib/i18n/client'

jest.mock('@/lib/i18n', () => ({
  getLanguage: () => 'en',
  setLanguage: jest.fn(),
  translations: { en: { childLabel: 'Child content' }, zh: {}, ja: {}, ko: {} },
  loadTranslations: jest.fn().mockResolvedValue(undefined),
  getTranslationVersion: () => 0,
  onTranslationsReady: () => jest.fn(),
}))

describe('LanguageProvider', () => {
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
})
