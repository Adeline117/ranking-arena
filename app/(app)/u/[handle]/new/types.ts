export interface UploadedImage {
  url: string
  fileName: string
}

export interface UploadedVideo {
  url: string
  fileName: string
  fileSize: number
}

export interface PollOption {
  text: string
  votes: number
}

export const TITLE_MAX_LENGTH = 100
export const CONTENT_MAX_LENGTH = 10000
export const DRAFT_KEY_PREFIX = 'post_draft_'

export const POLL_DURATION_OPTIONS = [
  { labelKey: 'pollDuration1h', value: 1 },
  { labelKey: 'pollDuration6h', value: 6 },
  { labelKey: 'pollDuration12h', value: 12 },
  { labelKey: 'pollDuration1d', value: 24 },
  { labelKey: 'pollDuration3d', value: 72 },
  { labelKey: 'pollDuration7d', value: 168 },
] as const
