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
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]
export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]

export const POLL_DURATION_OPTIONS = [
  { labelKey: 'pollDuration1h', value: 1 },
  { labelKey: 'pollDuration6h', value: 6 },
  { labelKey: 'pollDuration12h', value: 12 },
  { labelKey: 'pollDuration1d', value: 24 },
  { labelKey: 'pollDuration3d', value: 72 },
  { labelKey: 'pollDuration7d', value: 168 },
] as const
