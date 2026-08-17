import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockEncodeFeedbackScreenshot = jest.fn()
const mockShowToast = jest.fn()

jest.mock('next/navigation', () => ({ usePathname: () => '/hot' }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/features', () => ({
  isFeedbackSuppressedRoute: () => false,
  isFloatingActionRoute: () => false,
}))
jest.mock('@/lib/ui/bottomOverlayCoordinator', () => ({
  announceBottomOverlayOpen: jest.fn(),
  subscribeToBottomOverlayOpen: () => jest.fn(),
}))
jest.mock('@/lib/feedback/screenshot', () => ({
  encodeFeedbackScreenshot: (...args: unknown[]) => mockEncodeFeedbackScreenshot(...args),
}))

import FeedbackWidget from '../FeedbackWidget'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9lZsAAAAASUVORK5CYII='

function openFeedbackWithScreenshot() {
  const rendered = render(<FeedbackWidget />)
  fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
  fireEvent.change(screen.getByPlaceholderText('feedbackPlaceholder'), {
    target: { value: 'The chart is clipped' },
  })
  const file = new File(['screenshot'], 'screenshot.png', { type: 'image/png' })
  const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('feedback screenshot input is missing')
  fireEvent.change(input, { target: { files: [file] } })
  return { ...rendered, file, input }
}

describe('FeedbackWidget screenshot submission', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('submits only the complete encoded screenshot and keeps the picker closed in flight', async () => {
    let finishEncoding!: (value: string | null) => void
    mockEncodeFeedbackScreenshot.mockReturnValue(
      new Promise((resolve) => {
        finishEncoding = resolve
      })
    )
    const { file, input } = openFeedbackWithScreenshot()
    const submit = screen.getByRole('button', { name: 'feedbackSubmit' })

    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(mockEncodeFeedbackScreenshot).toHaveBeenCalledTimes(1)
    expect(mockEncodeFeedbackScreenshot).toHaveBeenCalledWith(file)
    expect(input).toBeDisabled()
    expect(global.fetch).not.toHaveBeenCalled()

    finishEncoding(PNG_DATA_URL)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      message: 'The chart is clipped',
      screenshot: PNG_DATA_URL,
    })
    expect(mockShowToast).toHaveBeenCalledWith('feedbackSuccess', 'success')
  })

  it('reports an unencodable screenshot without sending partial feedback', async () => {
    mockEncodeFeedbackScreenshot.mockResolvedValue(null)
    openFeedbackWithScreenshot()

    fireEvent.click(screen.getByRole('button', { name: 'feedbackSubmit' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('feedbackScreenshotInvalid', 'error')
    )
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'feedbackSubmit' })).toBeEnabled()
  })
})
