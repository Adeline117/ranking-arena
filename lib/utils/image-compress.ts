/**
 * Client-side image compression before upload.
 * Resizes large images to max 1920px and compresses to ~85% quality.
 * GIFs are passed through without compression (animated).
 */

const MAX_DIMENSION = 1920
const QUALITY = 0.85
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export async function compressImage(file: File): Promise<File> {
  // Skip GIFs (may be animated)
  if (file.type === 'image/gif') return file

  // Skip small files (< 500KB) — not worth compressing
  if (file.size < 500 * 1024) return file

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img

      // Skip if already small enough
      if (width <= MAX_DIMENSION && height <= MAX_DIMENSION && file.size <= MAX_FILE_SIZE) {
        resolve(file)
        return
      }

      // Calculate new dimensions maintaining aspect ratio
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height)
        width = Math.round(width * ratio)
        height = Math.round(height * ratio)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(file)
        return
      }

      ctx.drawImage(img, 0, 0, width, height)

      // Output as WebP if supported, else JPEG
      const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            // Compression didn't help — return original
            resolve(file)
            return
          }

          const compressed = new File([blob], file.name, {
            type: outputType,
            lastModified: Date.now(),
          })
          resolve(compressed)
        },
        outputType,
        QUALITY
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file) // Fallback to original on error
    }

    img.src = url
  })
}
