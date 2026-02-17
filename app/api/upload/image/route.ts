/**
 * Generic image upload API
 *
 * POST /api/upload/image
 * - multipart/form-data with fields: file, bucket
 * - Requires authentication
 * - Validates type (jpg/png/webp/gif) and size (5MB)
 * - Returns public URL
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import {
  uploadToStorage,
  isAllowedMimeType,
  validateFile,
} from '@/lib/media/upload';
import {
  BUCKETS,
  ALLOWED_EXTENSIONS,
  type BucketName,
} from '@/lib/media/constants';
import logger from '@/lib/logger';
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const VALID_BUCKETS = new Set<string>(Object.values(BUCKETS));

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    // Auth
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const bucketParam = (formData.get('bucket') as string | null) ?? BUCKETS.POSTS;

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!VALID_BUCKETS.has(bucketParam)) {
      return NextResponse.json(
        { error: `Invalid bucket. Must be one of: ${Object.values(BUCKETS).join(', ')}` },
        { status: 400 }
      );
    }
    const bucket = bucketParam as BucketName;

    // Validate MIME
    if (!isAllowedMimeType(file.type)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Allowed: jpg, png, webp, gif' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate size
    const validation = validateFile(buffer, file.type, bucket);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Extension
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
    const safeExt = (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? ext : 'jpg';

    // Optional: attempt sharp resize if available
    let finalBuffer: Buffer<ArrayBuffer> = buffer;
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(buffer).metadata();
      const maxWidth = 1600;
      if (metadata.width && metadata.width > maxWidth) {
        finalBuffer = await sharp(buffer)
          .resize({ width: maxWidth, withoutEnlargement: true })
          .toBuffer() as Buffer<ArrayBuffer>;
      }
    } catch {
      // sharp not installed or failed -- use original buffer
    }

    const result = await uploadToStorage({
      bucket,
      buffer: finalBuffer,
      contentType: file.type,
      extension: safeExt,
      prefix: user.id,
    });

    return NextResponse.json({ url: result.url, path: result.path });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    logger.error('[upload/image]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
