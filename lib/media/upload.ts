/**
 * Media upload utilities for Supabase Storage
 */

import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  BUCKETS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type BucketName,
  type AllowedMimeType,
} from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** Target bucket */
  bucket: BucketName;
  /** Raw file bytes */
  buffer: Buffer;
  /** Original MIME type */
  contentType: string;
  /** File extension (without dot) */
  extension: string;
  /** Sub-path prefix, e.g. a userId */
  prefix?: string;
  /** Allow overwrite */
  upsert?: boolean;
}

export interface UploadResult {
  /** Public URL of the uploaded file */
  url: string;
  /** Path within the bucket */
  path: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isAllowedMimeType(mime: string): mime is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

export function validateFile(
  buffer: Buffer,
  contentType: string,
  bucket: BucketName
): { valid: true } | { valid: false; error: string } {
  if (!isAllowedMimeType(contentType)) {
    return { valid: false, error: `Unsupported file type: ${contentType}` };
  }
  const maxSize = MAX_FILE_SIZE[bucket];
  if (buffer.length > maxSize) {
    return {
      valid: false,
      error: `File exceeds ${maxSize / (1024 * 1024)}MB limit`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Supabase admin client (service role)
// ---------------------------------------------------------------------------

function getAdminClient() {
  return getSupabaseAdmin();
}

// ---------------------------------------------------------------------------
// Core upload
// ---------------------------------------------------------------------------

export async function uploadToStorage(opts: UploadOptions): Promise<UploadResult> {
  const { bucket, buffer, contentType, extension, prefix, upsert = false } = opts;

  const validation = validateFile(buffer, contentType, bucket);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const fileName = `${timestamp}-${rand}.${extension}`;
  const filePath = prefix ? `${prefix}/${fileName}` : fileName;

  const supabase = getAdminClient();

  const { error } = await supabase.storage.from(bucket).upload(filePath, buffer, {
    contentType,
    upsert,
  });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(filePath);

  return { url: publicUrl, path: filePath };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export async function uploadAvatar(
  userId: string,
  buffer: Buffer,
  contentType: string,
  extension: string
): Promise<UploadResult> {
  return uploadToStorage({
    bucket: BUCKETS.AVATARS,
    buffer,
    contentType,
    extension,
    prefix: userId,
    upsert: true,
  });
}

export async function uploadPostImage(
  userId: string,
  buffer: Buffer,
  contentType: string,
  extension: string
): Promise<UploadResult> {
  return uploadToStorage({
    bucket: BUCKETS.POSTS,
    buffer,
    contentType,
    extension,
    prefix: userId,
  });
}

export async function uploadLibraryCover(
  itemId: string,
  buffer: Buffer,
  contentType: string,
  extension: string
): Promise<UploadResult> {
  return uploadToStorage({
    bucket: BUCKETS.LIBRARY,
    buffer,
    contentType,
    extension,
    prefix: itemId,
    upsert: true,
  });
}
