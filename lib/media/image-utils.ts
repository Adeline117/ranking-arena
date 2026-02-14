/**
 * Image URL utilities
 *
 * Generates transformed image URLs using Supabase Storage image transformation.
 * Docs: https://supabase.com/docs/guides/storage/serving/image-transformations
 */

import { type BucketName } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformOptions {
  width?: number;
  height?: number;
  /** resize mode */
  resize?: 'cover' | 'contain' | 'fill';
  /** output quality 1-100 */
  quality?: number;
  /** output format */
  format?: 'origin' | 'avif' | 'webp';
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

/**
 * Build a Supabase Storage public URL with optional image transformations.
 */
export function getImageUrl(
  bucket: BucketName,
  path: string,
  transform?: TransformOptions
): string {
  if (!SUPABASE_URL) return '';

  const base = `${SUPABASE_URL}/storage/v1`;

  if (!transform) {
    return `${base}/object/public/${bucket}/${path}`;
  }

  const params = new URLSearchParams();
  if (transform.width) params.set('width', String(transform.width));
  if (transform.height) params.set('height', String(transform.height));
  if (transform.resize) params.set('resize', transform.resize);
  if (transform.quality) params.set('quality', String(transform.quality));
  if (transform.format) params.set('format', transform.format);

  return `${base}/render/image/public/${bucket}/${path}?${params.toString()}`;
}

/**
 * Get a thumbnail URL for a stored image.
 */
export function getThumbnailUrl(
  bucket: BucketName,
  path: string,
  size: number = 200
): string {
  return getImageUrl(bucket, path, {
    width: size,
    height: size,
    resize: 'cover',
    quality: 80,
    format: 'webp',
  });
}

/**
 * Get an optimized URL for display (responsive width, webp).
 */
export function getOptimizedUrl(
  bucket: BucketName,
  path: string,
  width: number = 800
): string {
  return getImageUrl(bucket, path, {
    width,
    quality: 85,
    format: 'webp',
  });
}
