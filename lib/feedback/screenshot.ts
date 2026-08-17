export const MAX_FEEDBACK_SCREENSHOT_FILE_BYTES = 5 * 1024 * 1024
export const MAX_FEEDBACK_SCREENSHOT_DATA_URL_LENGTH = 50_000

const FEEDBACK_SCREENSHOT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DATA_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/

function hasMatchingImageSignature(type: string, bytes: string): boolean {
  const byte = (index: number) => bytes.charCodeAt(index)
  if (type === 'png') {
    return (
      bytes.length >= 20 &&
      byte(0) === 0x89 &&
      bytes.slice(1, 4) === 'PNG' &&
      byte(4) === 0x0d &&
      byte(5) === 0x0a &&
      byte(6) === 0x1a &&
      byte(7) === 0x0a &&
      bytes.slice(-12) === '\x00\x00\x00\x00IEND\xaeB`\x82'
    )
  }
  if (type === 'jpeg') {
    return (
      bytes.length >= 5 &&
      byte(0) === 0xff &&
      byte(1) === 0xd8 &&
      byte(2) === 0xff &&
      byte(bytes.length - 2) === 0xff &&
      byte(bytes.length - 1) === 0xd9
    )
  }
  if (bytes.length < 12 || bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP') {
    return false
  }
  const declaredSize = byte(4) + byte(5) * 2 ** 8 + byte(6) * 2 ** 16 + byte(7) * 2 ** 24
  return declaredSize + 8 === bytes.length
}

export function isValidFeedbackScreenshotDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_FEEDBACK_SCREENSHOT_DATA_URL_LENGTH) {
    return false
  }
  const match = DATA_URL_PATTERN.exec(value)
  if (!match || match[2].length % 4 !== 0) return false
  try {
    return hasMatchingImageSignature(match[1], atob(match[2]))
  } catch {
    return false
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('invalid image'))
    reader.onerror = () => reject(reader.error || new Error('image read failed'))
    reader.onabort = () => reject(new Error('image read aborted'))
    reader.readAsDataURL(file)
  })
}

function loadLocalImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    const finish = () => URL.revokeObjectURL(objectUrl)
    image.onload = () => {
      finish()
      resolve(image)
    }
    image.onerror = () => {
      finish()
      reject(new Error('image decode failed'))
    }
    image.src = objectUrl
  })
}

const COMPRESSION_ATTEMPTS = [
  { maxDimension: 960, quality: 0.82 },
  { maxDimension: 800, quality: 0.74 },
  { maxDimension: 640, quality: 0.66 },
  { maxDimension: 480, quality: 0.58 },
  { maxDimension: 360, quality: 0.5 },
  { maxDimension: 240, quality: 0.42 },
] as const

function encodeCanvas(canvas: HTMLCanvasElement, quality: number): string | null {
  for (const type of ['image/webp', 'image/jpeg']) {
    const candidate = canvas.toDataURL(type, quality)
    if (isValidFeedbackScreenshotDataUrl(candidate)) return candidate
  }
  return null
}

export async function encodeFeedbackScreenshot(file: File): Promise<string | null> {
  if (
    file.size > MAX_FEEDBACK_SCREENSHOT_FILE_BYTES ||
    !FEEDBACK_SCREENSHOT_MIME_TYPES.has(file.type)
  ) {
    return null
  }

  try {
    const original = await readFileAsDataUrl(file)
    if (isValidFeedbackScreenshotDataUrl(original)) return original

    const image = await loadLocalImage(file)
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    if (sourceWidth <= 0 || sourceHeight <= 0) return null

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return null

    for (const attempt of COMPRESSION_ATTEMPTS) {
      const scale = Math.min(1, attempt.maxDimension / Math.max(sourceWidth, sourceHeight))
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const encoded = encodeCanvas(canvas, attempt.quality)
      if (encoded) return encoded
    }
  } catch {
    return null
  }

  return null
}
