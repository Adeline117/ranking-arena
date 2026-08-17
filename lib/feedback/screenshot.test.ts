import {
  MAX_FEEDBACK_SCREENSHOT_DATA_URL_LENGTH,
  encodeFeedbackScreenshot,
  isValidFeedbackScreenshotDataUrl,
} from './screenshot'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9lZsAAAAASUVORK5CYII='
const WEBP_DATA_URL = 'data:image/webp;base64,UklGRgQAAABXRUJQ'

function fileFromDataUrl(dataUrl: string, name: string): File {
  const [header, payload] = dataUrl.split(',')
  const type = header.slice('data:'.length, header.indexOf(';'))
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
  return new File([bytes], name, { type })
}

describe('feedback screenshot contract', () => {
  it('accepts a complete bounded image and preserves it byte-for-byte', async () => {
    expect(isValidFeedbackScreenshotDataUrl(PNG_DATA_URL)).toBe(true)
    await expect(encodeFeedbackScreenshot(fileFromDataUrl(PNG_DATA_URL, 'shot.png'))).resolves.toBe(
      PNG_DATA_URL
    )
  })

  it('rejects truncation, spoofed media, malformed base64, and oversized values', () => {
    expect(isValidFeedbackScreenshotDataUrl(PNG_DATA_URL.slice(0, -4))).toBe(false)
    expect(isValidFeedbackScreenshotDataUrl(PNG_DATA_URL.replace('image/png', 'image/jpeg'))).toBe(
      false
    )
    expect(isValidFeedbackScreenshotDataUrl('data:image/png;base64,%%%%')).toBe(false)
    expect(
      isValidFeedbackScreenshotDataUrl(
        `data:image/png;base64,iVBORw0KGgo${'A'.repeat(MAX_FEEDBACK_SCREENSHOT_DATA_URL_LENGTH)}`
      )
    ).toBe(false)
  })

  it('rejects unsupported and over-limit source files before decoding', async () => {
    await expect(
      encodeFeedbackScreenshot(new File(['svg'], 'shot.svg', { type: 'image/svg+xml' }))
    ).resolves.toBeNull()
    await expect(
      encodeFeedbackScreenshot(
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'shot.png', { type: 'image/png' })
      )
    ).resolves.toBeNull()
  })

  it('resizes a large valid source until the complete encoded image fits the contract', async () => {
    const originalImage = global.Image
    const originalCreateObjectUrl = URL.createObjectURL
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const originalCreateElement = document.createElement.bind(document)
    const fillRect = jest.fn()
    const drawImage = jest.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ fillStyle: '', fillRect, drawImage })),
      toDataURL: jest.fn(() => WEBP_DATA_URL),
    }

    class MockImage {
      naturalWidth = 1200
      naturalHeight = 800
      width = 1200
      height = 800
      onload: ((this: GlobalEventHandlers, event: Event) => unknown) | null = null
      onerror: OnErrorEventHandler = null
      set src(_value: string) {
        queueMicrotask(() =>
          this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load'))
        )
      }
    }

    Object.defineProperty(global, 'Image', { configurable: true, value: MockImage })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:feedback-shot'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    })
    jest
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) =>
        tagName === 'canvas'
          ? canvas
          : originalCreateElement(tagName)) as typeof document.createElement)

    try {
      const bytes = new Uint8Array(40_000)
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      await expect(
        encodeFeedbackScreenshot(new File([bytes], 'large.png', { type: 'image/png' }))
      ).resolves.toBe(WEBP_DATA_URL)
      expect(canvas.width).toBe(960)
      expect(canvas.height).toBe(640)
      expect(fillRect).toHaveBeenCalledWith(0, 0, 960, 640)
      expect(drawImage).toHaveBeenCalledTimes(1)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:feedback-shot')
    } finally {
      jest.restoreAllMocks()
      Object.defineProperty(global, 'Image', { configurable: true, value: originalImage })
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectUrl,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectUrl,
      })
    }
  })
})
