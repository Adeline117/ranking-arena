import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockCreateObjectUrl = jest.fn(() => 'blob:rank-card')
const mockRevokeObjectUrl = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          traderShareBtn: 'Share rank',
          traderSharePanelTitle: 'Share trader',
          traderShareSaveCard: 'Save card',
          quizDownloadFailed: 'Download failed',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    userId: null,
    getAuthHeadersAsync: jest.fn(async () => ({})),
  }),
}))

jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({
    open,
    children,
    label,
  }: {
    open: boolean
    children: React.ReactNode
    label?: string
  }) => (open ? <div aria-label={label}>{children}</div> : null),
}))

import TraderShareActions from '../TraderShareActions'

function renderDownloadButton() {
  render(
    <TraderShareActions
      handle="trader-1"
      displayName="Trader One"
      platform="binance"
      rank={7}
      roi={12.5}
      arenaScore={88}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Share rank' }))
  return screen.getByRole('button', { name: 'Save card' })
}

describe('TraderShareActions rank-card download', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mockCreateObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mockRevokeObjectUrl,
    })
  })

  it('reports a non-2xx image response without downloading its error body', async () => {
    const blob = jest.fn()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, blob })
    const download = renderDownloadButton()

    fireEvent.click(download)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('Download failed', 'error')
    })
    expect(blob).not.toHaveBeenCalled()
    expect(mockCreateObjectUrl).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save card' })).toBeEnabled()
  })

  it('still downloads a successful image response', async () => {
    const imageBlob = new Blob(['png'], { type: 'image/png' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: jest.fn().mockResolvedValue(imageBlob),
    })
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const download = renderDownloadButton()

    fireEvent.click(download)

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    expect(mockCreateObjectUrl).toHaveBeenCalledWith(imageBlob)
    expect(mockRevokeObjectUrl).toHaveBeenCalledWith('blob:rank-card')
    expect(mockShowToast).not.toHaveBeenCalled()

    clickSpy.mockRestore()
  })
})
