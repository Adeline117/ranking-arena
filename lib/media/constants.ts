/**
 * Media storage constants
 */

export const BUCKETS = {
  AVATARS: 'avatars',
  POSTS: 'posts',
  LIBRARY: 'library',
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** Max file size per bucket in bytes */
export const MAX_FILE_SIZE: Record<BucketName, number> = {
  [BUCKETS.AVATARS]: 5 * 1024 * 1024,   // 5 MB
  [BUCKETS.POSTS]: 5 * 1024 * 1024,      // 5 MB
  [BUCKETS.LIBRARY]: 5 * 1024 * 1024,    // 5 MB
};

/** Default image dimensions for resize (width) */
export const DEFAULT_RESIZE: Record<BucketName, number> = {
  [BUCKETS.AVATARS]: 400,
  [BUCKETS.POSTS]: 1200,
  [BUCKETS.LIBRARY]: 800,
};

export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const;
