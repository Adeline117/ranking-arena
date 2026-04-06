// ─── Types ───────────────────────────────────────────────────────────

export interface UploadedImage {
  url: string
  fileName: string
}

export interface UploadedVideo {
  url: string
  fileName: string
  fileSize?: number
  thumbnail?: string
}

export interface PollOption {
  text: string
  votes: number
}

export interface LinkPreview {
  url: string
  title: string
  description: string
  image: string
}

// ─── Constants ───────────────────────────────────────────────────────

export const TITLE_MAX_LENGTH = 100
export const CONTENT_MAX_LENGTH = 10000
export const DRAFT_KEY_PREFIX = 'group_post_draft_'
export const MAX_IMAGES = 9
export const MAX_VIDEO_SIZE_MB = 100
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']

export const POLL_DURATION_OPTIONS = [
  { label_zh: '1小时', label_en: '1 hour', value: 1 },
  { label_zh: '6小时', label_en: '6 hours', value: 6 },
  { label_zh: '12小时', label_en: '12 hours', value: 12 },
  { label_zh: '1天', label_en: '1 day', value: 24 },
  { label_zh: '3天', label_en: '3 days', value: 72 },
  { label_zh: '7天', label_en: '7 days', value: 168 },
]
