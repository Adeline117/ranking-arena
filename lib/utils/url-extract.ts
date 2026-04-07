/**
 * Extract URLs from text content for link preview rendering.
 * Filters out image/video URLs (already rendered by content renderer).
 */

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i
const VIDEO_DOMAINS = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|twitter\.com|x\.com)/i

export function extractPreviewUrls(text: string | null | undefined, maxUrls = 3): string[] {
  if (!text) return []
  const matches = text.match(URL_REGEX)
  if (!matches) return []

  return [...new Set(matches)]
    .filter(url => !IMAGE_EXTENSIONS.test(url) && !VIDEO_DOMAINS.test(url))
    .slice(0, maxUrls)
}
