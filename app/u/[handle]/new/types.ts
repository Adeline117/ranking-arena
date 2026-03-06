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

export const POLL_DURATION_OPTIONS_ZH = [
  { label: '1\u5c0f\u65f6', value: 1 },
  { label: '6\u5c0f\u65f6', value: 6 },
  { label: '12\u5c0f\u65f6', value: 12 },
  { label: '1\u5929', value: 24 },
  { label: '3\u5929', value: 72 },
  { label: '7\u5929', value: 168 },
]

export const POLL_DURATION_OPTIONS_EN = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '12 hours', value: 12 },
  { label: '1 day', value: 24 },
  { label: '3 days', value: 72 },
  { label: '7 days', value: 168 },
]
